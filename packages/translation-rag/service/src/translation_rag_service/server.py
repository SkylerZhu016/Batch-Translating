from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import socket
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .canonical import CanonicalStore
from .config import Settings
from .embeddings import BgeM3Embedder
from .health import health_payload
from .qdrant_store import CollectionFeatures, QdrantStore
from .rerank import normalize_text
from .retrieval import RetrievalEngine
from .schemas import (
    IndexKind,
    MemoryDeleteRequest,
    MemoryUpsertRequest,
    RebuildRequest,
    SearchRequest,
    SearchResponse,
    SnapshotRequest,
    VerifyRequest,
)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


class RagRuntime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.bound_port = settings.port
        self.embedder = BgeM3Embedder(settings)
        self.canonical = CanonicalStore(settings.data_dir / "rag-canonical.sqlite3")
        self.qdrant = QdrantStore(settings, self.embedder)
        self._locks: dict[tuple[str, str], threading.RLock] = {}
        self._locks_guard = threading.Lock()
        self.retrieval = RetrievalEngine(
            self.canonical,
            self.embedder,
            self.qdrant,
            self.ensure_index,
        )

    @property
    def url(self) -> str:
        display_host = f"[{self.settings.host}]" if ":" in self.settings.host else self.settings.host
        return f"http://{display_host}:{self.bound_port}"

    def close(self) -> None:
        self.qdrant.close()
        self.canonical.close()

    def _lock_for(self, project_id: str, index_name: str) -> threading.RLock:
        key = (project_id, index_name)
        with self._locks_guard:
            return self._locks.setdefault(key, threading.RLock())

    def _require_dense(self) -> None:
        self.embedder.initialize()
        if not self.embedder.status["capabilities"].get("dense"):
            raise RuntimeError("BGE-M3 dense embeddings are unavailable")

    def ensure_index(self, project_id: str, book_id: str, index_name: str) -> CollectionFeatures:
        self._require_dense()
        with self._lock_for(project_id, index_name):
            if self.qdrant.needs_rebuild(project_id, index_name):
                self.rebuild_one(project_id, book_id, index_name)
            generation = self.canonical.generation(project_id, index_name)
            capabilities = (generation or {}).get("capabilities", {})
            return CollectionFeatures(
                dense=True,
                sparse=bool(capabilities.get("sparse")),
                colbert=bool(capabilities.get("colbert")),
            )

    def prepare_rows(self, request: MemoryUpsertRequest) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for record in request.records:
            raw = record.model_dump(mode="json")
            content_identity = json.dumps(raw, ensure_ascii=False, sort_keys=True)
            record_id = record.logical_id or hashlib.sha256(content_identity.encode("utf-8")).hexdigest()
            source = record.source or record.text or record.summary or ""
            target = record.target or record.target_text
            if request.index is IndexKind.TRANSLATION_MEMORY:
                text_content = f"{source}\n{target or ''}"
            else:
                text_content = record.text or record.summary or source
            provenance_id = record.provenance_id
            if not provenance_id:
                candidate = record.source_provenance.get("id")
                provenance_id = str(candidate) if candidate is not None else None
            spoiler_policy = record.spoiler_policy
            if spoiler_policy == "safe":
                spoiler_policy = "historical"
            payload: dict[str, Any] = {
                **raw,
                "project_id": request.project_id,
                "book_id": request.book_id,
                "index": request.index.value,
                "record_id": record_id,
                "memory_id": record.memory_id or record_id,
                "memory_type": record.memory_type or record.type,
                "text_content": text_content,
                "target_text": target,
                "provenance_id": provenance_id,
                "spoiler_policy": spoiler_policy,
                "schema_version": record.schema_version or self.settings.schema_version,
            }
            if record.instruction_version is not None:
                payload["instruction_version"] = str(record.instruction_version)
            if request.index is IndexKind.TRANSLATION_MEMORY:
                approval = record.approval or ("final" if record.final else "approved")
                payload.update(
                    {
                        "source": source,
                        "target": target,
                        "source_normalized": normalize_text(source),
                        "approval": approval,
                        "approved": approval in {"approved", "final"},
                        "final": approval == "final",
                    }
                )
            point_id = self.qdrant.point_id(
                request.project_id,
                request.book_id,
                request.index.value,
                record_id,
            )
            rows.append(
                {
                    "project_id": request.project_id,
                    "book_id": request.book_id,
                    "index_name": request.index.value,
                    "record_id": record_id,
                    "point_id": point_id,
                    "text_content": text_content,
                    "payload": payload,
                }
            )
        return rows

    def upsert(self, request: MemoryUpsertRequest) -> dict[str, Any]:
        with self._lock_for(request.project_id, request.index.value):
            rows = self.prepare_rows(request)
            self.canonical.upsert_records(rows)
            features = self.ensure_index(request.project_id, request.book_id, request.index.value)
            collection = self.qdrant.active_collection(request.project_id, request.index.value)
            if collection is None:
                raise RuntimeError("index alias was not activated")
            embeddings = self.embedder.encode(
                [row["text_content"] for row in rows],
                advanced=features.sparse or features.colbert,
            )
            self.qdrant.upsert(collection, rows, embeddings, features)
        return {
            "project_id": request.project_id,
            "book_id": request.book_id,
            "index": request.index.value,
            "affected": len(rows),
            "point_ids": [row["point_id"] for row in rows],
        }

    def delete(self, request: MemoryDeleteRequest) -> dict[str, Any]:
        with self._lock_for(request.project_id, request.index.value):
            record_ids = list(request.ids)
            if request.provenance_ids:
                for row in self.canonical.list_records(
                    request.project_id,
                    request.index.value,
                    book_id=request.book_id,
                ):
                    if row["payload"].get("provenance_id") in request.provenance_ids:
                        record_ids.append(row["record_id"])
            record_ids = list(dict.fromkeys(record_ids))
            selected = {
                row["record_id"]: row["point_id"]
                for row in self.canonical.list_records(
                    request.project_id,
                    request.index.value,
                    book_id=request.book_id,
                )
                if row["record_id"] in record_ids
            }
            point_ids = list(selected.values())
            affected = self.qdrant.delete_points(
                request.project_id,
                request.book_id,
                request.index.value,
                point_ids,
            )
            # The canonical row is removed only after the derived index delete;
            # a failure therefore remains safely recoverable by retry/rebuild.
            self.canonical.delete_records(
                request.project_id,
                request.book_id,
                request.index.value,
                list(selected.keys()),
            )
        return {
            "project_id": request.project_id,
            "book_id": request.book_id,
            "index": request.index.value,
            "affected": max(affected, len(point_ids)),
            "point_ids": point_ids,
        }

    def rebuild_one(self, project_id: str, book_id: str, index_name: str) -> dict[str, Any]:
        self._require_dense()
        with self._lock_for(project_id, index_name):
            rows = self.canonical.list_records(project_id, index_name)
            staging, features = self.qdrant.create_staging(project_id, index_name)
            batch_size = self.settings.embedding_batch_size
            try:
                for offset in range(0, len(rows), batch_size):
                    batch = rows[offset : offset + batch_size]
                    embeddings = self.embedder.encode(
                        [row["text_content"] for row in batch],
                        advanced=features.sparse or features.colbert,
                    )
                    self.qdrant.upsert(staging, batch, embeddings, features)
                count = int(
                    self.qdrant.client.count(collection_name=staging, exact=True).count
                )
                if count != len(rows):
                    raise RuntimeError(
                        f"staging point count mismatch: expected {len(rows)}, found {count}"
                    )
                self.qdrant.switch_alias(project_id, index_name, staging)
            except Exception:
                try:
                    self.qdrant.client.delete_collection(collection_name=staging)
                except Exception:
                    pass
                raise
            self.canonical.set_generation(
                project_id,
                index_name,
                staging,
                self.settings.schema_version,
                self.embedder.fingerprint,
                features.as_dict(),
                len(rows),
            )
            self.qdrant.cleanup_old_collections(project_id, index_name)
            return self.index_info(project_id, book_id, index_name)

    def index_info(self, project_id: str, book_id: str, index_name: str) -> dict[str, Any]:
        active = self.qdrant.active_collection(project_id, index_name)
        point_count = self.qdrant.count(project_id, book_id, index_name) if active else 0
        try:
            schema_version = int(self.settings.schema_version)
        except ValueError:
            schema_version = 1
        return {
            "index": index_name,
            "collection": active or "",
            "alias": self.qdrant.alias_name(project_id, index_name),
            "schema_version": schema_version,
            "point_count": point_count,
            "model_fingerprint": self.embedder.fingerprint,
            "ready": bool(active) and not self.qdrant.needs_rebuild(project_id, index_name),
        }

    def status(self, project_id: str, book_id: str) -> dict[str, Any]:
        embedding = self.embedder.status
        indexes = [self.index_info(project_id, book_id, item.value) for item in IndexKind]
        warnings = list(dict.fromkeys([*embedding["warnings"], *self.qdrant.warnings]))
        return {
            "project_id": project_id,
            "book_id": book_id,
            "indexes": indexes,
            "capabilities": embedding["capabilities"],
            "degraded": embedding["degraded"] or bool(warnings),
            "warnings": warnings,
        }

    def verify(self, request: VerifyRequest) -> dict[str, Any]:
        status_payload = self.status(request.project_id, request.book_id)
        errors: list[str] = []
        warnings = list(status_payload.get("warnings", []))
        if not status_payload["capabilities"].get("dense"):
            errors.append("dense embeddings unavailable")
        for index_info in status_payload["indexes"]:
            expected = self.canonical.count(
                request.project_id,
                request.book_id,
                index_info["index"],
            )
            if index_info["point_count"] != expected:
                errors.append(
                    f"{index_info['index']} count mismatch: canonical={expected}, qdrant={index_info['point_count']}"
                )
            if expected and not index_info["ready"]:
                errors.append(f"{index_info['index']} requires rebuild")
        if request.query and not errors:
            probe = SearchRequest(
                project_id=request.project_id,
                book_id=request.book_id,
                query=request.query,
                top_k=1,
                spoiler_policy="review_only",
            )
            self.retrieval.search(IndexKind.STORY_MEMORY, probe)
        return {
            "ok": not errors,
            "project_id": request.project_id,
            "book_id": request.book_id,
            "model": self.embedder.status.get("model"),
            "indexes": status_payload["indexes"],
            "capabilities": status_payload["capabilities"],
            "degraded": status_payload["degraded"],
            "errors": errors,
            "warnings": warnings,
        }

    def rebuild(self, request: RebuildRequest) -> dict[str, Any]:
        if request.schema_version is not None:
            try:
                configured_schema = int(self.settings.schema_version)
            except ValueError:
                configured_schema = -1
            if request.schema_version != configured_schema:
                raise ValueError(
                    "requested schema_version differs from the running service; restart "
                    "with BATCH_TRANSLATING_RAG_SCHEMA_VERSION before rebuilding"
                )
        rebuild_id = str(uuid.uuid4())
        indexes = [
            self.rebuild_one(request.project_id, request.book_id, index.value)
            for index in request.indexes
        ]
        return {
            "project_id": request.project_id,
            "book_id": request.book_id,
            "status": "completed",
            "rebuild_id": rebuild_id,
            "indexes": indexes,
        }

    def snapshot(self, request: SnapshotRequest) -> dict[str, Any]:
        snapshot_id = str(uuid.uuid4())
        base = (
            Path(request.destination).expanduser().resolve()
            if request.destination
            else self.settings.data_dir / "snapshots"
        )
        directory = base / f"{_safe_name(request.project_id)}_{_safe_name(request.book_id)}_{snapshot_id}"
        directory.mkdir(parents=True, exist_ok=False)
        export_path = directory / "canonical.jsonl"
        record_count = self.canonical.export_scope(
            request.project_id,
            request.book_id,
            export_path,
        )
        qdrant_snapshots: dict[str, Any] = {}
        for index in IndexKind:
            active = self.qdrant.active_collection(request.project_id, index.value)
            if active:
                qdrant_snapshots[index.value] = self.qdrant.create_snapshot(active)
        created_at = _utc_now()
        manifest = {
            "snapshot_id": snapshot_id,
            "project_id": request.project_id,
            "book_id": request.book_id,
            "created_at": created_at,
            "model": self.embedder.status.get("model"),
            "schema_version": self.settings.schema_version,
            "canonical_record_count": record_count,
            "qdrant_snapshots": qdrant_snapshots,
        }
        manifest_path = directory / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        digest = hashlib.sha256()
        for path in (export_path, manifest_path):
            with path.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    digest.update(chunk)
        return {
            "project_id": request.project_id,
            "book_id": request.book_id,
            "snapshot_id": snapshot_id,
            "path": str(directory),
            "created_at": created_at,
            "sha256": digest.hexdigest(),
        }


