export type SourceFormat = 'epub' | 'txt';

export interface SourceReceipt {
  readonly source_path: string;
  readonly format: SourceFormat;
  readonly sha256: string;
  readonly byte_length: number;
  readonly modified_at_ms: number;
}

export interface CopiedSourceReceipt {
  readonly original: SourceReceipt;
  readonly copied_path: string;
  readonly copied_sha256: string;
  readonly byte_length: number;
  readonly immutable: true;
}

export type EpubResourceKind =
  | 'body'
  | 'navigation'
  | 'stylesheet'
  | 'image'
  | 'font'
  | 'audio'
  | 'video'
  | 'package'
  | 'other';

export interface EpubManifestItem {
  readonly id: string;
  readonly href: string;
  readonly zip_path: string;
  readonly media_type: string;
  readonly properties: readonly string[];
  readonly kind: EpubResourceKind;
  readonly sha256: string;
  readonly byte_length: number;
}

export interface TextSegmentManifest {
  readonly segment_id: string;
  /** Child-node indexes relative to the paragraph element. */
  readonly node_path: readonly number[];
  readonly source_text: string;
  readonly source_hash: string;
  readonly protected_markup: boolean;
}

export interface ParagraphManifest {
  readonly paragraph_id: string;
  readonly chapter_id: string;
  readonly ordinal: number;
  readonly element_path?: readonly number[];
  readonly source_start?: number;
  readonly source_end?: number;
  readonly source_text: string;
  readonly source_hash: string;
  readonly segments: readonly TextSegmentManifest[];
}

export interface ChapterManifest {
  readonly chapter_id: string;
  readonly ordinal: number;
  readonly manifest_id?: string;
  readonly source_path: string;
  readonly linear: boolean;
  readonly media_type: string;
  readonly paragraphs: readonly ParagraphManifest[];
}

export interface BookManifest {
  readonly schema_version: 1;
  readonly format: SourceFormat;
  readonly source: SourceReceipt;
  readonly book_id: string;
  readonly created_at: string;
  readonly package_document_path?: string;
  readonly navigation_path?: string;
  readonly metadata: Readonly<Record<string, readonly string[]>>;
  readonly resources: readonly EpubManifestItem[];
  readonly reading_order: readonly string[];
  readonly chapters: readonly ChapterManifest[];
  readonly paragraph_count: number;
  readonly source_word_count: number;
}

export interface ParsedSource {
  readonly manifest: BookManifest;
}

export interface TranslationRecord {
  readonly paragraph_id: string;
  readonly translation: string;
  /** Optional exact text-node translations. The paragraph translation remains the audit value. */
  readonly segment_translations?: Readonly<Record<string, string>>;
}

export interface RepairPatch {
  readonly issue_id: string;
  readonly paragraph_id: string;
  readonly old_translation: string;
  readonly old_translation_hash: string;
  readonly new_translation: string;
  readonly reason: string;
  readonly segment_translations?: Readonly<Record<string, string>>;
  /** Set only by an arbitration task that resolved every member of conflict_set. */
  readonly conflict_set?: readonly string[];
}

export interface TranslationArtifactPayload {
  readonly kind: 'translation';
  readonly records: readonly TranslationRecord[];
}

export interface RepairArtifactPayload {
  readonly kind: 'repair' | 'arbitration';
  readonly patches: readonly RepairPatch[];
}

export type MergeArtifactPayload = TranslationArtifactPayload | RepairArtifactPayload;

export interface MergeArtifact {
  readonly artifact_id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly schema_version: number;
  readonly source_hashes: readonly string[];
  readonly prompt_version: string;
  readonly prompt_fingerprint: string;
  readonly instruction_version: number;
  readonly context_hash: string;
  readonly model_id: string;
  readonly model_fingerprint: string;
  readonly created_at: string;
  readonly payload: MergeArtifactPayload;
  readonly payload_hash: string;
  readonly stale?: boolean;
}

export interface MergeTaskSnapshot {
  readonly task_id: string;
  readonly project_id: string;
  readonly state: 'PENDING' | 'LEASED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'STALE' | 'CANCELLED' | 'BLOCKED';
  readonly prompt_version: string;
  readonly prompt_fingerprint: string;
  readonly instruction_version: number;
  readonly context_hash: string;
  readonly model_id: string;
  readonly model_fingerprint: string;
  readonly source_hashes: readonly string[];
}

