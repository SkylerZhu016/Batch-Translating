from __future__ import annotations

from typing import Any, Callable

from .canonical import CanonicalStore
from .embeddings import BgeM3Embedder
from .qdrant_store import CollectionFeatures, QdrantStore
from .rerank import apply_domain_boosts, deduplicate, normalize_text, reciprocal_rank_fusion
from .schemas import IndexKind, SearchHit, SearchRequest, SearchResponse


class RetrievalEngine:
    def __init__(
        self,
        canonical: CanonicalStore,
        embedder: BgeM3Embedder,
        qdrant: QdrantStore,
        ensure_index: Callable[[str, str, str], CollectionFeatures],
    ) -> None:
        self.canonical = canonical
        self.embedder = embedder
        self.qdrant = qdrant
        self.ensure_index = ensure_index

    def search(self, index: IndexKind, request: SearchRequest) -> SearchResponse:
        features = self.ensure_index(request.project_id, request.book_id, index.value)
        candidate_limit = min(
            400,
            max(request.top_k, request.top_k * self.embedder.settings.dense_top_k_multiplier),
        )
        exact = self._exact_tm(request) if index is IndexKind.TRANSLATION_MEMORY else []
        query = self.embedder.encode([request.query], advanced=True)
        rankings = self.qdrant.search(
            request.project_id,
            index.value,
            request,
            query,
            candidate_limit,
            features,
        )
        fused = reciprocal_rank_fusion(rankings)
        boosted = apply_domain_boosts(
            fused,
            request.query,
            request.filters.entities,
        )
        ranked = deduplicate([*exact, *boosted])
        budget = request.evidence_budget_chars or self.embedder.settings.evidence_budget_chars
        hits: list[SearchHit] = []
        used = 0
        for point_id, score, payload, _reasons in ranked:
            text = str(payload.get("text_content") or payload.get("text") or "")
            if hits and used + len(text) > budget:
                continue
            hits.append(self._hit(index, point_id, score, text, payload))
            used += len(text)
            if len(hits) >= request.top_k:
                break
        consumed = [hit.id for hit in hits]
        self.canonical.log_retrieval(
            request.project_id,
            request.book_id,
            index.value,
            consumed,
            request.model_dump(mode="json"),
        )
        capabilities = self._active_capabilities(features)
        warnings = list(
            dict.fromkeys([*self.embedder.status.get("warnings", []), *self.qdrant.warnings])
        )
        return SearchResponse(
            hits=hits,
            capabilities=capabilities,
            degraded=not (features.sparse and features.colbert) or bool(warnings),
            consumed_memory_ids=consumed,
            warnings=warnings,
        )

    def _exact_tm(
        self, request: SearchRequest
    ) -> list[tuple[str, float, dict[str, Any], list[str]]]:
        normalized = normalize_text(request.query)
        output: list[tuple[str, float, dict[str, Any], list[str]]] = []
        for row in self.canonical.list_records(
            request.project_id,
            IndexKind.TRANSLATION_MEMORY.value,
            book_id=request.book_id,
        ):
            payload = row["payload"]
            if (
                payload.get("source_normalized") == normalized
                and (payload.get("approved") is True or payload.get("final") is True)
                and self._matches_request_filters(payload, request)
            ):
                output.append((row["point_id"], 10.0, payload, ["exact"]))
        return output

    @staticmethod
    def _matches_request_filters(payload: dict[str, Any], request: SearchRequest) -> bool:
        filters = request.filters
        if request.chapter_id and payload.get("chapter_id") != request.chapter_id:
            return False
        chapter = payload.get("chapter")
        if request.max_chapter is not None and (
            not isinstance(chapter, (int, float)) or chapter > request.max_chapter
        ):
            return False
        if filters.source_hashes and payload.get("source_hash") not in filters.source_hashes:
            return False
        if filters.instruction_versions and str(payload.get("instruction_version")) not in {
            str(value) for value in filters.instruction_versions
        }:
            return False
        if filters.provenance_ids and payload.get("provenance_id") not in filters.provenance_ids:
            return False
        if filters.memory_types and payload.get("memory_type") not in filters.memory_types:
            return False
        if filters.entities and not set(map(str, payload.get("entities") or [])).intersection(
            filters.entities
        ):
            return False
        spoiler = str(payload.get("spoiler_policy") or "historical")
        if request.spoiler_policy in {"historical", "no_future", "safe"} and spoiler in {
            "retrospective_constraint",
            "review_only",
            "future",
        }:
            return False
        if request.spoiler_policy in {
            "retrospective_constraint",
            "allow_retrospective",
        } and spoiler in {"review_only", "future"}:
            return False
        return True

    @staticmethod
    def _hit(
        index: IndexKind,
        point_id: str,
        score: float,
        text: str,
        payload: dict[str, Any],
    ) -> SearchHit:
        instruction_version = payload.get("instruction_version")
        if isinstance(instruction_version, str) and instruction_version.isdigit():
            instruction_version = int(instruction_version)
        return SearchHit(
            id=str(payload.get("record_id") or payload.get("memory_id") or point_id),
            score=float(score),
            text=text,
            index=index,
            chapter_id=payload.get("chapter_id"),
            paragraph_ids=list(payload.get("paragraph_ids") or []),
            memory_type=payload.get("memory_type"),
            entities=list(payload.get("entities") or []),
            importance=payload.get("importance"),
            spoiler_policy=payload.get("spoiler_policy"),
            source_hash=payload.get("source_hash"),
            instruction_version=instruction_version,
            provenance_id=payload.get("provenance_id"),
            target_text=payload.get("target_text") or payload.get("target"),
            metadata=dict(payload.get("metadata") or {}),
        )

    def _active_capabilities(self, features: CollectionFeatures) -> dict[str, Any]:
        embedding = self.embedder.status["capabilities"]
        sparse = bool(embedding.get("sparse")) and features.sparse
        colbert = bool(embedding.get("rerank")) and features.colbert
        return {
            "dense": bool(embedding.get("dense")) and features.dense,
            "sparse": sparse,
            "hybrid": bool(embedding.get("dense")) and sparse,
            "rerank": colbert,
            "active_mode": "hybrid" if sparse else "dense",
        }
