"""Batch Translating's local retrieval service."""

from typing import Any

__all__ = ["create_app"]


def create_app(*args: Any, **kwargs: Any) -> Any:
    # Keep package import side-effect free so `python -m translation_rag_service.server`
    # opens the embedded Qdrant database exactly once.
    from .server import create_app as factory

    return factory(*args, **kwargs)
