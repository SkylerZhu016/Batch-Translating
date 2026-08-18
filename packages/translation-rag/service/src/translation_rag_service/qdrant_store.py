from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from qdrant_client import QdrantClient, models

from .config import Settings
from .embeddings import BgeM3Embedder, EmbeddingBatch
from .schemas import SearchRequest


POINT_NAMESPACE = uuid.UUID("d57cde68-c7a8-51de-80fd-344b67e3c710")


@dataclass(slots=True)
class CollectionFeatures:
    dense: bool = True
    sparse: bool = False
    colbert: bool = False

    def as_dict(self) -> dict[str, bool]:
        return {"dense": self.dense, "sparse": self.sparse, "colbert": self.colbert}


class QdrantStore:
    def __init__(self, settings: Settings, embedder: BgeM3Embedder) -> None:
        self.settings = settings
        self.embedder = embedder
        self.warnings: list[str] = []
        if settings.qdrant_url:
            self.client = QdrantClient(
                url=settings.qdrant_url,
                api_key=settings.qdrant_api_key,
                timeout=settings.qdrant_timeout_seconds,
            )
            self.mode = "remote"
        else:
            settings.qdrant_path.mkdir(parents=True, exist_ok=True)
            self.client = QdrantClient(path=str(settings.qdrant_path))
            self.mode = "local"

    def close(self) -> None:
        close = getattr(self.client, "close", None)
        if callable(close):
            close()

    @staticmethod
    def project_key(project_id: str) -> str:
        return hashlib.sha256(project_id.encode("utf-8")).hexdigest()[:16]

    def alias_name(self, project_id: str, index_name: str) -> str:
        return f"bt_{self.project_key(project_id)}_{index_name}_current"

    def collection_prefix(self, project_id: str, index_name: str) -> str:
        schema = re.sub(r"[^a-zA-Z0-9]+", "_", self.settings.schema_version).strip("_")
        fingerprint = self.embedder.fingerprint[:16]
        return f"bt_{self.project_key(project_id)}_{index_name}__v{schema}_{fingerprint}"

    def staging_name(self, project_id: str, index_name: str) -> str:
        return f"{self.collection_prefix(project_id, index_name)}_{uuid.uuid4().hex[:12]}"

    @staticmethod
    def point_id(project_id: str, book_id: str, index_name: str, record_id: str) -> str:
        logical_key = "\x1f".join((project_id, book_id, index_name, record_id))
        return str(uuid.uuid5(POINT_NAMESPACE, logical_key))

    def active_collection(self, project_id: str, index_name: str) -> str | None:
        alias = self.alias_name(project_id, index_name)
        aliases = self.client.get_aliases().aliases
        for item in aliases:
            if item.alias_name == alias:
                return str(item.collection_name)
        return None

    def needs_rebuild(self, project_id: str, index_name: str) -> bool:
        active = self.active_collection(project_id, index_name)
        return active is None or not active.startswith(self.collection_prefix(project_id, index_name))

    def create_staging(self, project_id: str, index_name: str) -> tuple[str, CollectionFeatures]:
        name = self.staging_name(project_id, index_name)
        status = self.embedder.status
        capabilities = status["capabilities"]
        requested = CollectionFeatures(
            dense=True,
            sparse=bool(capabilities.get("sparse")),
            colbert=bool(capabilities.get("rerank")),
        )
        try:
            self._create_collection(name, requested)
            features = requested
        except Exception as exc:
            if not (requested.sparse or requested.colbert):
                raise
            self.warnings.append(
                f"Qdrant advanced vectors unavailable; collection uses dense fallback: {exc}"
            )
            try:
                self.client.delete_collection(name)
            except Exception:
                pass
            features = CollectionFeatures(dense=True)
            self._create_collection(name, features)
        self._create_payload_indexes(name)
        return name, features

    def _create_collection(self, name: str, features: CollectionFeatures) -> None:
        vector_config: dict[str, models.VectorParams] = {
            "dense": models.VectorParams(
                size=BgeM3Embedder.DENSE_SIZE,
                distance=models.Distance.COSINE,
            )
        }
        if features.colbert:
            vector_config["colbert"] = models.VectorParams(
                size=BgeM3Embedder.DENSE_SIZE,
                distance=models.Distance.COSINE,
                multivector_config=models.MultiVectorConfig(
                    comparator=models.MultiVectorComparator.MAX_SIM
                ),
            )
        sparse_config = None
        if features.sparse:
            sparse_config = {
                "sparse": models.SparseVectorParams(
                    index=models.SparseIndexParams(on_disk=False)
                )
            }
        self.client.create_collection(
            collection_name=name,
            vectors_config=vector_config,
            sparse_vectors_config=sparse_config,
        )

    def _create_payload_indexes(self, collection_name: str) -> None:
        indexes = {
            "project_id": models.PayloadSchemaType.KEYWORD,
            "book_id": models.PayloadSchemaType.KEYWORD,
            "chapter_id": models.PayloadSchemaType.KEYWORD,
            "chapter": models.PayloadSchemaType.INTEGER,
            "memory_type": models.PayloadSchemaType.KEYWORD,
            "entities": models.PayloadSchemaType.KEYWORD,
            "importance": models.PayloadSchemaType.FLOAT,
            "schema_version": models.PayloadSchemaType.KEYWORD,
            "spoiler_policy": models.PayloadSchemaType.KEYWORD,
            "source_hash": models.PayloadSchemaType.KEYWORD,
            "instruction_version": models.PayloadSchemaType.KEYWORD,
            "provenance_id": models.PayloadSchemaType.KEYWORD,
            "source_normalized": models.PayloadSchemaType.KEYWORD,
            "approved": models.PayloadSchemaType.BOOL,
            "final": models.PayloadSchemaType.BOOL,
        }
        for field_name, schema in indexes.items():
            try:
                self.client.create_payload_index(
                    collection_name=collection_name,
                    field_name=field_name,
                    field_schema=schema,
                    wait=True,
                )
            except Exception as exc:
                # Embedded Qdrant can search without payload indexes; surface the downgrade.
                message = f"payload index {field_name} unavailable: {exc}"
                if message not in self.warnings:
                    self.warnings.append(message)

    def upsert(
        self,
        collection_name: str,
        rows: list[dict[str, Any]],
        embeddings: EmbeddingBatch,
        features: CollectionFeatures,
    ) -> None:
        points: list[models.PointStruct] = []
        for index, row in enumerate(rows):
            vectors: dict[str, Any] = {"dense": embeddings.dense[index]}
            if features.sparse and embeddings.sparse is not None:
                sparse = embeddings.sparse[index]
                vectors["sparse"] = models.SparseVector(
                    indices=list(sparse.keys()),
                    values=list(sparse.values()),
                )
            if features.colbert and embeddings.colbert is not None:
                vectors["colbert"] = embeddings.colbert[index]
            points.append(
                models.PointStruct(
                    id=row["point_id"],
                    vector=vectors,
                    payload=row["payload"],
                )
            )
        if points:
            self.client.upsert(collection_name=collection_name, points=points, wait=True)

    def switch_alias(self, project_id: str, index_name: str, collection_name: str) -> None:
        alias = self.alias_name(project_id, index_name)
        existing = self.active_collection(project_id, index_name)
        operations: list[Any] = []
        if existing is not None:
            operations.append(
                models.DeleteAliasOperation(delete_alias=models.DeleteAlias(alias_name=alias))
            )
        operations.append(
            models.CreateAliasOperation(
                create_alias=models.CreateAlias(
                    collection_name=collection_name,
                    alias_name=alias,
                )
            )
        )
        self.client.update_collection_aliases(change_aliases_operations=operations)

    def delete_points(self, project_id: str, book_id: str, index_name: str, ids: list[str]) -> int:
        if not ids:
            return 0
        collection = self.active_collection(project_id, index_name)
        if collection is None:
            return 0
        records = self.client.retrieve(
            collection_name=collection,
            ids=ids,
            with_payload=True,
            with_vectors=False,
        )
        allowed = [
            str(record.id)
            for record in records
            if record.payload
            and record.payload.get("project_id") == project_id
            and record.payload.get("book_id") == book_id
        ]
        if allowed:
            self.client.delete(
                collection_name=collection,
                points_selector=models.PointIdsList(points=allowed),
                wait=True,
            )
        return len(allowed)

    def filter_for(self, request: SearchRequest) -> models.Filter:
        must: list[Any] = [
            models.FieldCondition(
                key="project_id", match=models.MatchValue(value=request.project_id)
            ),
            models.FieldCondition(key="book_id", match=models.MatchValue(value=request.book_id)),
        ]
        if request.chapter_id:
            must.append(
                models.FieldCondition(
                    key="chapter_id", match=models.MatchValue(value=request.chapter_id)
                )
            )
        if request.max_chapter is not None:
            must.append(
                models.FieldCondition(
                    key="chapter", range=models.Range(lte=float(request.max_chapter))
                )
            )
        mappings = (
            ("source_hash", request.filters.source_hashes),
            (
                "instruction_version",
                [str(value) for value in request.filters.instruction_versions],
            ),
            ("provenance_id", request.filters.provenance_ids),
            ("entities", request.filters.entities),
            ("memory_type", request.filters.memory_types),
        )
        for field_name, values in mappings:
            if values:
                must.append(
                    models.FieldCondition(key=field_name, match=models.MatchAny(any=list(values)))
                )
        must_not: list[Any] = []
        if request.spoiler_policy in {"historical", "no_future", "safe"}:
            must_not.append(
                models.FieldCondition(
                    key="spoiler_policy",
                    match=models.MatchAny(
                        any=["retrospective_constraint", "review_only", "future"]
                    ),
                )
            )
        elif request.spoiler_policy in {"retrospective_constraint", "allow_retrospective"}:
            must_not.append(
                models.FieldCondition(
                    key="spoiler_policy",
                    match=models.MatchAny(any=["review_only", "future"]),
                )
            )
        return models.Filter(must=must, must_not=must_not)

    def search(
        self,
        project_id: str,
        index_name: str,
        request: SearchRequest,
        query: EmbeddingBatch,
        limit: int,
        features: CollectionFeatures,
    ) -> list[list[tuple[str, float, dict[str, Any]]]]:
        collection = self.active_collection(project_id, index_name)
        if collection is None:
            return []
        query_filter = self.filter_for(request)
        rankings: list[list[tuple[str, float, dict[str, Any]]]] = []
        rankings.append(
            self._query(collection, query.dense[0], "dense", query_filter, limit)
        )
        if features.sparse and request.use_sparse and query.sparse:
            sparse = query.sparse[0]
            rankings.append(
                self._query(
                    collection,
                    models.SparseVector(
                        indices=list(sparse.keys()), values=list(sparse.values())
                    ),
                    "sparse",
                    query_filter,
                    limit,
                )
            )
        if features.colbert and request.use_colbert and query.colbert:
            rankings.append(
                self._query(collection, query.colbert[0], "colbert", query_filter, limit)
            )
        return rankings

    def _query(
        self,
        collection: str,
        vector: Any,
        vector_name: str,
        query_filter: models.Filter,
        limit: int,
    ) -> list[tuple[str, float, dict[str, Any]]]:
        response = self.client.query_points(
            collection_name=collection,
            query=vector,
            using=vector_name,
            query_filter=query_filter,
            limit=limit,
            with_payload=True,
            with_vectors=False,
        )
        return [
            (str(point.id), float(point.score), dict(point.payload or {}))
            for point in response.points
        ]

    def count(self, project_id: str, book_id: str, index_name: str) -> int:
        collection = self.active_collection(project_id, index_name)
        if collection is None:
            return 0
        result = self.client.count(
            collection_name=collection,
            count_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="project_id", match=models.MatchValue(value=project_id)
                    ),
                    models.FieldCondition(
                        key="book_id", match=models.MatchValue(value=book_id)
                    ),
                ]
            ),
            exact=True,
        )
        return int(result.count)

    def cleanup_old_collections(self, project_id: str, index_name: str) -> None:
        active = self.active_collection(project_id, index_name)
        prefix = f"bt_{self.project_key(project_id)}_{index_name}__v"
        names = sorted(
            (
                item.name
                for item in self.client.get_collections().collections
                if item.name.startswith(prefix) and item.name != active
            ),
            reverse=True,
        )
        for name in names[self.settings.retain_old_collections :]:
            try:
                self.client.delete_collection(collection_name=name)
            except Exception as exc:
                self.warnings.append(f"old collection cleanup failed for {name}: {exc}")

    def create_snapshot(self, collection_name: str) -> dict[str, Any] | None:
        try:
            result = self.client.create_snapshot(collection_name=collection_name, wait=True)
            return {
                "name": getattr(result, "name", None),
                "checksum": getattr(result, "checksum", None),
                "size": getattr(result, "size", None),
            }
        except Exception as exc:
            self.warnings.append(f"native Qdrant snapshot unavailable; canonical export retained: {exc}")
            return None
