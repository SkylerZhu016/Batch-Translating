from __future__ import annotations

import ipaddress
import os
import secrets
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = int(raw)
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


def _loopback_host(raw: str) -> str:
    host = raw.strip().lower()
    if host == "localhost":
        return "127.0.0.1"
    try:
        if ipaddress.ip_address(host).is_loopback:
            return host
    except ValueError as exc:
        raise ValueError("RAG service host must be a literal loopback address") from exc
    raise ValueError("RAG service refuses to listen on a non-loopback address")


def _default_data_dir() -> Path:
    configured = os.getenv("BATCH_TRANSLATING_RAG_DATA_ROOT") or os.getenv(
        "BATCH_TRANSLATING_RAG_DATA_DIR"
    )
    if configured:
        return Path(configured).expanduser().resolve()
    local = os.getenv("LOCALAPPDATA")
    if local:
        return (Path(local) / "Batch Translating" / "rag").resolve()
    return (Path.home() / ".batch-translating" / "rag").resolve()


@dataclass(frozen=True, slots=True)
class Settings:
    host: str
    port: int
    instance_id: str
    bearer_token: str
    token_was_generated: bool
    token_file: Path
    data_dir: Path
    qdrant_path: Path
    qdrant_url: str | None
    qdrant_api_key: str | None
    qdrant_timeout_seconds: int
    model_id: str
    model_path: Path | None
    allow_model_download: bool
    embedding_batch_size: int
    embedding_max_length: int
    preferred_device: str
    eager_model_load: bool
    schema_version: str
    dense_top_k_multiplier: int
    evidence_budget_chars: int
    retain_old_collections: int

    @classmethod
    def from_env(cls) -> "Settings":
        data_dir = _default_data_dir()
        data_dir.mkdir(parents=True, exist_ok=True)
        host = _loopback_host(os.getenv("BATCH_TRANSLATING_RAG_HOST", "127.0.0.1"))
        port = _int_env("BATCH_TRANSLATING_RAG_PORT", 17349, minimum=0)
        if port > 65535:
            raise ValueError("BATCH_TRANSLATING_RAG_PORT must be <= 65535")

        supplied_token = os.getenv("BATCH_TRANSLATING_RAG_TOKEN", "").strip()
        token_was_generated = not supplied_token
        token = supplied_token or secrets.token_urlsafe(48)
        if len(token) < 32:
            raise ValueError("BATCH_TRANSLATING_RAG_TOKEN must contain at least 32 characters")

        raw_model_path = (
            os.getenv("BGE_M3_MODEL_PATH")
            or os.getenv("BGE_M3_PATH")
            or os.getenv("BATCH_TRANSLATING_BGE_M3_PATH")
        )
        qdrant_url = os.getenv("BATCH_TRANSLATING_QDRANT_URL", "").strip() or None
        token_file = Path(
            os.getenv("BATCH_TRANSLATING_RAG_TOKEN_FILE", str(data_dir / "instance.token"))
        ).expanduser().resolve()

        settings = cls(
            host=host,
            port=port,
            instance_id=os.getenv("BATCH_TRANSLATING_RAG_INSTANCE_ID", "").strip()
            or str(uuid.uuid4()),
            bearer_token=token,
            token_was_generated=token_was_generated,
            token_file=token_file,
            data_dir=data_dir,
            qdrant_path=Path(
                os.getenv("BATCH_TRANSLATING_QDRANT_PATH", str(data_dir / "qdrant"))
            ).expanduser().resolve(),
            qdrant_url=qdrant_url,
            qdrant_api_key=os.getenv("BATCH_TRANSLATING_QDRANT_API_KEY") or None,
            qdrant_timeout_seconds=_int_env("BATCH_TRANSLATING_QDRANT_TIMEOUT", 60),
            model_id=os.getenv("BGE_M3_MODEL", "BAAI/bge-m3").strip() or "BAAI/bge-m3",
            model_path=Path(raw_model_path).expanduser().resolve() if raw_model_path else None,
            allow_model_download=_bool_env("BATCH_TRANSLATING_BGE_ALLOW_DOWNLOAD", False),
            embedding_batch_size=_int_env(
                "BATCH_TRANSLATING_RAG_EMBEDDING_BATCH_SIZE",
                _int_env("BATCH_TRANSLATING_EMBEDDING_BATCH", 8),
            ),
            embedding_max_length=_int_env("BATCH_TRANSLATING_EMBEDDING_MAX_LENGTH", 8192),
            preferred_device=(
                os.getenv("BATCH_TRANSLATING_RAG_DEVICE")
                or os.getenv("BATCH_TRANSLATING_BGE_DEVICE")
                or "auto"
            ).strip().lower(),
            eager_model_load=_bool_env("BATCH_TRANSLATING_RAG_EAGER_LOAD", True),
            schema_version=os.getenv("BATCH_TRANSLATING_RAG_SCHEMA_VERSION", "1").strip() or "1",
            dense_top_k_multiplier=_int_env("BATCH_TRANSLATING_RAG_CANDIDATE_MULTIPLIER", 4),
            evidence_budget_chars=_int_env("BATCH_TRANSLATING_RAG_EVIDENCE_BUDGET", 12000),
            retain_old_collections=_int_env(
                "BATCH_TRANSLATING_RAG_RETAIN_COLLECTIONS", 2, minimum=0
            ),
        )
        settings.qdrant_path.mkdir(parents=True, exist_ok=True)
        return settings

    @property
    def url(self) -> str:
        display_host = f"[{self.host}]" if ":" in self.host else self.host
        return f"http://{display_host}:{self.port}"

    def write_generated_token_file(self) -> None:
        """Write only service-generated tokens; launcher-owned tokens stay in memory."""
        if not self.token_was_generated:
            return
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        descriptor = os.open(self.token_file, flags, stat.S_IRUSR | stat.S_IWUSR)
        try:
            os.write(descriptor, self.bearer_token.encode("utf-8"))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        try:
            os.chmod(self.token_file, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            # Windows ACLs are inherited from the user-owned application data directory.
            pass

    def remove_generated_token_file(self) -> None:
        if not self.token_was_generated:
            return
        try:
            self.token_file.unlink(missing_ok=True)
        except OSError:
            pass
