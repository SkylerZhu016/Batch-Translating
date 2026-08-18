export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const CURRENT_SCHEMA_VERSION = 1;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_durable_translation_ledger',
    sql: `
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_root_path TEXT NOT NULL,
  artifact_root_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE',
  instruction_version INTEGER NOT NULL DEFAULT 0 CHECK (instruction_version >= 0),
  soft_budget_micros INTEGER,
  hard_budget_micros INTEGER,
  per_stage_budget_json TEXT NOT NULL DEFAULT '{}',
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  max_concurrency INTEGER NOT NULL DEFAULT 8 CHECK (max_concurrency > 0),
  review_policy TEXT NOT NULL DEFAULT 'strict',
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_items (
  source_item_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  href TEXT NOT NULL,
  media_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  spine_index INTEGER,
  linear INTEGER NOT NULL DEFAULT 1 CHECK (linear IN (0, 1)),
  source_hash TEXT NOT NULL,
  immutable_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, href)
) STRICT;

CREATE TABLE paragraphs (
  paragraph_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_text TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  entities_json TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_item_id, ordinal),
  UNIQUE(project_id, paragraph_id)
) STRICT;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','LEASED','RUNNING','SUCCEEDED','FAILED','STALE','CANCELLED','BLOCKED')),
  priority INTEGER NOT NULL DEFAULT 0,
  dependency_ids_json TEXT NOT NULL DEFAULT '[]',
  prompt_version TEXT NOT NULL,
  instruction_version INTEGER NOT NULL CHECK (instruction_version >= 0),
  context_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  decoding_config_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  cost_class TEXT NOT NULL DEFAULT 'PAID' CHECK (cost_class IN ('LOCAL','PAID')),
  stage TEXT NOT NULL DEFAULT 'translation',
  max_attempts INTEGER NOT NULL DEFAULT 4 CHECK (max_attempts > 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  active_attempt_id TEXT,
  interrupt_mode TEXT CHECK (interrupt_mode IS NULL OR interrupt_mode IN ('SOFT','HARD')),
  interrupt_requested_at TEXT,
  block_reason TEXT,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
) STRICT;

CREATE TABLE task_attempts (
  attempt_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  state TEXT NOT NULL CHECK (state IN ('LEASED','RUNNING','SUCCEEDED','FAILED','LEASE_EXPIRED','INTERRUPTED','CANCELLED')),
  worker_id TEXT NOT NULL,
  instruction_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider_request_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_reason TEXT,
  discarded_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (discarded_cost_micros >= 0),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, attempt_number),
  UNIQUE(project_id, provider_request_id)
) STRICT;

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','STALE','REJECTED')),
  schema_version INTEGER NOT NULL,
  source_hashes_json TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  instruction_version INTEGER NOT NULL,
  context_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  stale_reason TEXT,
  readopted_by_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, attempt_id),
  UNIQUE(project_id, file_path)
) STRICT;

CREATE TABLE instruction_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  session_message_id TEXT NOT NULL,
  instruction_version INTEGER NOT NULL,
  message TEXT NOT NULL,
  affected_scope_json TEXT NOT NULL,
  interrupt_mode TEXT NOT NULL CHECK (interrupt_mode IN ('SOFT','HARD')),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, session_message_id),
  UNIQUE(project_id, instruction_version)
) STRICT;

CREATE TABLE memory_records (
  memory_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL,
  chapter_id TEXT,
  paragraph_ids_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  source_provenance_json TEXT NOT NULL,
  instruction_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','STALE','REJECTED')),
  content_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, content_hash, instruction_version)
) STRICT;

CREATE TABLE canonical_entities (
  canonical_record_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  entity_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  canonical_value_json TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  source_provenance_json TEXT NOT NULL,
  instruction_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','STALE','SUPERSEDED')),
  content_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, entity_key, instruction_version, content_hash)
) STRICT;

CREATE TABLE translation_memory_records (
  tm_record_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  paragraph_id TEXT REFERENCES paragraphs(paragraph_id) ON DELETE SET NULL,
  source_hash TEXT NOT NULL,
  target_text TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  approval TEXT NOT NULL CHECK (approval IN ('APPROVED','FINAL')),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  instruction_version INTEGER NOT NULL,
  provenance_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','STALE','SUPERSEDED')),
  fingerprint TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, fingerprint)
) STRICT;

CREATE TABLE review_issues (
  issue_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
  chapter_id TEXT,
  paragraph_ids_json TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  source_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  target_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  story_memory_ids_json TEXT NOT NULL DEFAULT '[]',
  explanation TEXT NOT NULL,
  suggested_action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','ACCEPTED','STALE')),
  resolution_event_id TEXT,
  instruction_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE repair_patches (
  patch_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES review_issues(issue_id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(paragraph_id) ON DELETE CASCADE,
  old_translation_hash TEXT NOT NULL,
  new_translation TEXT NOT NULL,
  new_translation_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (state IN ('PROPOSED','SELECTED','REJECTED','STALE')),
  instruction_version INTEGER NOT NULL,
  provenance_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, issue_id, paragraph_id, new_translation_hash)
) STRICT;

CREATE TABLE merge_conflicts (
  conflict_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(paragraph_id) ON DELETE CASCADE,
  patch_ids_json TEXT NOT NULL,
  base_translation_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','RESOLVED','STALE')),
  selected_patch_id TEXT REFERENCES repair_patches(patch_id) ON DELETE SET NULL,
  arbitration_artifact_id TEXT REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
  instruction_version INTEGER NOT NULL,
  resolution_json TEXT,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE cost_events (
  cost_event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_request_id TEXT,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  cached_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  price_snapshot_json TEXT NOT NULL,
  actual_cost_micros INTEGER NOT NULL CHECK (actual_cost_micros >= 0),
  retry_reason TEXT,
  prompt_fingerprint TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  instruction_fingerprint TEXT NOT NULL,
  billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0, 1)),
  discarded INTEGER NOT NULL DEFAULT 0 CHECK (discarded IN (0, 1)),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, provider_request_id),
  UNIQUE(project_id, cost_event_id)
) STRICT;

CREATE TABLE index_versions (
  index_version_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  index_kind TEXT NOT NULL,
  schema_fingerprint TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('STAGING','CURRENT','DEGRADED','STALE','FAILED')),
  point_count INTEGER NOT NULL DEFAULT 0 CHECK (point_count >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, index_kind, schema_fingerprint, model_fingerprint)
) STRICT;

CREATE TABLE project_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES task_attempts(attempt_id) ON DELETE SET NULL,
  instruction_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE merger_leases (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  lease_owner TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE completion_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  instruction_version INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, instruction_version, snapshot_hash)
) STRICT;

CREATE INDEX tasks_claim_idx ON tasks(project_id, state, priority DESC, created_at);
CREATE INDEX tasks_lease_idx ON tasks(state, lease_expires_at);
CREATE INDEX tasks_instruction_idx ON tasks(project_id, instruction_version, state);
CREATE INDEX attempts_task_idx ON task_attempts(task_id, attempt_number DESC);
CREATE INDEX artifacts_task_idx ON artifacts(task_id, state, instruction_version);
CREATE INDEX artifacts_project_idx ON artifacts(project_id, state, created_at);
CREATE INDEX paragraphs_project_idx ON paragraphs(project_id, source_item_id, ordinal);
CREATE INDEX memory_project_idx ON memory_records(project_id, state, memory_type, chapter_id);
CREATE INDEX canonical_project_idx ON canonical_entities(project_id, state, entity_key);
CREATE INDEX tm_exact_idx ON translation_memory_records(project_id, state, source_hash);
CREATE INDEX review_gate_idx ON review_issues(project_id, status, severity);
CREATE INDEX patch_paragraph_idx ON repair_patches(project_id, paragraph_id, state);
CREATE INDEX conflicts_gate_idx ON merge_conflicts(project_id, state);
CREATE INDEX cost_project_idx ON cost_events(project_id, stage, created_at);
CREATE INDEX events_project_idx ON project_events(project_id, created_at, event_type);
`,
  },
];