def _safe_name(value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]
    readable = "".join(character if character.isalnum() else "_" for character in value)[:40]
    return f"{readable}_{digest}"


security = HTTPBearer(auto_error=False)


def create_app(settings: Settings | None = None) -> FastAPI:
    runtime = RagRuntime(settings or Settings.from_env())

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        runtime.settings.write_generated_token_file()
        if runtime.settings.eager_model_load:
            await asyncio.to_thread(runtime.embedder.initialize)
        ready = {
            "url": runtime.url,
            "instance_id": runtime.settings.instance_id,
            "pid": os.getpid(),
            "capabilities": runtime.embedder.status["capabilities"],
        }
        print("BATCH_TRANSLATION_RAG_READY " + json.dumps(ready, separators=(",", ":")), flush=True)
        try:
            yield
        finally:
            runtime.close()
            runtime.settings.remove_generated_token_file()

    application = FastAPI(
        title="Batch Translating RAG",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    application.state.runtime = runtime

    def authorize(
        credentials: HTTPAuthorizationCredentials | None = Depends(security),
    ) -> None:
        if (
            credentials is None
            or credentials.scheme.lower() != "bearer"
            or not secrets.compare_digest(credentials.credentials, runtime.settings.bearer_token)
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid bearer token",
                headers={"WWW-Authenticate": "Bearer"},
            )

    @application.get("/health", dependencies=[Depends(authorize)])
    async def health() -> dict[str, Any]:
        return health_payload(runtime.embedder.status, runtime.qdrant.warnings)

    @application.get("/index/status", dependencies=[Depends(authorize)])
    async def index_status(
        project_id: str = Query(min_length=1, max_length=512),
        book_id: str = Query(min_length=1, max_length=512),
    ) -> dict[str, Any]:
        return await asyncio.to_thread(runtime.status, project_id, book_id)

    @application.post("/memory/upsert", dependencies=[Depends(authorize)])
    async def memory_upsert(request: MemoryUpsertRequest) -> dict[str, Any]:
        return await _run(runtime.upsert, request)

    @application.post("/memory/delete", dependencies=[Depends(authorize)])
    async def memory_delete(request: MemoryDeleteRequest) -> dict[str, Any]:
        return await _run(runtime.delete, request)

    async def search(index: IndexKind, request: SearchRequest) -> SearchResponse:
        return await _run(runtime.retrieval.search, index, request)

    @application.post("/story/search", dependencies=[Depends(authorize)])
    async def story_search(request: SearchRequest) -> SearchResponse:
        return await search(IndexKind.STORY_MEMORY, request)

    @application.post("/tm/search", dependencies=[Depends(authorize)])
    async def tm_search(request: SearchRequest) -> SearchResponse:
        return await search(IndexKind.TRANSLATION_MEMORY, request)

    @application.post("/source/search", dependencies=[Depends(authorize)])
    async def source_search(request: SearchRequest) -> SearchResponse:
        return await search(IndexKind.SOURCE_PARAGRAPH, request)

    @application.post("/verify", dependencies=[Depends(authorize)])
    async def verify(request: VerifyRequest) -> dict[str, Any]:
        return await _run(runtime.verify, request)

    @application.post("/index/rebuild", dependencies=[Depends(authorize)])
    async def rebuild(request: RebuildRequest) -> dict[str, Any]:
        return await _run(runtime.rebuild, request)

    @application.post("/snapshot", dependencies=[Depends(authorize)])
    async def snapshot(request: SnapshotRequest) -> dict[str, Any]:
        return await _run(runtime.snapshot, request)

    return application


async def _run(function: Any, *args: Any) -> Any:
    try:
        return await asyncio.to_thread(function, *args)
    except HTTPException:
        raise
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


_lazy_application: FastAPI | None = None


async def app(scope: Any, receive: Any, send: Any) -> None:
    """Lazy ASGI compatibility entry without touching user storage on module import."""
    global _lazy_application
    if _lazy_application is None:
        _lazy_application = create_app()
    await _lazy_application(scope, receive, send)


def main() -> None:
    application = create_app()
    runtime: RagRuntime = application.state.runtime
    family = socket.AF_INET6 if ":" in runtime.settings.host else socket.AF_INET
    listener = socket.socket(family, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((runtime.settings.host, runtime.settings.port))
    listener.listen(2048)
    listener.set_inheritable(True)
    runtime.bound_port = int(listener.getsockname()[1])
    config = uvicorn.Config(
        application,
        host=runtime.settings.host,
        port=runtime.bound_port,
        log_level=os.getenv("BATCH_TRANSLATING_RAG_LOG_LEVEL", "warning"),
        access_log=False,
        server_header=False,
    )
    server = uvicorn.Server(config)
    server.run(sockets=[listener])


if __name__ == "__main__":
    main()
