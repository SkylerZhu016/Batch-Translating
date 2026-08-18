from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

from .migrations import CANONICAL_TABLES, migrate


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class CanonicalStore:
    """Deterministic, durable source of truth from which Qdrant is rebuilt."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        migrate(self._connection)

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def upsert_records(self, records: Iterable[dict[str, Any]]) -> int:
        rows = list(records)
        now = utc_now()
        with self._lock, self._connection:
            for row in rows:
                self._connection.execute(
                    """
                    INSERT INTO rag_records(
                        project_id, book_id, index_name, record_id, point_id,
                        text_content, payload_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, book_id, index_name, record_id) DO UPDATE SET
                        point_id=excluded.point_id,
                        text_content=excluded.text_content,
                        payload_json=excluded.payload_json,
                        updated_at=excluded.updated_at
                    """,
                    (
                        row["project_id"],
                        row["book_id"],
                        row["index_name"],
                        row["record_id"],
                        row["point_id"],
                        row["text_content"],
                        json.dumps(row["payload"], ensure_ascii=False, sort_keys=True),
                        now,
                        now,
                    ),
                )
                canonical_type = self._canonical_table(row["payload"])
                if canonical_type:
                    payload = row["payload"]
                    display_name = (
                        payload.get("name")
                        or payload.get("target")
                        or payload.get("summary")
                        or payload.get("text")
                    )
                    self._connection.execute(
                        f"""
                        INSERT INTO {canonical_type}(
                            project_id, book_id, canonical_id, chapter_id,
                            display_name, data_json, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(project_id, book_id, canonical_id) DO UPDATE SET
                            chapter_id=excluded.chapter_id,
                            display_name=excluded.display_name,
                            data_json=excluded.data_json,
                            updated_at=excluded.updated_at
                        """,
                        (
                            row["project_id"],
                            row["book_id"],
                            row["record_id"],
                            payload.get("chapter_id"),
                            str(display_name)[:2000] if display_name else None,
                            json.dumps(payload, ensure_ascii=False, sort_keys=True),
                            now,
                        ),
                    )
        return len(rows)

    def delete_records(
        self,
        project_id: str,
        book_id: str,
        index_name: str,
        record_ids: list[str],
    ) -> list[str]:
        if not record_ids:
            return []
        placeholders = ",".join("?" for _ in record_ids)
        with self._lock, self._connection:
            rows = self._connection.execute(
                f"""
                SELECT record_id, point_id, payload_json
                FROM rag_records
                WHERE project_id=? AND book_id=? AND index_name=?
                  AND record_id IN ({placeholders})
                """,
                (project_id, book_id, index_name, *record_ids),
            ).fetchall()
            self._connection.execute(
                f"""
                DELETE FROM rag_records
                WHERE project_id=? AND book_id=? AND index_name=?
                  AND record_id IN ({placeholders})
                """,
                (project_id, book_id, index_name, *record_ids),
            )
            for row in rows:
                payload = json.loads(row["payload_json"])
                table = self._canonical_table(payload)
                if table:
                    self._connection.execute(
                        f"""
                        DELETE FROM {table}
                        WHERE project_id=? AND book_id=? AND canonical_id=?
                        """,
                        (project_id, book_id, row["record_id"]),
                    )
        return [str(row["point_id"]) for row in rows]

    def list_records(
        self,
        project_id: str,
        index_name: str,
        *,
        book_id: str | None = None,
    ) -> list[dict[str, Any]]:
        sql = """
            SELECT project_id, book_id, index_name, record_id, point_id,
                   text_content, payload_json
            FROM rag_records
            WHERE project_id=? AND index_name=?
        """
        params: list[Any] = [project_id, index_name]
        if book_id is not None:
            sql += " AND book_id=?"
            params.append(book_id)
        sql += " ORDER BY book_id, record_id"
        with self._lock:
            rows = self._connection.execute(sql, params).fetchall()
        return [
            {
                "project_id": row["project_id"],
                "book_id": row["book_id"],
                "index_name": row["index_name"],
                "record_id": row["record_id"],
                "point_id": row["point_id"],
                "text_content": row["text_content"],
                "payload": json.loads(row["payload_json"]),
            }
            for row in rows
        ]

    def scopes(self) -> list[tuple[str, str]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT DISTINCT project_id, book_id FROM rag_records ORDER BY 1, 2"
            ).fetchall()
        return [(str(row[0]), str(row[1])) for row in rows]

    def count(self, project_id: str, book_id: str, index_name: str) -> int:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT COUNT(*) FROM rag_records
                WHERE project_id=? AND book_id=? AND index_name=?
                """,
                (project_id, book_id, index_name),
            ).fetchone()
        return int(row[0])

    def set_generation(
        self,
        project_id: str,
        index_name: str,
        collection_name: str,
        schema_version: str,
        model_fingerprint: str,
        capabilities: dict[str, Any],
        point_count: int,
    ) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO index_generations(
                    project_id, index_name, collection_name, schema_version,
                    model_fingerprint, capabilities_json, point_count, activated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id, index_name) DO UPDATE SET
                    collection_name=excluded.collection_name,
                    schema_version=excluded.schema_version,
                    model_fingerprint=excluded.model_fingerprint,
                    capabilities_json=excluded.capabilities_json,
                    point_count=excluded.point_count,
                    activated_at=excluded.activated_at
                """,
                (
                    project_id,
                    index_name,
                    collection_name,
                    schema_version,
                    model_fingerprint,
                    json.dumps(capabilities, sort_keys=True),
                    point_count,
                    utc_now(),
                ),
            )

    def generation(self, project_id: str, index_name: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT * FROM index_generations
                WHERE project_id=? AND index_name=?
                """,
                (project_id, index_name),
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["capabilities"] = json.loads(result.pop("capabilities_json"))
        return result

    def log_retrieval(
        self,
        project_id: str,
        book_id: str,
        index_name: str,
        consumed_ids: list[str],
        request: dict[str, Any],
    ) -> str:
        query_id = str(uuid.uuid4())
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO retrieval_log(
                    query_id, project_id, book_id, index_name,
                    consumed_ids_json, request_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    query_id,
                    project_id,
                    book_id,
                    index_name,
                    json.dumps(consumed_ids, ensure_ascii=False),
                    json.dumps(request, ensure_ascii=False, sort_keys=True),
                    utc_now(),
                ),
            )
        return query_id

    def export_scope(self, project_id: str, book_id: str, destination: Path) -> int:
        destination.parent.mkdir(parents=True, exist_ok=True)
        count = 0
        with destination.open("w", encoding="utf-8", newline="\n") as handle:
            for index_name in (
                "story_memory",
                "translation_memory",
                "source_paragraph",
            ):
                for row in self.list_records(project_id, index_name, book_id=book_id):
                    handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
                    count += 1
        return count

    @staticmethod
    def _canonical_table(payload: dict[str, Any]) -> str | None:
        raw = str(payload.get("canonical_type") or payload.get("memory_type") or "")
        normalized = raw.strip().lower().replace("-", "_").replace(" ", "_")
        aliases = {
            "character": "characters",
            "alias": "aliases",
            "relationship": "relationships",
            "location": "locations",
            "item": "items",
            "term": "terms",
            "recurring_phrase": "recurring_phrases",
            "voice": "character_voice",
            "retrospective_constraint": "retrospective_constraints",
        }
        table = aliases.get(normalized, normalized)
        return table if table in CANONICAL_TABLES else None

