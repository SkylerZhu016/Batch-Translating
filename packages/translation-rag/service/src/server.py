"""Compatibility entry point for `uvicorn server:app` during local development."""

from translation_rag_service.server import app, main

__all__ = ["app", "main"]

if __name__ == "__main__":
    main()

