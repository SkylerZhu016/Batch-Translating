/**
 * Public wire contracts for the local translation RAG sidecar and BGE-M3 model manager.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type RagIndexName = 'story_memory' | 'translation_memory' | 'source_paragraph';
export type RagServiceState = 'starting' | 'ready' | 'degraded' | 'unavailable';
export type RagSpoilerPolicy = 'historical' | 'retrospective_constraint' | 'review_only';
export type RagDevice = 'cuda' | 'mps' | 'cpu';

export interface RagCapabilities {
  readonly dense: boolean;
  readonly sparse: boolean;
  readonly hybrid: boolean;
  readonly rerank: boolean;
  readonly active_mode?: 'dense' | 'hybrid';
}

export interface RagModelInfo {
  readonly model_id: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly device: RagDevice | string;
  readonly embedding_batch_size?: number;
}

export interface RagIndexInfo {
  readonly index: RagIndexName;
  readonly collection: string;
  readonly alias: string;
  readonly schema_version: number;
  readonly point_count: number;
  readonly model_fingerprint: string;
  readonly ready: boolean;
}

export interface RagHealthResponse {
  readonly status: RagServiceState;
  readonly service_version?: string;
  readonly model?: RagModelInfo;
  readonly capabilities: RagCapabilities;
  readonly degraded: boolean;
  readonly warnings: readonly string[];
}

export interface RagIndexStatusRequest {
  readonly project_id: string;
  readonly book_id: string;
}

export interface RagIndexStatusResponse {
  readonly project_id: string;
  readonly book_id: string;
  readonly indexes: readonly RagIndexInfo[];
  readonly capabilities: RagCapabilities;
  readonly degraded: boolean;
  readonly warnings?: readonly string[];
}

export interface RagMemoryRecord {
  readonly id: string;
  readonly text: string;
  readonly chapter_id?: string;
  readonly paragraph_ids?: readonly string[];
  readonly memory_type?: string;
  readonly entities?: readonly string[];
  readonly importance?: number;
  readonly spoiler_policy?: RagSpoilerPolicy;
  readonly source_hash?: string;
  readonly instruction_version?: number;
  readonly provenance_id?: string;
  readonly target_text?: string;
  readonly approval?: 'approved' | 'final';
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface RagMemoryUpsertRequest {
  readonly project_id: string;
  readonly book_id: string;
  readonly index: RagIndexName;
  readonly records: readonly RagMemoryRecord[];
}

export interface RagMutationResponse {
  readonly project_id: string;
  readonly book_id: string;
  readonly index: RagIndexName;
  readonly affected: number;
  readonly point_ids?: readonly string[];
}

export interface RagMemoryDeleteRequest {
  readonly project_id: string;
  readonly book_id: string;
  readonly index: RagIndexName;
  readonly ids?: readonly string[];
  readonly provenance_ids?: readonly string[];
}

export interface RagSearchFilters {
  readonly source_hashes?: readonly string[];
  readonly instruction_versions?: readonly number[];
  readonly provenance_ids?: readonly string[];
  readonly entities?: readonly string[];
  readonly memory_types?: readonly string[];
}

export interface RagSearchRequest {
  readonly project_id: string;
  readonly book_id: string;
  readonly query: string;
  readonly top_k?: number;
  readonly chapter_id?: string;
  readonly max_chapter?: number;
  readonly spoiler_policy?: RagSpoilerPolicy;
  readonly filters?: RagSearchFilters;
}

export interface RagSearchHit {
  readonly id: string;
  readonly score: number;
  readonly text: string;
  readonly index: RagIndexName;
  readonly chapter_id?: string;
  readonly paragraph_ids?: readonly string[];
  readonly memory_type?: string;
  readonly entities?: readonly string[];
  readonly importance?: number;
  readonly spoiler_policy?: RagSpoilerPolicy;
  readonly source_hash?: string;
  readonly instruction_version?: number;
  readonly provenance_id?: string;
  readonly target_text?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface RagSearchResponse {
  readonly hits: readonly RagSearchHit[];
  readonly capabilities: RagCapabilities;
  readonly degraded: boolean;
  readonly consumed_memory_ids: readonly string[];
  readonly warnings?: readonly string[];
}

export interface RagVerifyRequest {
  readonly project_id: string;
  readonly book_id: string;
  readonly query?: string;
}

export interface RagVerifyResponse {
  readonly ok: boolean;
  readonly project_id: string;
  readonly book_id: string;
  readonly model?: RagModelInfo;
  readonly indexes: readonly RagIndexInfo[];
  readonly capabilities: RagCapabilities;
  readonly degraded: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface RagIndexRebuildRequest {
  readonly project_id: string;
  readonly book_id: string;
  readonly indexes?: readonly RagIndexName[];
  readonly schema_version?: number;
  readonly force?: boolean;
}

export interface RagIndexRebuildResponse {
  readonly project_id: string;
  readonly book_id: string;
  readonly status: 'queued' | 'running' | 'completed';
  readonly rebuild_id: string;
  readonly indexes: readonly RagIndexInfo[];
}

export interface RagSnapshotRequest {
  readonly project_id: string;
  readonly book_id: string;
  readonly destination?: string;
}

export interface RagSnapshotResponse {
  readonly project_id: string;
  readonly book_id: string;
  readonly snapshot_id: string;
  readonly path: string;
  readonly created_at: string;
  readonly sha256?: string;
}

export interface RagRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout_ms?: number;
}

export type RagFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RagClientOptions {
  readonly base_url: string;
  readonly bearer_token: string;
  readonly allow_remote?: boolean;
  readonly default_timeout_ms?: number;
  readonly fetch?: RagFetch;
}

export type ModelSourceKind = 'official' | 'mirror' | 'custom';

export interface ModelDownloadSource {
  readonly id: string;
  readonly label: string;
  readonly kind: ModelSourceKind;
  readonly base_url: string;
}

export interface ModelFileDigest {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ModelFingerprint {
  readonly model_id: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly files: readonly ModelFileDigest[];
}

export interface DiscoveredModel extends ModelFingerprint {
  readonly directory: string;
  readonly source: 'environment' | 'huggingface_cache' | 'explicit' | 'managed';
}

export interface ModelDiscoveryResult {
  readonly found: boolean;
  readonly selected?: DiscoveredModel;
  readonly candidates: readonly DiscoveredModel[];
  readonly checked_paths: readonly string[];
}

export interface ModelDiscoveryOptions {
  readonly explicit_paths?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home_directory?: string;
  readonly verify_hashes?: boolean;
  readonly signal?: AbortSignal;
}

export interface ModelDownloadFile {
  readonly path: string;
  readonly size: number;
  readonly sha256?: string;
  readonly url: string;
  readonly lfs: boolean;
}

export interface ModelDownloadPlan {
  readonly model_id: string;
  readonly requested_revision: string;
  readonly resolved_revision: string;
  readonly source: ModelDownloadSource;
  readonly destination: string;
  readonly files: readonly ModelDownloadFile[];
  readonly total_bytes: number;
}

export interface CreateModelDownloadPlanOptions {
  readonly model_id?: string;
  readonly revision?: string;
  readonly source: ModelDownloadSource;
  readonly destination: string;
  readonly signal?: AbortSignal;
}

export type ModelDownloadPhase =
  | 'idle'
  | 'discovering'
  | 'planning'
  | 'checking_disk'
  | 'downloading'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ModelDownloadProgress {
  readonly phase: ModelDownloadPhase;
  readonly model_id: string;
  readonly file?: string;
  readonly file_bytes_downloaded: number;
  readonly file_bytes_total: number;
  readonly bytes_downloaded: number;
  readonly bytes_total: number;
  readonly percent: number;
  readonly message: string;
}

export interface ModelDownloadResult {
  readonly directory: string;
  readonly fingerprint: ModelFingerprint;
  readonly resumed: boolean;
  readonly downloaded_bytes: number;
}

export interface DownloadModelOptions {
  readonly signal?: AbortSignal;
  readonly reserve_bytes?: number;
}

export interface HardwareNotice {
  readonly title: string;
  readonly quality_message: string;
  readonly gpu_message: string;
  readonly fallback_message: string;
  readonly recommended_vram_gb: number;
}

export interface RagToolContext {
  readonly signal?: AbortSignal;
}

export interface RagToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, JsonValue>>;
  execute(input: unknown, context?: RagToolContext): Promise<JsonValue>;
}
