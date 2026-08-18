from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class IndexKind(str, Enum):
    STORY_MEMORY = "story_memory"
    TRANSLATION_MEMORY = "translation_memory"
    SOURCE_PARAGRAPH = "source_paragraph"


class MemoryRecord(StrictModel):
    id: str | None = Field(default=None, min_length=1, max_length=512)
    memory_id: str | None = Field(default=None, min_length=1, max_length=512)
    type: str | None = Field(default=None, max_length=128)
    memory_type: str | None = Field(default=None, max_length=128)
    chapter_id: str | None = Field(default=None, min_length=1, max_length=512)
    chapter: int | None = Field(default=None, ge=0)
    paragraph_ids: list[str] = Field(default_factory=list, max_length=10000)
    entities: list[str] = Field(default_factory=list, max_length=1000)
    text: str | None = Field(default=None, max_length=2_000_000)
    summary: str | None = Field(default=None, max_length=2_000_000)
    source: str | None = Field(default=None, max_length=2_000_000)
    target: str | None = Field(default=None, max_length=2_000_000)
    importance: float = Field(default=0.5, ge=0, le=1)
    confidence: float = Field(default=1, ge=0, le=1)
    source_provenance: dict[str, Any] = Field(default_factory=dict)
    provenance_id: str | None = Field(default=None, max_length=512)
    spoiler_policy: str = Field(default="safe", max_length=64)
    instruction_version: int | str | None = None
    source_hash: str | None = Field(default=None, max_length=256)
    approved: bool = False
    final: bool = False
    target_text: str | None = Field(default=None, max_length=2_000_000)
    approval: Literal["approved", "final"] | None = None
    schema_version: str | None = Field(default=None, max_length=64)
    canonical_type: str | None = Field(default=None, max_length=128)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def logical_id(self) -> str:
        return self.memory_id or self.id or ""

    @model_validator(mode="after")
    def validate_content(self) -> "MemoryRecord":
        if not any((self.text, self.summary, self.source)):
            raise ValueError("record requires text, summary, or source")
        return self


class MemoryUpsertRequest(StrictModel):
    project_id: str = Field(min_length=1, max_length=512)
    book_id: str = Field(min_length=1, max_length=512)
    index: IndexKind = IndexKind.STORY_MEMORY
    records: list[MemoryRecord] = Field(min_length=1, max_length=5000)

    @model_validator(mode="after")
    def validate_translation_memory(self) -> "MemoryUpsertRequest":
        if self.index is IndexKind.TRANSLATION_MEMORY:
            for record in self.records:
                target = record.target or record.target_text
                if not (record.source or record.text) or not target:
                    raise ValueError("translation memory records require source and target")
                is_approved = (
                    record.approved
                    or record.final
                    or record.approval in {"approved", "final"}
                )
                if not is_approved:
                    raise ValueError("only approved and final translations may enter TM")
        return self


class MemoryDeleteRequest(StrictModel):
    project_id: str = Field(min_length=1, max_length=512)
    book_id: str = Field(min_length=1, max_length=512)
    index: IndexKind = IndexKind.STORY_MEMORY
    ids: list[str] = Field(default_factory=list, max_length=5000)
    provenance_ids: list[str] = Field(default_factory=list, max_length=5000)

    @model_validator(mode="after")
    def require_selector(self) -> "MemoryDeleteRequest":
        if not self.ids and not self.provenance_ids:
            raise ValueError("ids or provenance_ids is required")
        return self


class SearchFilters(StrictModel):
    source_hashes: list[str] = Field(default_factory=list, max_length=1000)
    instruction_versions: list[int | str] = Field(default_factory=list, max_length=1000)
    provenance_ids: list[str] = Field(default_factory=list, max_length=1000)
    entities: list[str] = Field(default_factory=list, max_length=1000)
    memory_types: list[str] = Field(default_factory=list, max_length=1000)


class SearchRequest(StrictModel):
    project_id: str = Field(min_length=1, max_length=512)
    book_id: str = Field(min_length=1, max_length=512)
    query: str = Field(min_length=1, max_length=100_000)
    top_k: int = Field(default=8, ge=1, le=100)
    chapter_id: str | None = Field(default=None, max_length=512)
    max_chapter: int | None = Field(default=None, ge=0)
    spoiler_policy: Literal[
        "historical",
        "retrospective_constraint",
        "review_only",
        "no_future",
        "safe",
        "allow_retrospective",
        "allow_all",
    ] = "historical"
    filters: SearchFilters = Field(default_factory=SearchFilters)
    evidence_budget_chars: int | None = Field(default=None, ge=256, le=1_000_000)
    use_sparse: bool = True
    use_colbert: bool = True


class SearchHit(StrictModel):
    id: str
    score: float
    text: str
    index: IndexKind
    chapter_id: str | None = None
    paragraph_ids: list[str] = Field(default_factory=list)
    memory_type: str | None = None
    entities: list[str] = Field(default_factory=list)
    importance: float | None = None
    spoiler_policy: str | None = None
    source_hash: str | None = None
    instruction_version: int | str | None = None
    provenance_id: str | None = None
    target_text: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchResponse(StrictModel):
    hits: list[SearchHit]
    capabilities: dict[str, Any]
    degraded: bool
    consumed_memory_ids: list[str]
    warnings: list[str] = Field(default_factory=list)


class VerifyRequest(StrictModel):
    project_id: str = Field(min_length=1, max_length=512)
    book_id: str = Field(min_length=1, max_length=512)
    query: str | None = Field(default=None, max_length=100_000)


class RebuildRequest(StrictModel):
    project_id: str = Field(min_length=1, max_length=512)
    book_id: str = Field(min_length=1, max_length=512)
    indexes: list[IndexKind] = Field(default_factory=lambda: list(IndexKind))
    schema_version: int | None = Field(default=None, ge=1)
    force: bool = False


class SnapshotRequest(StrictModel):
    project_id: str = Field(min_length=1, max_length=512)
    book_id: str = Field(min_length=1, max_length=512)
    destination: str | None = Field(default=None, max_length=4096)


class OperationResponse(StrictModel):
    ok: bool = True
    details: dict[str, Any] = Field(default_factory=dict)
