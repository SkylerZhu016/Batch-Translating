from __future__ import annotations

import math
import unicodedata
from collections.abc import Iterable
from typing import Any


def normalize_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def reciprocal_rank_fusion(
    rankings: Iterable[list[tuple[str, float, dict[str, Any]]]],
    *,
    constant: int = 60,
) -> list[tuple[str, float, dict[str, Any], list[str]]]:
    scores: dict[str, float] = {}
    payloads: dict[str, dict[str, Any]] = {}
    reasons: dict[str, list[str]] = {}
    for ranking_number, ranking in enumerate(rankings):
        label = ("dense", "sparse", "colbert")[min(ranking_number, 2)]
        for rank, (point_id, _raw_score, payload) in enumerate(ranking, start=1):
            scores[point_id] = scores.get(point_id, 0.0) + 1.0 / (constant + rank)
            payloads[point_id] = payload
            reasons.setdefault(point_id, []).append(label)
    return sorted(
        (
            (point_id, score, payloads[point_id], reasons[point_id])
            for point_id, score in scores.items()
        ),
        key=lambda item: (-item[1], item[0]),
    )


def apply_domain_boosts(
    fused: list[tuple[str, float, dict[str, Any], list[str]]],
    query: str,
    requested_entities: list[str],
) -> list[tuple[str, float, dict[str, Any], list[str]]]:
    normalized_query = normalize_text(query)
    entity_needles = {normalize_text(entity) for entity in requested_entities if entity.strip()}
    result: list[tuple[str, float, dict[str, Any], list[str]]] = []
    for point_id, score, payload, reasons in fused:
        boosted = score
        item_reasons = list(reasons)
        importance = float(payload.get("importance", 0.5) or 0.0)
        boosted *= 1.0 + min(max(importance, 0.0), 1.0) * 0.15
        entities = {
            normalize_text(str(entity)) for entity in payload.get("entities", []) if str(entity)
        }
        if entity_needles and entities.intersection(entity_needles):
            boosted *= 1.2
            item_reasons.append("entity_filter")
        elif any(entity and entity in normalized_query for entity in entities):
            boosted *= 1.1
            item_reasons.append("entity_query")
        confidence = float(payload.get("confidence", 1.0) or 0.0)
        boosted *= 0.8 + min(max(confidence, 0.0), 1.0) * 0.2
        if not math.isfinite(boosted):
            boosted = 0.0
        result.append((point_id, boosted, payload, item_reasons))
    return sorted(result, key=lambda item: (-item[1], item[0]))


def deduplicate(
    ranked: list[tuple[str, float, dict[str, Any], list[str]]],
) -> list[tuple[str, float, dict[str, Any], list[str]]]:
    seen: set[str] = set()
    output: list[tuple[str, float, dict[str, Any], list[str]]] = []
    for item in ranked:
        payload = item[2]
        identity = str(payload.get("memory_id") or payload.get("record_id") or item[0])
        if identity in seen:
            continue
        seen.add(identity)
        output.append(item)
    return output

