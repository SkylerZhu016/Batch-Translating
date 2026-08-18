from __future__ import annotations

import hashlib
import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from .config import Settings


@dataclass(slots=True)
class ModelDescriptor:
    model_id: str
    directory: str
    revision: str
    fingerprint: str
    files: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class EmbeddingBatch:
    dense: list[list[float]]
    sparse: list[dict[int, float]] | None = None
    colbert: list[list[list[float]]] | None = None


def _candidate_cache_roots() -> list[Path]:
    roots: list[Path] = []
    for env_name in ("HUGGINGFACE_HUB_CACHE", "HF_HUB_CACHE", "TRANSFORMERS_CACHE"):
        value = os.getenv(env_name)
        if value:
            roots.append(Path(value).expanduser())
    hf_home = os.getenv("HF_HOME")
    if hf_home:
        roots.append(Path(hf_home).expanduser() / "hub")
    roots.append(Path.home() / ".cache" / "huggingface" / "hub")
    seen: set[str] = set()
    result: list[Path] = []
    for root in roots:
        key = str(root.resolve()) if root.exists() else str(root)
        if key not in seen:
            seen.add(key)
            result.append(root)
    return result


def _cached_snapshot(model_id: str) -> Path | None:
    repository_dir = "models--" + model_id.replace("/", "--")
    candidates: list[Path] = []
    for root in _candidate_cache_roots():
        model_root = root / repository_dir
        reference = model_root / "refs" / "main"
        if reference.is_file():
            revision = reference.read_text(encoding="utf-8").strip()
            snapshot = model_root / "snapshots" / revision
            if snapshot.is_dir():
                return snapshot.resolve()
        snapshots = model_root / "snapshots"
        if snapshots.is_dir():
            candidates.extend(path for path in snapshots.iterdir() if path.is_dir())
    if not candidates:
        return None
    return max(candidates, key=lambda item: item.stat().st_mtime_ns).resolve()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _fingerprint_model(
    model_id: str,
    directory: Path,
    cache_path: Path,
) -> ModelDescriptor:
    managed_manifest = directory / ".batch-translating-bge-m3.json"
    if managed_manifest.is_file():
        try:
            managed = json.loads(managed_manifest.read_text(encoding="utf-8"))
            managed_files = managed.get("files")
            root = directory.resolve()
            if (
                managed.get("format_version") == 1
                and isinstance(managed_files, list)
                and isinstance(managed.get("fingerprint"), str)
                and len(managed["fingerprint"]) == 64
            ):
                for file_info in managed_files:
                    relative = str(file_info["path"])
                    candidate = (root / relative).resolve()
                    candidate.relative_to(root)
                    if candidate.stat().st_size != int(file_info["size"]):
                        raise ValueError(f"managed model file size changed: {relative}")
                    if len(str(file_info["sha256"])) != 64:
                        raise ValueError(f"invalid managed model digest: {relative}")
                return ModelDescriptor(
                    model_id=str(managed.get("model_id") or model_id),
                    directory=str(root),
                    revision=str(managed.get("revision") or "local"),
                    fingerprint=str(managed["fingerprint"]),
                    files=list(managed_files),
                )
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            # Fall through to a full hash; an invalid manifest is never trusted.
            pass
    patterns = (
        "*.json",
        "*.txt",
        "*.model",
        "*.py",
        "*.pt",
        "*.safetensors",
        "*.bin",
    )
    paths: dict[str, Path] = {}
    for pattern in patterns:
        for path in directory.rglob(pattern):
            if path.is_file():
                paths[path.relative_to(directory).as_posix()] = path
    signature = {
        relative: [path.stat().st_size, path.stat().st_mtime_ns]
        for relative, path in sorted(paths.items())
    }
    cache: dict[str, Any] = {}
    if cache_path.is_file():
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cache = {}
    key = hashlib.sha256(
        (str(directory.resolve()) + json.dumps(signature, sort_keys=True)).encode("utf-8")
    ).hexdigest()
    entry = cache.get(key)
    if isinstance(entry, dict) and isinstance(entry.get("files"), list):
        files = entry["files"]
    else:
        files = [
            {
                "path": relative,
                "size": path.stat().st_size,
                "sha256": _hash_file(path.resolve()),
            }
            for relative, path in sorted(paths.items())
        ]
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache_path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({key: {"files": files}}, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        os.replace(temporary, cache_path)
    revision = directory.name if directory.parent.name == "snapshots" else os.getenv(
        "BGE_M3_REVISION", "local"
    )
    aggregate = hashlib.sha256()
    aggregate.update(f"model:{model_id}\nrevision:{revision}\n".encode("utf-8"))
    for file_info in files:
        aggregate.update(str(file_info["path"]).encode("utf-8"))
        aggregate.update(str(file_info["size"]).encode("ascii"))
        aggregate.update(str(file_info["sha256"]).encode("ascii"))
    return ModelDescriptor(
        model_id=model_id,
        directory=str(directory),
        revision=revision,
        fingerprint=aggregate.hexdigest(),
        files=files,
    )


class BgeM3Embedder:
    """Real FlagEmbedding BGE-M3 inference with explicit capability degradation."""

    DENSE_SIZE = 1024

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model: Any | None = None
        self._lock = threading.RLock()
        self._descriptor: ModelDescriptor | None = None
        self._state = "starting"
        self._device = "cpu"
        self._warnings: list[str] = []
        self._dense = False
        self._sparse = False
        self._colbert = False

    def initialize(self) -> None:
        with self._lock:
            if self._model is not None or self._state == "unavailable":
                return
            try:
                reference, local_directory = self._discover_model()
            except Exception as exc:
                self._state = "unavailable"
                self._warnings.append(f"BGE-M3 discovery failed: {exc}")
                return
            if local_directory is None:
                self._state = "unavailable"
                self._warnings.append(
                    "BAAI/bge-m3 was not found locally; use the explicit Settings download"
                )
                if self.settings.allow_model_download:
                    self._warnings.append(
                        "automatic service-start download is disabled; explicit downloads provide progress and cancellation"
                    )
                return
            preferred = self._preferred_device()
            try:
                self._load(reference, preferred)
            except Exception as first_error:
                if preferred != "cpu":
                    self._warnings.append(
                        f"{preferred} model load failed; using CPU fallback: {first_error}"
                    )
                    try:
                        self._load(reference, "cpu")
                    except Exception as cpu_error:
                        self._state = "unavailable"
                        self._warnings.append(f"BGE-M3 CPU load failed: {cpu_error}")
                        return
                else:
                    self._state = "unavailable"
                    self._warnings.append(f"BGE-M3 load failed: {first_error}")
                    return

            resolved = local_directory or _cached_snapshot(self.settings.model_id)
            if resolved is None and Path(reference).is_dir():
                resolved = Path(reference).resolve()
            if resolved is not None:
                try:
                    self._descriptor = _fingerprint_model(
                        self.settings.model_id,
                        resolved,
                        self.settings.data_dir / "model-fingerprints.json",
                    )
                except Exception as exc:
                    self._warnings.append(f"model fingerprinting failed: {exc}")
                    self._state = "unavailable"
                    return
            else:
                self._warnings.append("model loaded but its local snapshot could not be fingerprinted")
                self._state = "unavailable"
                return

            self._probe_capabilities()
            if not self._dense:
                self._state = "unavailable"
                self._warnings.append("BGE-M3 dense embeddings are unavailable")
            elif self._sparse and self._colbert:
                self._state = "ready"
            else:
                self._state = "degraded"
                missing = ", ".join(
                    name
                    for name, available in (("sparse", self._sparse), ("ColBERT", self._colbert))
                    if not available
                )
                self._warnings.append(f"advanced BGE-M3 mode unavailable ({missing}); dense fallback active")

    def _discover_model(self) -> tuple[str, Path | None]:
        if self.settings.model_path is not None:
            if not self.settings.model_path.is_dir():
                raise RuntimeError(f"configured BGE-M3 path does not exist: {self.settings.model_path}")
            return str(self.settings.model_path), self.settings.model_path
        cached = _cached_snapshot(self.settings.model_id)
        if cached is not None:
            return str(cached), cached
        return self.settings.model_id, None

    def _preferred_device(self) -> str:
        requested = self.settings.preferred_device
        if requested != "auto":
            return requested
        try:
            import torch

            if torch.cuda.is_available():
                return "cuda"
            mps = getattr(torch.backends, "mps", None)
            if mps is not None and mps.is_available():
                return "mps"
        except Exception:
            pass
        return "cpu"

    def _load(self, reference: str, device: str) -> None:
        from FlagEmbedding import BGEM3FlagModel

        kwargs: dict[str, Any] = {"use_fp16": device == "cuda"}
        try:
            self._model = BGEM3FlagModel(reference, devices=device, **kwargs)
        except TypeError:
            self._model = BGEM3FlagModel(reference, device=device, **kwargs)
        self._device = device

    def _probe_capabilities(self) -> None:
        try:
            result = self._encode_raw(["Batch Translating capability probe"], advanced=True)
            dense = result.get("dense_vecs")
            self._dense = dense is not None and len(dense) == 1
            sparse = result.get("lexical_weights")
            colbert = result.get("colbert_vecs")
            self._sparse = sparse is not None and len(sparse) == 1
            self._colbert = colbert is not None and len(colbert) == 1
        except Exception as advanced_error:
            self._warnings.append(f"BGE-M3 advanced capability probe failed: {advanced_error}")
            try:
                result = self._encode_raw(["Batch Translating dense probe"], advanced=False)
                dense = result.get("dense_vecs")
                self._dense = dense is not None and len(dense) == 1
            except Exception as dense_error:
                self._warnings.append(f"BGE-M3 dense capability probe failed: {dense_error}")
                self._dense = False

    def _encode_raw(self, texts: Sequence[str], *, advanced: bool) -> dict[str, Any]:
        if self._model is None:
            raise RuntimeError("BGE-M3 is not loaded")
        return self._model.encode(
            list(texts),
            batch_size=self.settings.embedding_batch_size,
            max_length=self.settings.embedding_max_length,
            return_dense=True,
            return_sparse=advanced,
            return_colbert_vecs=advanced,
        )

    def encode(self, texts: Sequence[str], *, advanced: bool = True) -> EmbeddingBatch:
        if not texts:
            return EmbeddingBatch(dense=[])
        self.initialize()
        if not self._dense or self._model is None:
            raise RuntimeError("BGE-M3 dense embeddings are unavailable")
        with self._lock:
            use_advanced = advanced and (self._sparse or self._colbert)
            try:
                result = self._encode_raw(texts, advanced=use_advanced)
            except Exception as exc:
                if not use_advanced:
                    raise
                self._warnings.append(f"advanced embedding failed; request used dense fallback: {exc}")
                result = self._encode_raw(texts, advanced=False)
                use_advanced = False
        dense_array = np.asarray(result["dense_vecs"], dtype=np.float32)
        dense = dense_array.tolist()
        sparse_result: list[dict[int, float]] | None = None
        if use_advanced and result.get("lexical_weights") is not None:
            sparse_result = [
                {int(key): float(value) for key, value in weights.items()}
                for weights in result["lexical_weights"]
            ]
        colbert_result: list[list[list[float]]] | None = None
        if use_advanced and result.get("colbert_vecs") is not None:
            colbert_result = [
                np.asarray(vectors, dtype=np.float32).tolist()
                for vectors in result["colbert_vecs"]
            ]
        return EmbeddingBatch(dense=dense, sparse=sparse_result, colbert=colbert_result)

    @property
    def fingerprint(self) -> str:
        return self._descriptor.fingerprint if self._descriptor else "unavailable"

    @property
    def status(self) -> dict[str, Any]:
        descriptor = self._descriptor
        capabilities = {
            "dense": self._dense,
            "sparse": self._sparse,
            "hybrid": self._dense and self._sparse,
            "rerank": self._colbert,
            "active_mode": "hybrid" if self._dense and self._sparse else "dense",
        }
        return {
            "status": self._state,
            "model": (
                {
                    "model_id": descriptor.model_id,
                    "revision": descriptor.revision,
                    "fingerprint": descriptor.fingerprint,
                    "device": self._device,
                    "embedding_batch_size": self.settings.embedding_batch_size,
                }
                if descriptor
                else None
            ),
            "capabilities": capabilities,
            "degraded": self._state != "ready",
            "warnings": list(dict.fromkeys(self._warnings)),
        }
