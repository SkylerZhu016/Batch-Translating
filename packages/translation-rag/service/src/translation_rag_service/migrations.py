from __future__ import annotations

import sqlite3


SCHEMA_VERSION = 1

CANONICAL_TABLES = (
    "characters",
    "aliases",
    "relationships",
    "locations",
    "items",
    "terms",
    "recurring_phrases",
    "character_voice",
    "retrospective_constraints",
)


def migrate(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS rag_records (
            project_id TEXT NOT NULL,
            book_id TEXT NOT NULL,
            index_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            point_id TEXT NOT NULL,
            text_content TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, book_id, index_name, record_id),
            UNIQUE (project_id, index_name, point_id)
        )
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS rag_records_scope
        ON rag_records(project_id, book_id, index_name)
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS index_generations (
            project_id TEXT NOT NULL,
            index_name TEXT NOT NULL,
            collection_name TEXT NOT NULL,
            schema_version TEXT NOT NULL,
            model_fingerprint TEXT NOT NULL,
            capabilities_json TEXT NOT NULL,
            point_count INTEGER NOT NULL,
            activated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, index_name)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS retrieval_log (
            query_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            book_id TEXT NOT NULL,
            index_name TEXT NOT NULL,
            consumed_ids_json TEXT NOT NULL,
            request_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    for table in CANONICAL_TABLES:
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {table} (
                project_id TEXT NOT NULL,
                book_id TEXT NOT NULL,
                canonical_id TEXT NOT NULL,
                chapter_id TEXT,
                display_name TEXT,
                data_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, book_id, canonical_id)
            )
            """
        )
        connection.execute(
            f"""
            CREATE INDEX IF NOT EXISTS {table}_scope
            ON {table}(project_id, book_id)
            """
        )
    connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    connection.commit()

