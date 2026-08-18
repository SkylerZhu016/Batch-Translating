from __future__ import annotations

from typing import Any

SERVICE_VERSION = "0.1.0"


def health_payload(embedding_status: dict[str, Any], store_warnings: list[str]) -> dict[str, Any]:
    warnings = list(dict.fromkeys([*embedding_status.get("warnings", []), *store_warnings]))
    state = str(embedding_status.get("status", "unavailable"))
    degraded = state != "ready" or bool(warnings)
    if state == "ready" and degraded:
        state = "degraded"
    return {
        "status": state,
        "service_version": SERVICE_VERSION,
        "model": embedding_status.get("model"),
        "capabilities": embedding_status.get(
            "capabilities",
            {
                "dense": False,
                "sparse": False,
                "hybrid": False,
                "rerank": False,
                "active_mode": "dense",
            },
        ),
        "degraded": degraded,
        "warnings": warnings,
    }