export interface MergeGate {
  readonly project_id: string;
  readonly source_hashes: readonly string[];
  readonly prompt_version: string;
  readonly prompt_fingerprint: string;
  readonly instruction_version: number;
  readonly context_hash: string;
  readonly model_id: string;
  readonly model_fingerprint: string;
  readonly paragraph_ids: readonly string[];
  readonly require_complete_coverage?: boolean;
}

export interface MergeInput {
  readonly gate: MergeGate;
  readonly tasks: readonly MergeTaskSnapshot[];
  readonly artifacts: readonly MergeArtifact[];
}

export interface MergeConflict {
  readonly paragraph_id: string;
  readonly artifact_ids: readonly string[];
  readonly reason: string;
}

export interface MergeReceipt {
  readonly schema_version: 1;
  readonly project_id: string;
  readonly merged_at: string;
  readonly gate_fingerprint: string;
  readonly artifact_ids: readonly string[];
  readonly translation_count: number;
  readonly translations_hash: string;
}

export interface MergeResult {
  readonly records: readonly TranslationRecord[];
  readonly receipt: MergeReceipt;
}

export interface StructuralValidationResult {
  readonly valid: boolean;
  readonly checks: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface EpubcheckResult {
  readonly status: 'passed' | 'failed' | 'unavailable' | 'timed_out';
  readonly command?: string;
  readonly exit_code?: number;
  readonly output: string;
}

export interface RenderProvenance {
  readonly project_id: string;
  readonly instruction_version: number;
  readonly prompt_fingerprint: string;
  readonly context_hash: string;
  readonly model_fingerprint: string;
  readonly merge_receipt_hash: string;
}

export interface FinalArtifactReceipt {
  readonly schema_version: 1;
  readonly artifact_type: SourceFormat;
  readonly output_path: string;
  readonly source_path: string;
  readonly source_sha256: string;
  readonly artifact_sha256: string;
  readonly byte_length: number;
  readonly immutable: true;
  readonly paragraph_count: number;
  readonly translated_paragraph_count: number;
  readonly coverage: number;
  readonly structural_validation: StructuralValidationResult;
  readonly epubcheck?: EpubcheckResult;
  readonly provenance: RenderProvenance;
  readonly created_at: string;
}

export interface RenderSourceOptions {
  readonly source_path: string;
  readonly output_path: string;
  readonly manifest: BookManifest;
  readonly translations: readonly TranslationRecord[];
  readonly provenance: RenderProvenance;
  readonly require_complete_coverage?: boolean;
  readonly epubcheck_path?: string;
  readonly require_epubcheck?: boolean;
}

export interface ReportTaskRow {
  readonly task_id: string;
  readonly state: MergeTaskSnapshot['state'];
}

export interface ReportAttemptRow {
  readonly attempt_id: string;
  readonly task_id: string;
  readonly state: string;
  readonly retry_reason?: string;
}

export interface ReportMemoryRow {
  readonly memory_id: string;
  readonly type: string;
}

export interface ReportIssueRow {
  readonly issue_id: string;
  readonly category: string;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly resolved: boolean;
  readonly accepted_exception?: boolean;
}

export interface ReportPatchRow {
  readonly issue_id: string;
  readonly paragraph_id: string;
}

export interface ReportConflictRow {
  readonly conflict_id: string;
  readonly resolved: boolean;
}

export interface ReportCostRow {
  readonly event_id: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly cached_tokens: number;
  readonly actual_cost: number;
  readonly currency: string;
}

export interface DeterministicReportInput {
  readonly snapshot_as_of: string;
  readonly manifest: BookManifest;
  readonly translations: readonly TranslationRecord[];
  readonly memory_records: readonly ReportMemoryRow[];
  readonly rag_configuration: Readonly<Record<string, string | number | boolean>>;
  readonly tasks: readonly ReportTaskRow[];
  readonly attempts: readonly ReportAttemptRow[];
  readonly issues: readonly ReportIssueRow[];
  readonly patches: readonly ReportPatchRow[];
  readonly conflicts: readonly ReportConflictRow[];
  readonly costs: readonly ReportCostRow[];
  readonly final_artifact: FinalArtifactReceipt;
}

export interface ReportReceipt {
  readonly output_path: string;
  readonly sha256: string;
  readonly byte_length: number;
  readonly immutable: true;
}
