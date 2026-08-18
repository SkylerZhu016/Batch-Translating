import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ImmutableArtifactStore } from './artifact-store.ts';
import { LedgerDatabase, type SqlRow } from './database.ts';
import {
  canonicalJson,
  computeTaskIdempotencyKey,
  hashCanonical,
  sameStringSet,
  sha256Text,
} from './hash.ts';
import { CURRENT_SCHEMA_VERSION } from './migrations/index.ts';
import {
  TASK_STATES,
  type AffectedScope,
  type ApplyInstructionInput,
  type ArtifactEnvelope,
  type ArtifactProvenance,
  type ArtifactRecord,
  type BudgetStatus,
  type CanonicalEntityInput,
  type ClaimedTask,
  type CompleteAttemptInput,
  type CompletionSnapshot,
  type CompletionSnapshotOptions,
  type CostEventInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type DeterministicReportData,
  type IndexVersionInput,
  type InstructionApplicationResult,
  type InstructionEventRecord,
  type IntegrityReport,
  type LedgerOptions,
  type LeaseRecoveryResult,
  type MemoryRecordInput,
  type MergeConflictInput,
  type MergerLeaseToken,
  type MergeValidationInput,
  type ParagraphRecord,
  type ProjectRecord,
  type RegisterParagraphInput,
  type RegisterSourceItemInput,
  type RepairPatchInput,
  type ReviewIssueInput,
  type SourceItemRecord,
  type SyntheticUsageEventInput,
  type SyntheticUsageEventResult,
  type TaskAttemptRecord,
  type TaskRecord,
  type TaskState,
  type TranslationMemoryInput,
} from './types.ts';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${name}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseJson<T>(value: unknown, name: string): T {
  try {
    return JSON.parse(requiredString(value, name)) as T;
  } catch (error) {
    throw new Error(`Corrupted ${name}`, { cause: error });
  }
}

function asBoolean(value: unknown): boolean {
  return value === 1;
}

function assertIdentifier(name: string, value: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`${name} is not a stable safe identifier`);
}

function assertHash(name: string, value: string): void {
  if (!HASH_PATTERN.test(value)) throw new Error(`${name} must be a lowercase SHA-256 hash`);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function taskFromRow(row: SqlRow): TaskRecord {
  return {
    taskId: requiredString(row['task_id'], 'task_id'),
    projectId: requiredString(row['project_id'], 'project_id'),
    taskType: requiredString(row['task_type'], 'task_type'),
    scope: parseJson<Record<string, unknown>>(row['scope_json'], 'scope_json'),
    scopeHash: requiredString(row['scope_hash'], 'scope_hash'),
    state: requiredString(row['state'], 'state') as TaskState,
    priority: requiredNumber(row['priority'], 'priority'),
    dependencyIds: parseJson<string[]>(row['dependency_ids_json'], 'dependency_ids_json'),
    promptVersion: requiredString(row['prompt_version'], 'prompt_version'),
    instructionVersion: requiredNumber(row['instruction_version'], 'instruction_version'),
    contextHash: requiredString(row['context_hash'], 'context_hash'),
    modelId: requiredString(row['model_id'], 'model_id'),
    decodingConfigHash: requiredString(row['decoding_config_hash'], 'decoding_config_hash'),
    idempotencyKey: requiredString(row['idempotency_key'], 'idempotency_key'),
    costClass: requiredString(row['cost_class'], 'cost_class') as TaskRecord['costClass'],
    stage: requiredString(row['stage'], 'stage'),
    maxAttempts: requiredNumber(row['max_attempts'], 'max_attempts'),
    leaseOwner: optionalString(row['lease_owner']),
    leaseExpiresAt: optionalString(row['lease_expires_at']),
    activeAttemptId: optionalString(row['active_attempt_id']),
    interruptMode: optionalString(row['interrupt_mode']) as TaskRecord['interruptMode'],
    interruptRequestedAt: optionalString(row['interrupt_requested_at']),
    blockReason: optionalString(row['block_reason']),
    schemaVersion: requiredNumber(row['schema_version'], 'schema_version'),
    createdAt: requiredString(row['created_at'], 'created_at'),
    updatedAt: requiredString(row['updated_at'], 'updated_at'),
  };
}

function attemptFromRow(row: SqlRow): TaskAttemptRecord {
  return {
    attemptId: requiredString(row['attempt_id'], 'attempt_id'),
    projectId: requiredString(row['project_id'], 'project_id'),
    taskId: requiredString(row['task_id'], 'task_id'),
    attemptNumber: requiredNumber(row['attempt_number'], 'attempt_number'),
    state: requiredString(row['state'], 'state') as TaskAttemptRecord['state'],
    workerId: requiredString(row['worker_id'], 'worker_id'),
    instructionVersion: requiredNumber(row['instruction_version'], 'instruction_version'),
    idempotencyKey: requiredString(row['idempotency_key'], 'idempotency_key'),
    providerRequestId: optionalString(row['provider_request_id']),
    startedAt: optionalString(row['started_at']),
    finishedAt: optionalString(row['finished_at']),
    errorCode: optionalString(row['error_code']),
    errorMessage: optionalString(row['error_message']),
    retryReason: optionalString(row['retry_reason']),
    discardedCostMicros: requiredNumber(row['discarded_cost_micros'], 'discarded_cost_micros'),
    schemaVersion: requiredNumber(row['schema_version'], 'schema_version'),
    createdAt: requiredString(row['created_at'], 'created_at'),
    updatedAt: requiredString(row['updated_at'], 'updated_at'),
  };
}

function artifactFromRow(row: SqlRow): ArtifactRecord {
  return {
    artifactId: requiredString(row['artifact_id'], 'artifact_id'),
    projectId: requiredString(row['project_id'], 'project_id'),
    taskId: requiredString(row['task_id'], 'task_id'),
    attemptId: requiredString(row['attempt_id'], 'attempt_id'),
    state: requiredString(row['state'], 'state') as ArtifactRecord['state'],
    schemaVersion: requiredNumber(row['schema_version'], 'schema_version'),
    sourceHashes: parseJson<string[]>(row['source_hashes_json'], 'source_hashes_json'),
    promptVersion: requiredString(row['prompt_version'], 'prompt_version'),
    instructionVersion: requiredNumber(row['instruction_version'], 'instruction_version'),
    contextHash: requiredString(row['context_hash'], 'context_hash'),
    modelId: requiredString(row['model_id'], 'model_id'),
    filePath: requiredString(row['file_path'], 'file_path'),
    payloadHash: requiredString(row['payload_hash'], 'payload_hash'),
    envelopeHash: requiredString(row['envelope_hash'], 'envelope_hash'),
    provenance: parseJson<ArtifactProvenance>(row['provenance_json'], 'provenance_json'),
    staleReason: optionalString(row['stale_reason']),
    readoptedByEventId: optionalString(row['readopted_by_event_id']),
    createdAt: requiredString(row['created_at'], 'created_at'),
    updatedAt: requiredString(row['updated_at'], 'updated_at'),
  };
}

function projectFromRow(row: SqlRow): ProjectRecord {
  return {
    projectId: requiredString(row['project_id'], 'project_id'),
    name: requiredString(row['name'], 'name'),
    sourceRootPath: requiredString(row['source_root_path'], 'source_root_path'),
    artifactRootPath: requiredString(row['artifact_root_path'], 'artifact_root_path'),
    sourceHash: requiredString(row['source_hash'], 'source_hash'),
    providerId: requiredString(row['provider_id'], 'provider_id'),
    modelId: requiredString(row['model_id'], 'model_id'),
    state: requiredString(row['state'], 'state'),
    instructionVersion: requiredNumber(row['instruction_version'], 'instruction_version'),
    softBudgetMicros: optionalNumber(row['soft_budget_micros']),
    hardBudgetMicros: optionalNumber(row['hard_budget_micros']),
    perStageBudgetMicros: parseJson<Record<string, number>>(
      row['per_stage_budget_json'],
      'per_stage_budget_json',
    ),
    maxRetries: requiredNumber(row['max_retries'], 'max_retries'),
    maxConcurrency: requiredNumber(row['max_concurrency'], 'max_concurrency'),
    reviewPolicy: requiredString(row['review_policy'], 'review_policy'),
    schemaVersion: requiredNumber(row['schema_version'], 'schema_version'),
    createdAt: requiredString(row['created_at'], 'created_at'),
    updatedAt: requiredString(row['updated_at'], 'updated_at'),
  };
}

function sourceItemFromRow(row: SqlRow): SourceItemRecord {
  return {
    sourceItemId: requiredString(row['source_item_id'], 'source_item_id'),
    projectId: requiredString(row['project_id'], 'project_id'),
    href: requiredString(row['href'], 'href'),
    mediaType: requiredString(row['media_type'], 'media_type'),
    kind: requiredString(row['kind'], 'kind'),
    spineIndex: optionalNumber(row['spine_index']),
    linear: asBoolean(row['linear']),
    sourceHash: requiredString(row['source_hash'], 'source_hash'),
    immutablePath: requiredString(row['immutable_path'], 'immutable_path'),
    metadata: parseJson<Record<string, unknown>>(row['metadata_json'], 'metadata_json'),
    schemaVersion: requiredNumber(row['schema_version'], 'schema_version'),
    createdAt: requiredString(row['created_at'], 'created_at'),
    updatedAt: requiredString(row['updated_at'], 'updated_at'),
  };
}

function paragraphFromRow(row: SqlRow): ParagraphRecord {
  return {
    paragraphId: requiredString(row['paragraph_id'], 'paragraph_id'),
    projectId: requiredString(row['project_id'], 'project_id'),
    sourceItemId: requiredString(row['source_item_id'], 'source_item_id'),
    ordinal: requiredNumber(row['ordinal'], 'ordinal'),
    sourceText: requiredString(row['source_text'], 'source_text'),
    sourceHash: requiredString(row['source_hash'], 'source_hash'),
    entities: parseJson<string[]>(row['entities_json'], 'entities_json'),
    schemaVersion: requiredNumber(row['schema_version'], 'schema_version'),
    createdAt: requiredString(row['created_at'], 'created_at'),
    updatedAt: requiredString(row['updated_at'], 'updated_at'),
  };
}

function instructionFromRow(row: SqlRow): InstructionEventRecord {
  return {
    eventId: requiredString(row['event_id'], 'event_id'),
    projectId: requiredString(row['project_id'], 'project_id'),
    sessionMessageId: requiredString(row['session_message_id'], 'session_message_id'),
    instructionVersion: requiredNumber(row['instruction_version'], 'instruction_version'),
    message: requiredString(row['message'], 'message'),
    affectedScope: parseJson<AffectedScope>(row['affected_scope_json'], 'affected_scope_json'),
    interruptMode: requiredString(row['interrupt_mode'], 'interrupt_mode') as InstructionEventRecord['interruptMode'],
    createdAt: requiredString(row['created_at'], 'created_at'),
  };
}

function collectScopeSelectors(value: unknown, chapters: Set<string>, entities: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectScopeSelectors(entry, chapters, entities);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (typeof entry === 'string') {
      if (normalized.includes('chapter')) chapters.add(entry);
      if (normalized.includes('entity') || normalized.includes('character')) entities.add(entry);
    } else if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item !== 'string') continue;
        if (normalized.includes('chapter')) chapters.add(item);
        if (normalized.includes('entit') || normalized.includes('character')) entities.add(item);
      }
    }
    collectScopeSelectors(entry, chapters, entities);
  }
}

export class TranslationProjectLedger {
  readonly database: LedgerDatabase;
  private readonly now: () => Date;

  constructor(options: LedgerOptions) {
    this.database = new LedgerDatabase(options.databasePath, options.busyTimeoutMs);
    this.now = options.now ?? (() => new Date());
  }

  static open(options: LedgerOptions): TranslationProjectLedger {
    return new TranslationProjectLedger(options);
  }

  close(): void {
    this.database.close();
  }

  checkpoint(): void {
    this.database.checkpoint('FULL');
  }

  createProject(input: CreateProjectInput): ProjectRecord {
    const projectId = input.projectId ?? randomUUID();
    assertIdentifier('projectId', projectId);
    assertHash('sourceHash', input.sourceHash);
    const sourceRootPath = resolve(input.sourceRootPath);
    const artifactRootPath = resolve(input.artifactRootPath);
    if (isWithin(sourceRootPath, artifactRootPath) || isWithin(artifactRootPath, sourceRootPath)) {
      throw new Error('Source and artifact roots must be disjoint to preserve source immutability');
    }
    const maxRetries = input.maxRetries ?? 3;
    const maxConcurrency = input.maxConcurrency ?? 8;
    assertNonNegativeInteger('maxRetries', maxRetries);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) {
      throw new Error('maxConcurrency must be a positive safe integer');
    }
    if (input.softBudgetMicros != null) assertNonNegativeInteger('softBudgetMicros', input.softBudgetMicros);
    if (input.hardBudgetMicros != null) assertNonNegativeInteger('hardBudgetMicros', input.hardBudgetMicros);
    const stageBudgets = input.perStageBudgetMicros ?? {};
    for (const [stage, budget] of Object.entries(stageBudgets)) {
      if (!stage) throw new Error('A per-stage budget needs a stage name');
      assertNonNegativeInteger(`perStageBudgetMicros.${stage}`, budget);
    }
    const timestamp = this.nowIso();
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO projects(
          project_id,name,source_root_path,artifact_root_path,source_hash,provider_id,model_id,
          state,instruction_version,soft_budget_micros,hard_budget_micros,per_stage_budget_json,
          max_retries,max_concurrency,review_policy,schema_version,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,'ACTIVE',0,?,?,?,?,?,?,?,?,?)`,
        [
          projectId,
          input.name,
          sourceRootPath,
          artifactRootPath,
          input.sourceHash,
          input.providerId,
          input.modelId,
          input.softBudgetMicros ?? null,
          input.hardBudgetMicros ?? null,
          canonicalJson(stageBudgets),
          maxRetries,
          maxConcurrency,
          input.reviewPolicy ?? 'strict',
          CURRENT_SCHEMA_VERSION,
          timestamp,
          timestamp,
        ],
      );
      this.appendProjectEvent(projectId, 'PROJECT_CREATED', 'system', {
        sourceHash: input.sourceHash,
        providerId: input.providerId,
        modelId: input.modelId,
      });
    });
    return this.requireProject(projectId);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const row = this.database.get<SqlRow>('SELECT * FROM projects WHERE project_id = ?', [projectId]);
    return row ? projectFromRow(row) : undefined;
  }

  requireProject(projectId: string): ProjectRecord {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }

  openProject(projectId: string): ProjectRecord {
    return this.requireProject(projectId);
  }

  updateBudgets(
    projectId: string,
    budgets: Pick<CreateProjectInput, 'softBudgetMicros' | 'hardBudgetMicros' | 'perStageBudgetMicros'>,
    actor = 'coordinator',
  ): ProjectRecord {
    const project = this.requireProject(projectId);
    const soft = budgets.softBudgetMicros === undefined ? project.softBudgetMicros : budgets.softBudgetMicros;
    const hard = budgets.hardBudgetMicros === undefined ? project.hardBudgetMicros : budgets.hardBudgetMicros;
    const stages = budgets.perStageBudgetMicros ?? project.perStageBudgetMicros;
    if (soft != null) assertNonNegativeInteger('softBudgetMicros', soft);
    if (hard != null) assertNonNegativeInteger('hardBudgetMicros', hard);
    for (const [stage, amount] of Object.entries(stages)) {
      assertNonNegativeInteger(`perStageBudgetMicros.${stage}`, amount);
    }
    const timestamp = this.nowIso();
    this.database.transaction(() => {
      this.database.run(
        `UPDATE projects SET soft_budget_micros=?, hard_budget_micros=?,
         per_stage_budget_json=?, updated_at=? WHERE project_id=?`,
        [soft, hard, canonicalJson(stages), timestamp, projectId],
      );
      this.database.run(
        `UPDATE tasks SET state='PENDING', block_reason=NULL, updated_at=?
         WHERE project_id=? AND state='BLOCKED' AND block_reason LIKE 'BUDGET:%'`,
        [timestamp, projectId],
      );
      this.appendProjectEvent(projectId, 'BUDGET_UPDATED', actor, { soft, hard, stages });
    });
    return this.requireProject(projectId);
  }

  changePinnedModel(
    projectId: string,
    providerId: string,
    modelId: string,
    instructionEventId: string,
    actor = 'coordinator',
  ): ProjectRecord {
    const instruction = this.database.get<SqlRow>(
      'SELECT event_id,instruction_version FROM instruction_events WHERE event_id=? AND project_id=?',
      [instructionEventId, projectId],
    );
    if (!instruction) throw new Error('A persisted instruction event is required to change a model pin');
    const before = this.requireProject(projectId);
    if (instruction['instruction_version'] !== before.instructionVersion) {
      throw new Error('Only the current instruction event can authorize a model-pin change');
    }
    this.database.transaction(() => {
      const timestamp = this.nowIso();
      this.database.run(
        `UPDATE artifacts SET state='STALE', stale_reason='MODEL_PIN_CHANGED', updated_at=?
         WHERE project_id=? AND state='ACTIVE' AND model_id<>?`,
        [timestamp, projectId, modelId],
      );
      this.database.run(
        `UPDATE tasks SET state='STALE', block_reason='MODEL_PIN_CHANGED', updated_at=?
         WHERE project_id=? AND state='SUCCEEDED' AND model_id<>?`,
        [timestamp, projectId, modelId],
      );
      this.database.run(
        `UPDATE tasks SET state='CANCELLED', block_reason='MODEL_PIN_CHANGED', updated_at=?
         WHERE project_id=? AND state IN ('PENDING','BLOCKED') AND cost_class='PAID' AND model_id<>?`,
        [timestamp, projectId, modelId],
      );
      this.database.run(
        `UPDATE tasks SET interrupt_mode='SOFT', interrupt_requested_at=?, block_reason='MODEL_PIN_CHANGED',
         updated_at=? WHERE project_id=? AND state IN ('LEASED','RUNNING') AND cost_class='PAID' AND model_id<>?`,
        [timestamp, timestamp, projectId, modelId],
      );
      this.database.run(
        'UPDATE projects SET provider_id=?, model_id=?, updated_at=? WHERE project_id=?',
        [providerId, modelId, timestamp, projectId],
      );
      this.appendProjectEvent(projectId, 'MODEL_PIN_CHANGED', actor, {
        providerId,
        modelId,
        instructionEventId,
      });
    });
    return this.requireProject(projectId);
  }

  registerSourceItem(input: RegisterSourceItemInput): SourceItemRecord {
    assertIdentifier('sourceItemId', input.sourceItemId);
    assertHash('sourceHash', input.sourceHash);
    const project = this.requireProject(input.projectId);
    const immutablePath = resolve(input.immutablePath);
    if (isWithin(project.artifactRootPath, immutablePath)) {
      throw new Error('A source item cannot live under the writable artifact root');
    }
    const timestamp = this.nowIso();
    const existing = this.database.get<SqlRow>(
      'SELECT * FROM source_items WHERE source_item_id=? OR (project_id=? AND href=?)',
      [input.sourceItemId, input.projectId, input.href],
    );
    if (existing) {
      const record = sourceItemFromRow(existing);
      if (
        record.sourceItemId !== input.sourceItemId ||
        record.projectId !== input.projectId ||
        record.href !== input.href ||
        record.mediaType !== input.mediaType ||
        record.kind !== input.kind ||
        record.spineIndex !== (input.spineIndex ?? null) ||
        record.linear !== (input.linear !== false) ||
        record.sourceHash !== input.sourceHash ||
        record.immutablePath !== immutablePath ||
        canonicalJson(record.metadata) !== canonicalJson(input.metadata ?? {})
      ) {
        throw new Error('Source items are immutable and the existing identity has different content');
      }
      return record;
    }
    this.database.run(
      `INSERT INTO source_items(
        source_item_id,project_id,href,media_type,kind,spine_index,linear,source_hash,
        immutable_path,metadata_json,schema_version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.sourceItemId,
        input.projectId,
        input.href,
        input.mediaType,
        input.kind,
        input.spineIndex ?? null,
        input.linear === false ? 0 : 1,
        input.sourceHash,
        immutablePath,
        canonicalJson(input.metadata ?? {}),
        CURRENT_SCHEMA_VERSION,
        timestamp,
        timestamp,
      ],
    );
    return sourceItemFromRow(
      this.database.get<SqlRow>('SELECT * FROM source_items WHERE source_item_id=?', [input.sourceItemId])!,
    );
  }

  registerParagraph(input: RegisterParagraphInput): ParagraphRecord {
    assertIdentifier('paragraphId', input.paragraphId);
    assertHash('sourceHash', input.sourceHash);
    const item = this.database.get<SqlRow>('SELECT project_id FROM source_items WHERE source_item_id=?', [
      input.sourceItemId,
    ]);
    if (!item || item['project_id'] !== input.projectId) throw new Error('Paragraph source item is not in this project');
    const existing = this.database.get<SqlRow>(
      'SELECT * FROM paragraphs WHERE paragraph_id=? OR (source_item_id=? AND ordinal=?)',
      [input.paragraphId, input.sourceItemId, input.ordinal],
    );
    if (existing) {
      const record = paragraphFromRow(existing);
      if (
        record.paragraphId !== input.paragraphId ||
        record.projectId !== input.projectId ||
        record.sourceItemId !== input.sourceItemId ||
        record.ordinal !== input.ordinal ||
        record.sourceHash !== input.sourceHash ||
        record.sourceText !== input.sourceText ||
        canonicalJson(record.entities) !== canonicalJson(input.entities ?? [])
      ) {
        throw new Error('Paragraph identities are stable and immutable');
      }
      return record;
    }
    const timestamp = this.nowIso();
    this.database.run(
      `INSERT INTO paragraphs(
        paragraph_id,project_id,source_item_id,ordinal,source_text,source_hash,entities_json,
        schema_version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        input.paragraphId,
        input.projectId,
        input.sourceItemId,
        input.ordinal,
        input.sourceText,
        input.sourceHash,
        canonicalJson(input.entities ?? []),
        CURRENT_SCHEMA_VERSION,
        timestamp,
        timestamp,
      ],
    );
    return paragraphFromRow(
      this.database.get<SqlRow>('SELECT * FROM paragraphs WHERE paragraph_id=?', [input.paragraphId])!,
    );
  }

  listParagraphs(projectId: string, sourceItemId?: string): ParagraphRecord[] {
    const rows = sourceItemId
      ? this.database.all<SqlRow>(
          'SELECT * FROM paragraphs WHERE project_id=? AND source_item_id=? ORDER BY ordinal',
          [projectId, sourceItemId],
        )
      : this.database.all<SqlRow>(
          'SELECT * FROM paragraphs WHERE project_id=? ORDER BY source_item_id, ordinal',
          [projectId],
        );
    return rows.map(paragraphFromRow);
  }

  ensureTask(input: CreateTaskInput): { task: TaskRecord; reused: boolean; artifact?: ArtifactRecord } {
    return this.database.transaction(() => this.ensureTaskInternal(input));
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.database.get<SqlRow>('SELECT * FROM tasks WHERE task_id=?', [taskId]);
    return row ? taskFromRow(row) : undefined;
  }

  listTasks(projectId: string, states?: TaskState[]): TaskRecord[] {
    if (!states || states.length === 0) {
      return this.database
        .all<SqlRow>('SELECT * FROM tasks WHERE project_id=? ORDER BY priority DESC, created_at', [projectId])
        .map(taskFromRow);
    }
    const placeholders = states.map(() => '?').join(',');
    return this.database
      .all<SqlRow>(
        `SELECT * FROM tasks WHERE project_id=? AND state IN (${placeholders}) ORDER BY priority DESC, created_at`,
        [projectId, ...states],
      )
      .map(taskFromRow);
  }

  getTaskAttempt(attemptId: string): TaskAttemptRecord | undefined {
    const row = this.database.get<SqlRow>('SELECT * FROM task_attempts WHERE attempt_id=?', [attemptId]);
    return row ? attemptFromRow(row) : undefined;
  }

  listTaskAttempts(projectId: string, taskId?: string): TaskAttemptRecord[] {
    const rows = taskId
      ? this.database.all<SqlRow>(
          'SELECT * FROM task_attempts WHERE project_id=? AND task_id=? ORDER BY attempt_number',
          [projectId, taskId],
        )
      : this.database.all<SqlRow>(
          'SELECT * FROM task_attempts WHERE project_id=? ORDER BY created_at,attempt_number',
          [projectId],
        );
    return rows.map(attemptFromRow);
  }

  retryTask(taskId: string, actor = 'coordinator'): TaskRecord {
    return this.database.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      const project = this.requireProject(task.projectId);
      if (task.instructionVersion !== project.instructionVersion) {
        throw new Error('A stale-instruction task cannot be retried; create a replacement task');
      }
      if (task.costClass === 'PAID' && task.modelId !== project.modelId) {
        throw new Error('A task for an old model pin cannot be retried');
      }
      if (task.state === 'SUCCEEDED') throw new Error('A succeeded task must be reused, never retried');
      if (!['FAILED', 'CANCELLED'].includes(task.state)) {
        throw new Error(`Task ${taskId} cannot be retried from ${task.state}`);
      }
      const attempts = this.listTaskAttempts(task.projectId, taskId);
      if (attempts.length >= task.maxAttempts) throw new Error('Task has exhausted its attempt budget');
      this.database.run(
        `UPDATE tasks SET state='PENDING', block_reason=NULL, interrupt_mode=NULL,
         interrupt_requested_at=NULL, updated_at=? WHERE task_id=?`,
        [this.nowIso(), taskId],
      );
      this.appendProjectEvent(task.projectId, 'TASK_RETRY_AUTHORIZED', actor, {
        previousState: task.state,
        nextAttempt: attempts.length + 1,
      }, taskId);
      return taskFromRow(this.database.get<SqlRow>('SELECT * FROM tasks WHERE task_id=?', [taskId])!);
    });
  }

  authorizeRetryAfterProviderCheck(
    taskId: string,
    attemptId: string,
    providerRequestId: string | null,
    actor = 'coordinator',
  ): TaskRecord {
    return this.database.transaction(() => {
      const task = this.getTask(taskId);
      const attempt = this.getTaskAttempt(attemptId);
      if (
        !task ||
        !attempt ||
        attempt.taskId !== taskId ||
        task.state !== 'BLOCKED' ||
        !task.blockReason?.startsWith('UNCERTAIN_PROVIDER_RESULT:') ||
        attempt.providerRequestId !== providerRequestId ||
        attempt.state !== 'LEASE_EXPIRED'
      ) {
        throw new Error('Task is not the matching uncertain provider attempt');
      }
      const attempts = this.listTaskAttempts(task.projectId, taskId);
      if (attempts.length >= task.maxAttempts) throw new Error('Task has exhausted its attempt budget');
      const timestamp = this.nowIso();
      this.database.run(
        `UPDATE task_attempts SET state='FAILED', retry_reason='PROVIDER_CONFIRMED_NOT_COMPLETED',
         error_code='PROVIDER_NOT_COMPLETED', updated_at=? WHERE attempt_id=?`,
        [timestamp, attemptId],
      );
      this.database.run(
        `UPDATE tasks SET state='PENDING', block_reason=NULL, updated_at=? WHERE task_id=?`,
        [timestamp, taskId],
      );
      this.appendProjectEvent(task.projectId, 'UNCERTAIN_PROVIDER_RETRY_AUTHORIZED', actor, {
        providerRequestId,
        checked: true,
      }, taskId, attemptId);
      return taskFromRow(this.database.get<SqlRow>('SELECT * FROM tasks WHERE task_id=?', [taskId])!);
    });
  }

  reclaimUncertainAttemptForResult(
    taskId: string,
    attemptId: string,
    providerRequestId: string | null,
    workerId: string,
    leaseDurationMs: number,
  ): ClaimedTask {
    assertIdentifier('workerId', workerId);
    return this.database.transaction(() => {
      const task = this.getTask(taskId);
      const attempt = this.getTaskAttempt(attemptId);
      if (
        !task ||
        !attempt ||
        attempt.taskId !== taskId ||
        task.state !== 'BLOCKED' ||
        !task.blockReason?.startsWith('UNCERTAIN_PROVIDER_RESULT:') ||
        attempt.providerRequestId !== providerRequestId ||
        attempt.state !== 'LEASE_EXPIRED'
      ) {
        throw new Error('Task is not the matching uncertain provider attempt');
      }
      const timestamp = this.nowIso();
      const expires = new Date(this.now().getTime() + leaseDurationMs).toISOString();
      this.database.run(
        `UPDATE tasks SET state='RUNNING', lease_owner=?, lease_expires_at=?, active_attempt_id=?,
         block_reason='RECOVERING_PROVIDER_RESULT', updated_at=? WHERE task_id=?`,
        [workerId, expires, attemptId, timestamp, taskId],
      );
      this.database.run(
        `UPDATE task_attempts SET state='RUNNING', worker_id=?, finished_at=NULL,
         retry_reason='RECOVERING_PROVIDER_RESULT', updated_at=? WHERE attempt_id=?`,
        [workerId, timestamp, attemptId],
      );
      this.appendProjectEvent(task.projectId, 'UNCERTAIN_PROVIDER_RESULT_RECLAIMED', workerId, {
        providerRequestId,
        noNewPaidRequest: true,
      }, taskId, attemptId);
      return {
        task: taskFromRow(this.database.get<SqlRow>('SELECT * FROM tasks WHERE task_id=?', [taskId])!),
        attempt: attemptFromRow(
          this.database.get<SqlRow>('SELECT * FROM task_attempts WHERE attempt_id=?', [attemptId])!,
        ),
      };
    });
  }

  findReusableArtifact(input: CreateTaskInput): ArtifactRecord | undefined {
    const key = computeTaskIdempotencyKey(input);
    const row = this.database.get<SqlRow>(
      `SELECT a.* FROM tasks t JOIN artifacts a ON a.task_id=t.task_id
       WHERE t.project_id=? AND t.idempotency_key=? AND t.state='SUCCEEDED' AND a.state='ACTIVE'
       ORDER BY a.created_at DESC LIMIT 1`,
      [input.projectId, key],
    );
    return row ? artifactFromRow(row) : undefined;
  }

  claimNextTask(options: {
    projectId: string;
    workerId: string;
    leaseDurationMs: number;
    taskTypes?: string[];
  }): ClaimedTask | undefined {
    assertIdentifier('workerId', options.workerId);
    if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be a positive safe integer');
    }
    return this.database.transaction(() => {
      this.recoverExpiredLeasesInternal(options.projectId);
      const project = this.requireProject(options.projectId);
      if (project.state !== 'ACTIVE') return undefined;
      const activeCount = requiredNumber(
        this.database.get<SqlRow>(
          `SELECT COUNT(*) AS count FROM tasks WHERE project_id=? AND state IN ('LEASED','RUNNING')`,
          [options.projectId],
        )?.['count'] ?? 0,
        'active task count',
      );
      if (activeCount >= project.maxConcurrency) return undefined;

      const taskTypeClause = options.taskTypes?.length
        ? ` AND task_type IN (${options.taskTypes.map(() => '?').join(',')})`
        : '';
      const rows = this.database.all<SqlRow>(
        `SELECT * FROM tasks WHERE project_id=? AND state='PENDING'${taskTypeClause}
         ORDER BY priority DESC, created_at ASC`,
        [options.projectId, ...(options.taskTypes ?? [])],
      );
      const budget = this.getBudgetStatus(options.projectId);
      for (const row of rows) {
        const task = taskFromRow(row);
        if (task.costClass === 'PAID' && task.modelId !== project.modelId) {
          this.database.run(
            `UPDATE tasks SET state='STALE', block_reason='MODEL_PIN_CHANGED', updated_at=? WHERE task_id=?`,
            [this.nowIso(), task.taskId],
          );
          continue;
        }
        if (!this.dependenciesSatisfied(task)) continue;
        const attemptCount = requiredNumber(
          this.database.get<SqlRow>('SELECT COUNT(*) AS count FROM task_attempts WHERE task_id=?', [task.taskId])?.[
            'count'
          ] ?? 0,
          'attempt count',
        );
        if (attemptCount >= task.maxAttempts) {
          this.database.run(
            `UPDATE tasks SET state='FAILED', block_reason='MAX_ATTEMPTS', updated_at=?
             WHERE task_id=? AND state='PENDING'`,
            [this.nowIso(), task.taskId],
          );
          this.appendProjectEvent(task.projectId, 'TASK_MAX_ATTEMPTS', 'ledger', {}, task.taskId);
          continue;
        }
        if (task.costClass === 'PAID') {
          const stageLimit = budget.perStageBudgetMicros[task.stage];
          const stageCost = budget.stageCostMicros[task.stage] ?? 0;
          const budgetReason = budget.hardExceeded
            ? 'BUDGET:HARD'
            : stageLimit !== undefined && stageCost >= stageLimit
              ? `BUDGET:STAGE:${task.stage}`
              : null;
          if (budgetReason) {
            this.database.run(
              `UPDATE tasks SET state='BLOCKED', block_reason=?, updated_at=?
               WHERE task_id=? AND state='PENDING'`,
              [budgetReason, this.nowIso(), task.taskId],
            );
            this.appendProjectEvent(task.projectId, 'TASK_BUDGET_BLOCKED', 'ledger', {
              reason: budgetReason,
            }, task.taskId);
            continue;
          }
        }

        const attemptId = randomUUID();
        const timestamp = this.nowIso();
        const leaseExpiresAt = new Date(this.now().getTime() + options.leaseDurationMs).toISOString();
        const updated = this.database.run(
          `UPDATE tasks SET state='LEASED', lease_owner=?, lease_expires_at=?, active_attempt_id=?,
           interrupt_mode=NULL, interrupt_requested_at=NULL, block_reason=NULL, updated_at=?
           WHERE task_id=? AND state='PENDING'`,
          [options.workerId, leaseExpiresAt, attemptId, timestamp, task.taskId],
        );
        if (updated.changes !== 1) continue;
        this.database.run(
          `INSERT INTO task_attempts(
            attempt_id,project_id,task_id,attempt_number,state,worker_id,instruction_version,
            idempotency_key,schema_version,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [
            attemptId,
            task.projectId,
            task.taskId,
            attemptCount + 1,
            'LEASED',
            options.workerId,
            task.instructionVersion,
            task.idempotencyKey,
            CURRENT_SCHEMA_VERSION,
            timestamp,
            timestamp,
          ],
        );
        this.appendProjectEvent(task.projectId, 'TASK_LEASED', options.workerId, { leaseExpiresAt }, task.taskId, attemptId);
        return {
          task: taskFromRow(this.database.get<SqlRow>('SELECT * FROM tasks WHERE task_id=?', [task.taskId])!),
          attempt: attemptFromRow(
            this.database.get<SqlRow>('SELECT * FROM task_attempts WHERE attempt_id=?', [attemptId])!,
          ),
        };
      }
      return undefined;
    });
  }

  markAttemptRunning(taskId: string, attemptId: string, workerId: string): ClaimedTask {
    return this.database.transaction(() => {
      const task = this.requireOwnedAttempt(taskId, attemptId, workerId);
      if (task.state !== 'LEASED') throw new Error(`Task ${taskId} is not leased`);
      const timestamp = this.nowIso();
      this.database.run("UPDATE tasks SET state='RUNNING', updated_at=? WHERE task_id=?", [timestamp, taskId]);
      this.database.run(
        "UPDATE task_attempts SET state='RUNNING', started_at=COALESCE(started_at,?), updated_at=? WHERE attempt_id=?",
        [timestamp, timestamp, attemptId],
      );
      this.appendProjectEvent(task.projectId, 'TASK_RUNNING', workerId, {}, taskId, attemptId);
      return {
        task: taskFromRow(this.database.get<SqlRow>('SELECT * FROM tasks WHERE task_id=?', [taskId])!),
        attempt: attemptFromRow(
          this.database.get<SqlRow>('SELECT * FROM task_attempts WHERE attempt_id=?', [attemptId])!,
        ),
      };
    });
  }

  renewTaskLease(taskId: string, attemptId: string, workerId: string, leaseDurationMs: number): string {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be a positive safe integer');
    }
    return this.database.transaction(() => {
      const task = this.requireOwnedAttempt(taskId, attemptId, workerId);
      if (task.state !== 'LEASED' && task.state !== 'RUNNING') throw new Error('Only active tasks have renewable leases');
      const expires = new Date(this.now().getTime() + leaseDurationMs).toISOString();
      this.database.run('UPDATE tasks SET lease_expires_at=?, updated_at=? WHERE task_id=?', [
        expires,
        this.nowIso(),
        taskId,
      ]);
      return expires;
    });
  }

  setAttemptProviderRequestId(taskId: string, attemptId: string, workerId: string, requestId: string): void {
    this.database.transaction(() => {
      this.requireOwnedAttempt(taskId, attemptId, workerId);
      const existing = this.database.get<SqlRow>(
        'SELECT provider_request_id FROM task_attempts WHERE attempt_id=?',
        [attemptId],
      );
      const old = optionalString(existing?.['provider_request_id']);
      if (old && old !== requestId) throw new Error('Provider request identity is immutable once recorded');
      this.database.run('UPDATE task_attempts SET provider_request_id=?, updated_at=? WHERE attempt_id=?', [
        requestId,
        this.nowIso(),
        attemptId,
      ]);
    });
  }

  completeAttempt<T>(input: CompleteAttemptInput<T>): ArtifactRecord {
    for (const sourceHash of input.sourceHashes) assertHash('sourceHash', sourceHash);
    const prepared = this.database.transaction<
      { task: TaskRecord; existing: ArtifactRecord } | { task: TaskRecord; attempt: TaskAttemptRecord }
    >(() => {
      const knownTask = this.getTask(input.taskId);
      const knownArtifact = this.getArtifactByAttempt(input.taskId, input.attemptId);
      if (knownTask?.state === 'SUCCEEDED' && knownArtifact) return { task: knownTask, existing: knownArtifact };
      const task = this.requireOwnedAttempt(input.taskId, input.attemptId, input.workerId);
      if (task.projectId !== input.projectId) throw new Error('Task does not belong to the supplied project');
      if (task.state !== 'LEASED' && task.state !== 'RUNNING') {
        const existing = this.getArtifactByAttempt(input.taskId, input.attemptId);
        if (task.state === 'SUCCEEDED' && existing) return { task, existing };
        throw new Error(`Task ${task.taskId} is not completable from state ${task.state}`);
      }
      this.assertProvenanceMatchesTask(input.provenance, input.sourceHashes, task);
      const attempt = this.getTaskAttempt(input.attemptId);
      if (!attempt) throw new Error('Attempt row is missing');
      return { task, attempt };
    });
    if ('existing' in prepared) return prepared.existing;

    const task = prepared.task;
    const project = this.requireProject(input.projectId);
    const artifactId = `artifact_${input.attemptId}`;
    const timestamp = this.nowIso();
    const payloadHash = hashCanonical(input.payload);
    const envelope: ArtifactEnvelope<T> = {
      artifactId,
      projectId: input.projectId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sourceHashes: [...input.sourceHashes],
      promptVersion: task.promptVersion,
      instructionVersion: task.instructionVersion,
      contextHash: task.contextHash,
      modelId: task.modelId,
      createdAt: prepared.attempt.createdAt,
      payload: input.payload,
      payloadHash,
      provenance: input.provenance,
    };
    const store = new ImmutableArtifactStore(project.artifactRootPath);
    const written = store.write(envelope);

    return this.database.transaction(() => {
      const current = this.requireOwnedAttempt(input.taskId, input.attemptId, input.workerId);
      const existing = this.getArtifactByAttempt(input.taskId, input.attemptId);
      if (existing) {
        if (
          existing.envelopeHash !== written.envelopeHash ||
          existing.payloadHash !== payloadHash ||
          existing.filePath !== written.filePath
        ) {
          throw new Error('Attempt already registered a different immutable artifact');
        }
        return existing;
      }
      const interrupted = current.interruptMode !== null;
      const artifactState = interrupted ? 'STALE' : 'ACTIVE';
      this.database.run(
        `INSERT INTO artifacts(
          artifact_id,project_id,task_id,attempt_id,state,schema_version,source_hashes_json,
          prompt_version,instruction_version,context_hash,model_id,file_path,payload_hash,
          envelope_hash,provenance_json,stale_reason,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          artifactId,
          input.projectId,
          input.taskId,
          input.attemptId,
          artifactState,
          CURRENT_SCHEMA_VERSION,
          canonicalJson(input.sourceHashes),
          current.promptVersion,
          current.instructionVersion,
          current.contextHash,
          current.modelId,
          written.filePath,
          payloadHash,
          written.envelopeHash,
          canonicalJson(input.provenance),
          interrupted ? `INTERRUPTED:${current.interruptMode}` : null,
          timestamp,
          timestamp,
        ],
      );
      this.database.run(
        `UPDATE task_attempts SET state=?, finished_at=?, updated_at=? WHERE attempt_id=?`,
        [interrupted ? 'INTERRUPTED' : 'SUCCEEDED', timestamp, timestamp, input.attemptId],
      );
      this.database.run(
        `UPDATE tasks SET state=?, lease_owner=NULL, lease_expires_at=NULL, active_attempt_id=NULL,
         block_reason=NULL, updated_at=? WHERE task_id=?`,
        [interrupted ? 'STALE' : 'SUCCEEDED', timestamp, input.taskId],
      );
      this.appendProjectEvent(
        input.projectId,
        interrupted ? 'TASK_COMPLETED_STALE' : 'TASK_SUCCEEDED',
        input.workerId,
        { artifactId, envelopeHash: written.envelopeHash, interrupted: current.interruptMode },
        input.taskId,
        input.attemptId,
      );
      return artifactFromRow(
        this.database.get<SqlRow>('SELECT * FROM artifacts WHERE artifact_id=?', [artifactId])!,
      );
    });
  }

  failAttempt(options: {
    taskId: string;
    attemptId: string;
    workerId: string;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    retryReason?: string | null;
  }): TaskRecord {
    return this.database.transaction(() => {
      const task = this.requireOwnedAttempt(options.taskId, options.attemptId, options.workerId);
      if (task.state !== 'LEASED' && task.state !== 'RUNNING') {
        throw new Error(`Task ${task.taskId} is not active`);
      }
      const timestamp = this.nowIso();
      const attemptCount = requiredNumber(
        this.database.get<SqlRow>('SELECT COUNT(*) AS count FROM task_attempts WHERE task_id=?', [task.taskId])?.[
          'count'
        ] ?? 0,
        'attempt count',
      );
      const retry = options.retryable && attemptCount < task.maxAttempts && task.interruptMode === null;
      this.database.run(
        `UPDATE task_attempts SET state='FAILED', finished_at=?, error_code=?, error_message=?,
         retry_reason=?, updated_at=? WHERE attempt_id=?`,
        [
          timestamp,
          options.errorCode,
          options.errorMessage,
          options.retryReason ?? null,
          timestamp,
          options.attemptId,
        ],
      );
      this.database.run(
        `UPDATE tasks SET state=?, lease_owner=NULL, lease_expires_at=NULL, active_attempt_id=NULL,
         interrupt_mode=NULL, interrupt_requested_at=NULL, block_reason=?, updated_at=? WHERE task_id=?`,
        [retry ? 'PENDING' : task.interruptMode ? 'CANCELLED' : 'FAILED', retry ? null : options.errorCode, timestamp, task.taskId],
      );
      this.appendProjectEvent(
        task.projectId,
        retry ? 'TASK_RETRY_SCHEDULED' : 'TASK_FAILED',
        options.workerId,
        {
          errorCode: options.errorCode,
          retryReason: options.retryReason ?? null,
          nextAttempt: retry ? attemptCount + 1 : null,
        },
        task.taskId,
        options.attemptId,
      );
      return taskFromRow(this.database.get<SqlRow>('SELECT * FROM tasks WHERE task_id=?', [task.taskId])!);
    });
  }

  recoverExpiredLeases(projectId: string): LeaseRecoveryResult {
    return this.database.transaction(() => this.recoverExpiredLeasesInternal(projectId));
  }

  getArtifact(artifactId: string): ArtifactRecord | undefined {
    const row = this.database.get<SqlRow>('SELECT * FROM artifacts WHERE artifact_id=?', [artifactId]);
    return row ? artifactFromRow(row) : undefined;
  }

  listArtifacts(projectId: string, state?: ArtifactRecord['state']): ArtifactRecord[] {
    const rows = state
      ? this.database.all<SqlRow>(
          'SELECT * FROM artifacts WHERE project_id=? AND state=? ORDER BY created_at',
          [projectId, state],
        )
      : this.database.all<SqlRow>('SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at', [projectId]);
    return rows.map(artifactFromRow);
  }

  getInterruptRequest(taskId: string): {
    mode: TaskRecord['interruptMode'];
    requestedAt: string | null;
  } {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return { mode: task.interruptMode, requestedAt: task.interruptRequestedAt };
  }

  requestTaskCancellation(taskId: string, mode: 'SOFT' | 'HARD', actor = 'coordinator'): TaskRecord {
    return this.database.transaction(() => {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      const timestamp = this.nowIso();
      if (task.state === 'PENDING' || task.state === 'BLOCKED') {
        this.database.run(
          `UPDATE tasks SET state='CANCELLED', interrupt_mode=?, interrupt_requested_at=?,
           block_reason='USER_CANCEL', updated_at=? WHERE task_id=?`,
          [mode, timestamp, timestamp, taskId],
        );
      } else if (task.state === 'LEASED' || task.state === 'RUNNING') {
        if (mode === 'HARD') {
          this.database.run(
            `UPDATE tasks SET state='CANCELLED', interrupt_mode='HARD', interrupt_requested_at=?,
             lease_owner=NULL, lease_expires_at=NULL, active_attempt_id=NULL,
             block_reason='USER_CANCEL', updated_at=? WHERE task_id=?`,
            [timestamp, timestamp, taskId],
          );
          if (task.activeAttemptId) {
            this.database.run(
              `UPDATE task_attempts SET state='CANCELLED', finished_at=?, updated_at=? WHERE attempt_id=?`,
              [timestamp, timestamp, task.activeAttemptId],
            );
          }
        } else {
          this.database.run(
            `UPDATE tasks SET interrupt_mode='SOFT', interrupt_requested_at=?, updated_at=? WHERE task_id=?`,
            [timestamp, timestamp, taskId],
          );
        }
      } else if (task.state === 'SUCCEEDED') {
        this.database.run("UPDATE tasks SET state='STALE', updated_at=? WHERE task_id=?", [timestamp, taskId]);
        this.database.run(
          `UPDATE artifacts SET state='STALE', stale_reason='USER_CANCEL', updated_at=?
           WHERE task_id=? AND state='ACTIVE'`,
          [timestamp, taskId],
        );
      }
      this.appendProjectEvent(task.projectId, mode === 'HARD' ? 'TASK_HARD_CANCEL' : 'TASK_SOFT_INTERRUPT', actor, {
        previousState: task.state,
      }, taskId, task.activeAttemptId ?? undefined);
      return taskFromRow(this.database.get<SqlRow>('SELECT * FROM tasks WHERE task_id=?', [taskId])!);
    });
  }

  applyInstruction(input: ApplyInstructionInput): InstructionApplicationResult {
    return this.database.transaction(() => {
      const duplicate = this.database.get<SqlRow>(
        'SELECT * FROM instruction_events WHERE project_id=? AND session_message_id=?',
        [input.projectId, input.sessionMessageId],
      );
      if (duplicate) {
        const instruction = instructionFromRow(duplicate);
        const resultEvent = this.database.get<SqlRow>(
          `SELECT payload_json FROM project_events
           WHERE project_id=? AND event_type='INSTRUCTION_APPLIED'
             AND json_extract(payload_json, '$.instructionEventId')=?
           ORDER BY created_at DESC LIMIT 1`,
          [input.projectId, instruction.eventId],
        );
        if (!resultEvent) throw new Error('Instruction exists without its atomic application event');
        const stored = parseJson<Omit<InstructionApplicationResult, 'instruction'>>(
          resultEvent['payload_json'],
          'instruction application event',
        );
        return { instruction, ...stored };
      }

      const project = this.requireProject(input.projectId);
      const version = project.instructionVersion + 1;
      const eventId = input.eventId ?? randomUUID();
      assertIdentifier('instruction eventId', eventId);
      const mode = input.interruptMode ?? 'SOFT';
      const timestamp = this.nowIso();
      this.database.run(
        `INSERT INTO instruction_events(
          event_id,project_id,session_message_id,instruction_version,message,affected_scope_json,
          interrupt_mode,schema_version,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          eventId,
          input.projectId,
          input.sessionMessageId,
          version,
          input.message,
          canonicalJson(input.affectedScope),
          mode,
          CURRENT_SCHEMA_VERSION,
          timestamp,
        ],
      );
      const bumped = this.database.run(
        `UPDATE projects SET instruction_version=?, updated_at=?
         WHERE project_id=? AND instruction_version=?`,
        [version, timestamp, input.projectId, project.instructionVersion],
      );
      if (bumped.changes !== 1) throw new Error('Concurrent instruction update; retry with the persisted message ID');

      const allTasks = this.listTasks(input.projectId);
      const affectedIds = new Set(input.affectedScope.affectedTaskIds);
      for (const task of allTasks) {
        if (this.taskMatchesAffectedScope(task, input.affectedScope)) affectedIds.add(task.taskId);
      }
      const continuedTaskIds: string[] = [];
      const cancelledTaskIds: string[] = [];
      const interruptedTaskIds: string[] = [];
      const staleTaskIds: string[] = [];
      for (const task of allTasks) {
        if (!affectedIds.has(task.taskId)) {
          if (task.state === 'PENDING' || task.state === 'LEASED' || task.state === 'RUNNING') {
            continuedTaskIds.push(task.taskId);
          }
          continue;
        }
        if (task.state === 'SUCCEEDED') {
          this.database.run("UPDATE tasks SET state='STALE', updated_at=? WHERE task_id=?", [timestamp, task.taskId]);
          this.database.run(
            `UPDATE artifacts SET state='STALE', stale_reason=?, updated_at=?
             WHERE task_id=? AND state='ACTIVE'`,
            [`INSTRUCTION:${eventId}`, timestamp, task.taskId],
          );
          staleTaskIds.push(task.taskId);
        } else if (task.state === 'PENDING' || task.state === 'BLOCKED') {
          this.database.run(
            `UPDATE tasks SET state='CANCELLED', interrupt_mode=?, interrupt_requested_at=?,
             block_reason=?, updated_at=? WHERE task_id=?`,
            [mode, timestamp, `INSTRUCTION:${eventId}`, timestamp, task.taskId],
          );
          cancelledTaskIds.push(task.taskId);
        } else if (task.state === 'LEASED' || task.state === 'RUNNING') {
          if (mode === 'HARD') {
            this.database.run(
              `UPDATE tasks SET state='CANCELLED', interrupt_mode='HARD', interrupt_requested_at=?,
               lease_owner=NULL, lease_expires_at=NULL, active_attempt_id=NULL,
               block_reason=?, updated_at=? WHERE task_id=?`,
              [timestamp, `INSTRUCTION:${eventId}`, timestamp, task.taskId],
            );
            if (task.activeAttemptId) {
              this.database.run(
                `UPDATE task_attempts SET state='CANCELLED', finished_at=?, updated_at=? WHERE attempt_id=?`,
                [timestamp, timestamp, task.activeAttemptId],
              );
            }
            cancelledTaskIds.push(task.taskId);
          } else {
            this.database.run(
              `UPDATE tasks SET interrupt_mode='SOFT', interrupt_requested_at=?, block_reason=?, updated_at=?
               WHERE task_id=?`,
              [timestamp, `INSTRUCTION:${eventId}`, timestamp, task.taskId],
            );
            interruptedTaskIds.push(task.taskId);
          }
        }
      }

      this.markKnowledgeStaleForScope(input.projectId, input.affectedScope, eventId, timestamp);
      const replacementTaskIds: string[] = [];
      for (const replacement of input.replacementTasks ?? []) {
        const ensured = this.ensureTaskInternal({
          ...replacement,
          projectId: input.projectId,
          instructionVersion: version,
        });
        replacementTaskIds.push(ensured.task.taskId);
      }

      const instruction = instructionFromRow(
        this.database.get<SqlRow>('SELECT * FROM instruction_events WHERE event_id=?', [eventId])!,
      );
      const resultPayload = {
        instructionEventId: eventId,
        continuedTaskIds,
        cancelledTaskIds,
        interruptedTaskIds,
        staleTaskIds,
        replacementTaskIds,
      };
      this.appendProjectEvent(input.projectId, 'INSTRUCTION_APPLIED', 'coordinator', resultPayload);
      return {
        instruction,
        continuedTaskIds,
        cancelledTaskIds,
        interruptedTaskIds,
        staleTaskIds,
        replacementTaskIds,
      };
    });
  }

  listInstructionEvents(projectId: string): InstructionEventRecord[] {
    return this.database
      .all<SqlRow>(
        'SELECT * FROM instruction_events WHERE project_id=? ORDER BY instruction_version',
        [projectId],
      )
      .map(instructionFromRow);
  }

  readoptArtifact(artifactId: string, instructionEventId: string, actor = 'coordinator'): ArtifactRecord {
    return this.database.transaction(() => {
      const artifact = this.getArtifact(artifactId);
      if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
      if (artifact.state !== 'STALE') throw new Error('Only a stale artifact can be explicitly re-adopted');
      const task = this.getTask(artifact.taskId);
      if (!task) throw new Error('Artifact task is missing');
      const instruction = this.database.get<SqlRow>(
        'SELECT * FROM instruction_events WHERE event_id=? AND project_id=?',
        [instructionEventId, artifact.projectId],
      );
      if (!instruction) throw new Error('Explicit persisted instruction is required to re-adopt stale output');
      const project = this.requireProject(artifact.projectId);
      const decision = instructionFromRow(instruction);
      if (
        decision.instructionVersion !== project.instructionVersion ||
        decision.createdAt < artifact.updatedAt ||
        !this.taskMatchesAffectedScope(task, decision.affectedScope) ||
        !/(?:re-?adopt|restore|重新采用|恢复|接受).*(?:artifact|产物|结果|旧)/iu.test(decision.message)
      ) {
        throw new Error('Current instruction does not explicitly authorize re-adopting this artifact');
      }
      const timestamp = this.nowIso();
      this.database.run(
        `UPDATE artifacts SET state='ACTIVE', stale_reason=NULL, readopted_by_event_id=?, updated_at=?
         WHERE artifact_id=?`,
        [instructionEventId, timestamp, artifactId],
      );
      this.database.run(
        `UPDATE tasks SET state='SUCCEEDED', block_reason=NULL, updated_at=? WHERE task_id=?`,
        [timestamp, task.taskId],
      );
      this.appendProjectEvent(artifact.projectId, 'ARTIFACT_READOPTED', actor, {
        artifactId,
        instructionEventId,
        originalInstructionVersion: artifact.instructionVersion,
      }, task.taskId, artifact.attemptId);
      return artifactFromRow(this.database.get<SqlRow>('SELECT * FROM artifacts WHERE artifact_id=?', [artifactId])!);
    });
  }

  validateArtifactForMerge(input: MergeValidationInput): ArtifactRecord {
    const artifact = this.getArtifact(input.artifactId);
    if (!artifact || artifact.projectId !== input.projectId) throw new Error('Artifact is not in this project');
    if (artifact.state !== 'ACTIVE') throw new Error(`Merger rejects ${artifact.state.toLowerCase()} artifacts`);
    const task = this.getTask(artifact.taskId);
    if (!task || task.state !== 'SUCCEEDED') throw new Error('Artifact task has not succeeded');
    if (artifact.promptVersion !== task.promptVersion || artifact.contextHash !== task.contextHash) {
      throw new Error('Artifact prompt/context provenance differs from its task');
    }
    if (artifact.instructionVersion !== task.instructionVersion) {
      throw new Error('Artifact instruction version differs from its task');
    }
    if (artifact.instructionVersion !== input.expectedInstructionVersion) {
      throw new Error('Artifact does not match the merger plan instruction version');
    }
    if (input.expectedPromptVersion !== undefined && artifact.promptVersion !== input.expectedPromptVersion) {
      throw new Error('Artifact does not match the expected prompt version');
    }
    if (input.expectedContextHash !== undefined && artifact.contextHash !== input.expectedContextHash) {
      throw new Error('Artifact does not match the expected context hash');
    }
    if (input.expectedSourceHashes && !sameStringSet(artifact.sourceHashes, input.expectedSourceHashes)) {
      throw new Error('Artifact source hashes do not match the merger source set');
    }
    const paragraphIds = artifact.provenance.paragraphIds ?? [];
    if (input.expectedParagraphIds && !sameStringSet(paragraphIds, input.expectedParagraphIds)) {
      throw new Error('Artifact paragraph IDs do not match the merger plan');
    }
    const oldHashes = artifact.provenance.oldTranslationHashes ?? {};
    if (
      input.expectedOldTranslationHashes &&
      canonicalJson(oldHashes) !== canonicalJson(input.expectedOldTranslationHashes)
    ) {
      throw new Error('Patch old-translation hashes no longer match the merge base');
    }
    const openConflict = this.database.get<SqlRow>(
      `SELECT conflict_id FROM merge_conflicts
       WHERE project_id=? AND state='OPEN'
         AND paragraph_id IN (
           SELECT value FROM json_each(?)
         ) LIMIT 1`,
      [input.projectId, canonicalJson(paragraphIds)],
    );
    if (openConflict) throw new Error(`Unresolved patch conflict: ${requiredString(openConflict['conflict_id'], 'conflict_id')}`);
    const project = this.requireProject(input.projectId);
    const store = new ImmutableArtifactStore(project.artifactRootPath);
    if (!store.verify(artifact.filePath, artifact.envelopeHash)) {
      throw new Error('Artifact file is missing or its envelope hash changed');
    }
    const envelope = JSON.parse(readFileSync(artifact.filePath, 'utf8')) as ArtifactEnvelope;
    if (
      envelope.artifactId !== artifact.artifactId ||
      envelope.taskId !== artifact.taskId ||
      envelope.attemptId !== artifact.attemptId ||
      envelope.payloadHash !== artifact.payloadHash ||
      hashCanonical(envelope.payload) !== artifact.payloadHash
    ) {
      throw new Error('Artifact envelope or payload hash is invalid');
    }
    return artifact;
  }

  acquireMergerLease(projectId: string, owner: string, leaseDurationMs: number): MergerLeaseToken | undefined {
    assertIdentifier('merger owner', owner);
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be a positive safe integer');
    }
    return this.database.transaction(() => {
      this.requireProject(projectId);
      const timestamp = this.nowIso();
      const expires = new Date(this.now().getTime() + leaseDurationMs).toISOString();
      const existing = this.database.get<SqlRow>('SELECT * FROM merger_leases WHERE project_id=?', [projectId]);
      if (existing) {
        const oldOwner = requiredString(existing['lease_owner'], 'lease_owner');
        const oldExpiry = requiredString(existing['lease_expires_at'], 'lease_expires_at');
        if (oldOwner !== owner && oldExpiry > timestamp) return undefined;
        this.database.run(
          `UPDATE merger_leases SET lease_owner=?, lease_expires_at=?, generation=generation+1,
           updated_at=? WHERE project_id=?`,
          [owner, expires, timestamp, projectId],
        );
      } else {
        this.database.run(
          `INSERT INTO merger_leases(
             project_id,lease_owner,lease_expires_at,generation,schema_version,created_at,updated_at
           ) VALUES(?,?,?,1,?,?,?)`,
          [projectId, owner, expires, CURRENT_SCHEMA_VERSION, timestamp, timestamp],
        );
      }
      const lease = this.database.get<SqlRow>('SELECT * FROM merger_leases WHERE project_id=?', [projectId]);
      if (!lease) throw new Error('Merger lease disappeared during acquisition');
      this.appendProjectEvent(projectId, 'MERGER_LEASE_ACQUIRED', owner, { expires });
      return {
        projectId,
        owner,
        generation: requiredNumber(lease['generation'], 'merger lease generation'),
        expiresAt: expires,
      };
    });
  }

  renewMergerLease(lease: MergerLeaseToken, leaseDurationMs: number): MergerLeaseToken {
    return this.database.transaction(() => {
      const timestamp = this.nowIso();
      const expires = new Date(this.now().getTime() + leaseDurationMs).toISOString();
      const updated = this.database.run(
        `UPDATE merger_leases SET lease_expires_at=?, updated_at=?
         WHERE project_id=? AND lease_owner=? AND generation=? AND lease_expires_at>?`,
        [expires, timestamp, lease.projectId, lease.owner, lease.generation, timestamp],
      );
      if (updated.changes !== 1) throw new Error('Merger lease is absent, expired, or owned by another process');
      const current = this.database.get<SqlRow>(
        'SELECT generation FROM merger_leases WHERE project_id=? AND lease_owner=? AND generation=?',
        [lease.projectId, lease.owner, lease.generation],
      );
      if (!current) throw new Error('Merger fencing token is stale');
      return { ...lease, expiresAt: expires };
    });
  }

  releaseMergerLease(lease: MergerLeaseToken): void {
    this.database.transaction(() => {
      const released = this.database.run(
        'DELETE FROM merger_leases WHERE project_id=? AND lease_owner=? AND generation=?',
        [lease.projectId, lease.owner, lease.generation],
      );
      if (released.changes !== 1) throw new Error('Merger lease is not owned by this process');
      this.appendProjectEvent(lease.projectId, 'MERGER_LEASE_RELEASED', lease.owner, {
        generation: lease.generation,
      });
    });
  }

  recordCostEvent(input: CostEventInput): string {
    const integers: Array<[string, number]> = [
      ['inputTokens', input.inputTokens],
      ['outputTokens', input.outputTokens],
      ['reasoningTokens', input.reasoningTokens ?? 0],
      ['cachedTokens', input.cachedTokens ?? 0],
      ['latencyMs', input.latencyMs],
      ['actualCostMicros', input.actualCostMicros],
    ];
    for (const [name, value] of integers) assertNonNegativeInteger(name, value);
    return this.database.transaction(() => {
      const task = this.getTask(input.taskId);
      if (!task || task.projectId !== input.projectId) throw new Error('Cost task is not in this project');
      const project = this.requireProject(input.projectId);
      if (input.stage !== task.stage || input.modelId !== task.modelId || input.providerId !== project.providerId) {
        throw new Error('Cost provider/model/stage provenance differs from its task/project');
      }
      const attempt = this.database.get<SqlRow>('SELECT * FROM task_attempts WHERE attempt_id=? AND task_id=?', [
        input.attemptId,
        input.taskId,
      ]);
      if (!attempt) throw new Error('Cost attempt is not in this task');
      const attemptRequestId = optionalString(attempt['provider_request_id']);
      if (attemptRequestId && attemptRequestId !== input.providerRequestId) {
        throw new Error('Cost provider request identity differs from its attempt');
      }
      const costEventId = input.costEventId ?? randomUUID();
      assertIdentifier('costEventId', costEventId);
      const existingById = this.database.get<SqlRow>('SELECT * FROM cost_events WHERE cost_event_id=?', [costEventId]);
      if (existingById) {
        this.assertMatchingCostReplay(existingById, input);
        return costEventId;
      }
      if (input.providerRequestId) {
        const duplicate = this.database.get<SqlRow>(
          'SELECT * FROM cost_events WHERE project_id=? AND provider_request_id=?',
          [input.projectId, input.providerRequestId],
        );
        if (duplicate) {
          this.assertMatchingCostReplay(duplicate, input);
          return requiredString(duplicate['cost_event_id'], 'cost_event_id');
        }
      }
      this.database.run(
        `INSERT INTO cost_events(
          cost_event_id,project_id,task_id,attempt_id,stage,provider_id,model_id,provider_request_id,
          input_tokens,output_tokens,reasoning_tokens,cached_tokens,latency_ms,price_snapshot_json,
          actual_cost_micros,retry_reason,prompt_fingerprint,context_fingerprint,
          instruction_fingerprint,billable,discarded,schema_version,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          costEventId,
          input.projectId,
          input.taskId,
          input.attemptId,
          input.stage,
          input.providerId,
          input.modelId,
          input.providerRequestId ?? null,
          input.inputTokens,
          input.outputTokens,
          input.reasoningTokens ?? 0,
          input.cachedTokens ?? 0,
          input.latencyMs,
          canonicalJson(input.priceSnapshot),
          input.actualCostMicros,
          input.retryReason ?? null,
          input.promptFingerprint,
          input.contextFingerprint,
          input.instructionFingerprint,
          input.billable === false ? 0 : 1,
          input.discarded === true ? 1 : 0,
          CURRENT_SCHEMA_VERSION,
          this.nowIso(),
        ],
      );
      if (input.discarded) {
        this.database.run(
          `UPDATE task_attempts SET discarded_cost_micros=discarded_cost_micros+?, updated_at=?
           WHERE attempt_id=?`,
          [input.actualCostMicros, this.nowIso(), input.attemptId],
        );
      }
      const budget = this.getBudgetStatus(input.projectId);
      if (budget.softExceeded || budget.hardExceeded || budget.blockedStages.length > 0) {
        this.appendProjectEvent(input.projectId, 'BUDGET_THRESHOLD_REACHED', 'ledger', {
          costEventId,
          softExceeded: budget.softExceeded,
          hardExceeded: budget.hardExceeded,
          blockedStages: budget.blockedStages,
        }, input.taskId, input.attemptId);
      }
      return costEventId;
    });
  }

  recordSyntheticUsageEvent(input: SyntheticUsageEventInput): SyntheticUsageEventResult {
    return this.database.transaction(() => {
      const project = this.requireProject(input.projectId);
      const eventFingerprint = hashCanonical({
        eventId: input.eventId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        turnId: input.turnId,
        step: input.step,
        modelId: input.modelId,
        providerId: input.providerId,
        traceId: input.traceId ?? null,
      });
      const taskId = `usage_${eventFingerprint.slice(0, 40)}`;
      const attemptId = `usage_attempt_${eventFingerprint.slice(0, 40)}`;
      const costEventId = `usage_cost_${eventFingerprint.slice(0, 40)}`;
      const existingCost = this.database.get<SqlRow>(
        'SELECT cost_event_id FROM cost_events WHERE project_id=? AND cost_event_id=?',
        [input.projectId, costEventId],
      );
      if (existingCost) {
        return {
          costEventId,
          taskId,
          attemptId,
          reused: true,
          budget: this.getBudgetStatus(input.projectId),
        };
      }
      const scope = {
        sessionId: input.sessionId,
        agentId: input.agentId,
        turnId: input.turnId,
        step: input.step,
        eventId: input.eventId,
      };
      const ensured = this.ensureTaskInternal({
        taskId,
        projectId: input.projectId,
        taskType: 'usage-accounting',
        scope,
        scopeHash: hashCanonical(scope),
        promptVersion: 'usage-event-v1',
        instructionVersion: project.instructionVersion,
        contextHash: hashCanonical({ sessionId: input.sessionId, agentId: input.agentId, turnId: input.turnId }),
        modelId: input.modelId,
        decodingConfigHash: hashCanonical({ notApplicable: true }),
        costClass: 'LOCAL',
        stage: input.stage ?? 'translation',
        maxAttempts: 1,
      });
      if (ensured.task.state === 'PENDING') {
        const timestamp = this.nowIso();
        this.database.run(
          `INSERT INTO task_attempts(
            attempt_id,project_id,task_id,attempt_number,state,worker_id,instruction_version,
            idempotency_key,provider_request_id,started_at,finished_at,schema_version,created_at,updated_at
          ) VALUES(?,?,?,?,'SUCCEEDED','usage-recorder',?,?,?,?,?,?,?,?)`,
          [
            attemptId,
            input.projectId,
            taskId,
            1,
            project.instructionVersion,
            ensured.task.idempotencyKey,
            null,
            timestamp,
            timestamp,
            CURRENT_SCHEMA_VERSION,
            timestamp,
            timestamp,
          ],
        );
        this.database.run("UPDATE tasks SET state='SUCCEEDED', updated_at=? WHERE task_id=?", [timestamp, taskId]);
        this.appendProjectEvent(input.projectId, 'SYNTHETIC_USAGE_TASK_RECORDED', 'usage-recorder', {
          sourceEventId: input.eventId,
          sessionId: input.sessionId,
          agentId: input.agentId,
          turnId: input.turnId,
          step: input.step,
          traceId: input.traceId ?? null,
        }, taskId, attemptId);
      }
      const recordedCostId = this.recordCostEvent({
        costEventId,
        projectId: input.projectId,
        taskId,
        attemptId,
        stage: input.stage ?? 'translation',
        providerId: input.providerId,
        modelId: input.modelId,
        providerRequestId: null,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        reasoningTokens: input.reasoningTokens ?? 0,
        cachedTokens: input.cachedTokens ?? 0,
        latencyMs: input.latencyMs ?? 0,
        priceSnapshot: input.priceSnapshot,
        actualCostMicros: input.actualCostMicros,
        retryReason: input.retryReason ?? null,
        promptFingerprint: hashCanonical({ eventId: input.eventId, kind: 'prompt' }),
        contextFingerprint: hashCanonical({ sessionId: input.sessionId, turnId: input.turnId }),
        instructionFingerprint: hashCanonical({ instructionVersion: project.instructionVersion }),
        billable: true,
        discarded: false,
      });
      return {
        costEventId: recordedCostId,
        taskId,
        attemptId,
        reused: false,
        budget: this.getBudgetStatus(input.projectId),
      };
    });
  }

  getBudgetStatus(projectId: string): BudgetStatus {
    const project = this.requireProject(projectId);
    const actual = requiredNumber(
      this.database.get<SqlRow>(
        'SELECT COALESCE(SUM(actual_cost_micros),0) AS total FROM cost_events WHERE project_id=? AND billable=1',
        [projectId],
      )?.['total'] ?? 0,
      'actual cost',
    );
    const stageRows = this.database.all<SqlRow>(
      `SELECT stage, COALESCE(SUM(actual_cost_micros),0) AS total
       FROM cost_events WHERE project_id=? AND billable=1 GROUP BY stage`,
      [projectId],
    );
    const stageCostMicros: Record<string, number> = {};
    for (const row of stageRows) {
      stageCostMicros[requiredString(row['stage'], 'stage')] = requiredNumber(row['total'], 'stage cost');
    }
    const blockedStages = Object.entries(project.perStageBudgetMicros)
      .filter(([stage, limit]) => (stageCostMicros[stage] ?? 0) >= limit)
      .map(([stage]) => stage)
      .sort();
    return {
      projectId,
      actualCostMicros: actual,
      softBudgetMicros: project.softBudgetMicros,
      hardBudgetMicros: project.hardBudgetMicros,
      stageCostMicros,
      perStageBudgetMicros: project.perStageBudgetMicros,
      softExceeded: project.softBudgetMicros !== null && actual >= project.softBudgetMicros,
      hardExceeded: project.hardBudgetMicros !== null && actual >= project.hardBudgetMicros,
      blockedStages,
    };
  }

  recordMemory(input: MemoryRecordInput): string {
    this.assertCurrentInstruction(input.projectId, input.instructionVersion);
    const memoryId = input.memoryId ?? randomUUID();
    assertIdentifier('memoryId', memoryId);
    const contentHash = hashCanonical({
      memoryType: input.memoryType,
      chapterId: input.chapterId ?? null,
      paragraphIds: input.paragraphIds ?? [],
      entities: input.entities ?? [],
      summary: input.summary,
      importance: input.importance,
      confidence: input.confidence,
      sourceProvenance: input.sourceProvenance,
    });
    const timestamp = this.nowIso();
    this.database.run(
      `INSERT OR IGNORE INTO memory_records(
        memory_id,project_id,memory_type,chapter_id,paragraph_ids_json,entities_json,summary,
        importance,confidence,source_provenance_json,instruction_version,state,content_hash,
        schema_version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)`,
      [
        memoryId,
        input.projectId,
        input.memoryType,
        input.chapterId ?? null,
        canonicalJson(input.paragraphIds ?? []),
        canonicalJson(input.entities ?? []),
        input.summary,
        input.importance,
        input.confidence,
        canonicalJson(input.sourceProvenance),
        input.instructionVersion,
        contentHash,
        CURRENT_SCHEMA_VERSION,
        timestamp,
        timestamp,
      ],
    );
    const row = this.database.get<SqlRow>(
      'SELECT memory_id FROM memory_records WHERE project_id=? AND content_hash=? AND instruction_version=?',
      [input.projectId, contentHash, input.instructionVersion],
    );
    return requiredString(row?.['memory_id'], 'memory_id');
  }

  recordCanonicalEntity(input: CanonicalEntityInput): string {
    this.assertCurrentInstruction(input.projectId, input.instructionVersion);
    const recordId = input.canonicalRecordId ?? randomUUID();
    assertIdentifier('canonicalRecordId', recordId);
    const contentHash = hashCanonical({
      entityKey: input.entityKey,
      entityType: input.entityType,
      canonicalValue: input.canonicalValue,
      aliases: input.aliases ?? [],
      sourceProvenance: input.sourceProvenance,
    });
    const timestamp = this.nowIso();
    return this.database.transaction(() => {
      const duplicate = this.database.get<SqlRow>(
        `SELECT canonical_record_id FROM canonical_entities
         WHERE project_id=? AND entity_key=? AND instruction_version=? AND content_hash=?`,
        [input.projectId, input.entityKey, input.instructionVersion, contentHash],
      );
      if (duplicate) return requiredString(duplicate['canonical_record_id'], 'canonical_record_id');
      this.database.run(
        `UPDATE canonical_entities SET state='SUPERSEDED', updated_at=?
         WHERE project_id=? AND entity_key=? AND state='ACTIVE'`,
        [timestamp, input.projectId, input.entityKey],
      );
      this.database.run(
        `INSERT OR IGNORE INTO canonical_entities(
          canonical_record_id,project_id,entity_key,entity_type,canonical_value_json,aliases_json,
          source_provenance_json,instruction_version,state,content_hash,schema_version,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)`,
        [
          recordId,
          input.projectId,
          input.entityKey,
          input.entityType,
          canonicalJson(input.canonicalValue),
          canonicalJson(input.aliases ?? []),
          canonicalJson(input.sourceProvenance),
          input.instructionVersion,
          contentHash,
          CURRENT_SCHEMA_VERSION,
          timestamp,
          timestamp,
        ],
      );
      const row = this.database.get<SqlRow>(
        `SELECT canonical_record_id FROM canonical_entities
         WHERE project_id=? AND entity_key=? AND instruction_version=? AND content_hash=?`,
        [input.projectId, input.entityKey, input.instructionVersion, contentHash],
      );
      return requiredString(row?.['canonical_record_id'], 'canonical_record_id');
    });
  }

  recordTranslationMemory(input: TranslationMemoryInput): string {
    const project = this.assertCurrentInstruction(input.projectId, input.instructionVersion);
    if (input.modelId !== project.modelId || input.providerId !== project.providerId) {
      throw new Error('Translation memory provenance differs from the project model/provider pin');
    }
    if (input.paragraphId) this.assertRelatedRowProject('paragraphs', 'paragraph_id', input.paragraphId, input.projectId);
    const tmRecordId = input.tmRecordId ?? randomUUID();
    assertIdentifier('tmRecordId', tmRecordId);
    assertHash('sourceHash', input.sourceHash);
    const targetHash = sha256Text(input.targetText);
    const fingerprint = hashCanonical({
      sourceHash: input.sourceHash,
      targetHash,
      approval: input.approval,
      providerId: input.providerId,
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      instructionVersion: input.instructionVersion,
    });
    const timestamp = this.nowIso();
    this.database.run(
      `INSERT OR IGNORE INTO translation_memory_records(
        tm_record_id,project_id,paragraph_id,source_hash,target_text,target_hash,approval,provider_id,
        model_id,prompt_version,instruction_version,provenance_json,state,fingerprint,
        schema_version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE',?,?,?,?)`,
      [
        tmRecordId,
        input.projectId,
        input.paragraphId ?? null,
        input.sourceHash,
        input.targetText,
        targetHash,
        input.approval,
        input.providerId,
        input.modelId,
        input.promptVersion,
        input.instructionVersion,
        canonicalJson(input.provenance),
        fingerprint,
        CURRENT_SCHEMA_VERSION,
        timestamp,
        timestamp,
      ],
    );
    const row = this.database.get<SqlRow>(
      'SELECT tm_record_id FROM translation_memory_records WHERE project_id=? AND fingerprint=?',
      [input.projectId, fingerprint],
    );
    return requiredString(row?.['tm_record_id'], 'tm_record_id');
  }

  recordReviewIssue(input: ReviewIssueInput): string {
    this.assertCurrentInstruction(input.projectId, input.instructionVersion);
    if (input.taskId) this.assertRelatedRowProject('tasks', 'task_id', input.taskId, input.projectId);
    const issueId = input.issueId ?? randomUUID();
    assertIdentifier('issueId', issueId);
    const timestamp = this.nowIso();
    this.database.run(
      `INSERT INTO review_issues(
        issue_id,project_id,task_id,chapter_id,paragraph_ids_json,category,severity,
        source_evidence_ids_json,target_evidence_ids_json,story_memory_ids_json,explanation,
        suggested_action,status,instruction_version,schema_version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?)`,
      [
        issueId,
        input.projectId,
        input.taskId ?? null,
        input.chapterId ?? null,
        canonicalJson(input.paragraphIds ?? []),
        input.category,
        input.severity,
        canonicalJson(input.sourceEvidenceIds ?? []),
        canonicalJson(input.targetEvidenceIds ?? []),
        canonicalJson(input.storyMemoryIds ?? []),
        input.explanation,
        input.suggestedAction,
        input.instructionVersion,
        CURRENT_SCHEMA_VERSION,
        timestamp,
        timestamp,
      ],
    );
    return issueId;
  }

  resolveReviewIssue(
    projectId: string,
    issueId: string,
    resolutionEventId: string,
    status: 'RESOLVED' | 'ACCEPTED',
    actor = 'coordinator',
  ): void {
    this.database.transaction(() => {
      const updated = this.database.run(
        `UPDATE review_issues SET status=?, resolution_event_id=?, updated_at=?
         WHERE issue_id=? AND project_id=? AND status='OPEN'`,
        [status, resolutionEventId, this.nowIso(), issueId, projectId],
      );
      if (updated.changes !== 1) throw new Error('Review issue is missing or no longer open');
      this.appendProjectEvent(projectId, 'REVIEW_ISSUE_RESOLVED', actor, {
        issueId,
        status,
        resolutionEventId,
      });
    });
  }

  recordRepairPatch(input: RepairPatchInput): string {
    this.assertCurrentInstruction(input.projectId, input.instructionVersion);
    this.assertRelatedRowProject('review_issues', 'issue_id', input.issueId, input.projectId);
    this.assertRelatedRowProject('paragraphs', 'paragraph_id', input.paragraphId, input.projectId);
    if (input.taskId) this.assertRelatedRowProject('tasks', 'task_id', input.taskId, input.projectId);
    const patchId = input.patchId ?? randomUUID();
    assertIdentifier('patchId', patchId);
    assertHash('oldTranslationHash', input.oldTranslationHash);
    const newTranslationHash = sha256Text(input.newTranslation);
    const timestamp = this.nowIso();
    this.database.run(
      `INSERT OR IGNORE INTO repair_patches(
        patch_id,project_id,issue_id,task_id,paragraph_id,old_translation_hash,new_translation,
        new_translation_hash,reason,state,instruction_version,provenance_json,
        schema_version,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'PROPOSED',?,?,?,?,?)`,
      [
        patchId,
        input.projectId,
        input.issueId,
        input.taskId ?? null,
        input.paragraphId,
        input.oldTranslationHash,
        input.newTranslation,
        newTranslationHash,
        input.reason,
        input.instructionVersion,
        canonicalJson(input.provenance),
        CURRENT_SCHEMA_VERSION,
        timestamp,
        timestamp,
      ],
    );
    const row = this.database.get<SqlRow>(
      `SELECT patch_id FROM repair_patches
       WHERE project_id=? AND issue_id=? AND paragraph_id=? AND new_translation_hash=?`,
      [input.projectId, input.issueId, input.paragraphId, newTranslationHash],
    );
    return requiredString(row?.['patch_id'], 'patch_id');
  }

  createMergeConflict(input: MergeConflictInput, mergerLease: MergerLeaseToken): string {
    this.assertCurrentInstruction(input.projectId, input.instructionVersion);
    this.assertRelatedRowProject('paragraphs', 'paragraph_id', input.paragraphId, input.projectId);
    if (input.patchIds.length < 2) throw new Error('A merge conflict requires at least two patches');
    const conflictId = input.conflictId ?? randomUUID();
    assertIdentifier('conflictId', conflictId);
    assertHash('baseTranslationHash', input.baseTranslationHash);
    const timestamp = this.nowIso();
    this.database.transaction(() => {
      this.assertMergerLease(mergerLease, input.projectId);
      for (const patchId of input.patchIds) {
        const patch = this.database.get<SqlRow>(
          'SELECT project_id,paragraph_id FROM repair_patches WHERE patch_id=?',
          [patchId],
        );
        if (!patch || patch['project_id'] !== input.projectId || patch['paragraph_id'] !== input.paragraphId) {
          throw new Error(`Conflict patch ${patchId} is not for this project/paragraph`);
        }
      }
      this.database.run(
        `INSERT INTO merge_conflicts(
          conflict_id,project_id,paragraph_id,patch_ids_json,base_translation_hash,state,
          instruction_version,schema_version,created_at,updated_at
        ) VALUES(?,?,?,?,?,'OPEN',?,?,?,?)`,
        [
          conflictId,
          input.projectId,
          input.paragraphId,
          canonicalJson(input.patchIds),
          input.baseTranslationHash,
          input.instructionVersion,
          CURRENT_SCHEMA_VERSION,
          timestamp,
          timestamp,
        ],
      );
      this.appendProjectEvent(input.projectId, 'MERGE_CONFLICT_CREATED', 'merger', {
        conflictId,
        paragraphId: input.paragraphId,
        patchIds: input.patchIds,
      });
    });
    return conflictId;
  }

  resolveMergeConflict(options: {
    projectId: string;
    conflictId: string;
    selectedPatchId: string;
    arbitrationArtifactId: string;
    resolution: Record<string, unknown>;
    mergerLease: MergerLeaseToken;
    actor?: string;
  }): void {
    this.database.transaction(() => {
      this.assertMergerLease(options.mergerLease, options.projectId);
      const conflict = this.database.get<SqlRow>('SELECT * FROM merge_conflicts WHERE conflict_id=?', [
        options.conflictId,
      ]);
      if (!conflict || conflict['project_id'] !== options.projectId || conflict['state'] !== 'OPEN') {
        throw new Error('Merge conflict is missing or no longer open');
      }
      const patchIds = parseJson<string[]>(conflict['patch_ids_json'], 'patch_ids_json');
      if (!patchIds.includes(options.selectedPatchId)) throw new Error('Selected patch is not in this conflict');
      this.validateArtifactForMerge({
        artifactId: options.arbitrationArtifactId,
        projectId: options.projectId,
        expectedInstructionVersion: requiredNumber(conflict['instruction_version'], 'instruction_version'),
      });
      const timestamp = this.nowIso();
      this.database.run(
        `UPDATE merge_conflicts SET state='RESOLVED', selected_patch_id=?, arbitration_artifact_id=?,
         resolution_json=?, updated_at=? WHERE conflict_id=?`,
        [
          options.selectedPatchId,
          options.arbitrationArtifactId,
          canonicalJson(options.resolution),
          timestamp,
          options.conflictId,
        ],
      );
      this.database.run(
        `UPDATE repair_patches SET state=CASE WHEN patch_id=? THEN 'SELECTED' ELSE 'REJECTED' END,
         updated_at=? WHERE patch_id IN (SELECT value FROM json_each(?))`,
        [options.selectedPatchId, timestamp, canonicalJson(patchIds)],
      );
      this.appendProjectEvent(options.projectId, 'MERGE_CONFLICT_RESOLVED', options.actor ?? 'arbitrator', {
        conflictId: options.conflictId,
        selectedPatchId: options.selectedPatchId,
        arbitrationArtifactId: options.arbitrationArtifactId,
      });
    });
  }

  recordIndexVersion(input: IndexVersionInput): string {
    const indexVersionId = input.indexVersionId ?? randomUUID();
    assertIdentifier('indexVersionId', indexVersionId);
    const timestamp = this.nowIso();
    return this.database.transaction(() => {
      if (input.state === 'CURRENT') {
        this.database.run(
          `UPDATE index_versions SET state='STALE', updated_at=?
           WHERE project_id=? AND index_kind=? AND state='CURRENT'`,
          [timestamp, input.projectId, input.indexKind],
        );
      }
      this.database.run(
        `INSERT INTO index_versions(
          index_version_id,project_id,index_kind,schema_fingerprint,model_fingerprint,state,
          point_count,metadata_json,schema_version,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id,index_kind,schema_fingerprint,model_fingerprint) DO UPDATE SET
          state=excluded.state, point_count=excluded.point_count, metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at`,
        [
          indexVersionId,
          input.projectId,
          input.indexKind,
          input.schemaFingerprint,
          input.modelFingerprint,
          input.state,
          input.pointCount ?? 0,
          canonicalJson(input.metadata ?? {}),
          CURRENT_SCHEMA_VERSION,
          timestamp,
          timestamp,
        ],
      );
      const row = this.database.get<SqlRow>(
        `SELECT index_version_id FROM index_versions
         WHERE project_id=? AND index_kind=? AND schema_fingerprint=? AND model_fingerprint=?`,
        [input.projectId, input.indexKind, input.schemaFingerprint, input.modelFingerprint],
      );
      return requiredString(row?.['index_version_id'], 'index_version_id');
    });
  }

  integrityCheck(projectId: string, verifyFiles = true): IntegrityReport {
    const project = this.requireProject(projectId);
    const sqliteIntegrity = this.database
      .all<SqlRow>('PRAGMA integrity_check')
      .map((row) => String(row['integrity_check'] ?? Object.values(row)[0] ?? 'unknown'));
    const foreignKeyViolations = this.database.all<SqlRow>('PRAGMA foreign_key_check');
    const missingArtifactFiles: string[] = [];
    const mismatchedArtifactHashes: string[] = [];
    const sourceHashMismatches: string[] = [];
    if (verifyFiles) {
      const store = new ImmutableArtifactStore(project.artifactRootPath);
      for (const artifact of this.listArtifacts(projectId)) {
        if (!existsSync(artifact.filePath)) missingArtifactFiles.push(artifact.artifactId);
        else if (!store.verify(artifact.filePath, artifact.envelopeHash)) {
          mismatchedArtifactHashes.push(artifact.artifactId);
        }
      }
      const sourceRows = this.database.all<SqlRow>(
        'SELECT source_item_id,immutable_path,source_hash FROM source_items WHERE project_id=?',
        [projectId],
      );
      for (const row of sourceRows) {
        const sourceItemId = requiredString(row['source_item_id'], 'source_item_id');
        const sourcePath = requiredString(row['immutable_path'], 'immutable_path');
        if (!existsSync(sourcePath) || sha256Text(readFileSync(sourcePath)) !== row['source_hash']) {
          sourceHashMismatches.push(sourceItemId);
        }
      }
    }
    const ok =
      sqliteIntegrity.length === 1 &&
      sqliteIntegrity[0]?.toLowerCase() === 'ok' &&
      foreignKeyViolations.length === 0 &&
      missingArtifactFiles.length === 0 &&
      mismatchedArtifactHashes.length === 0 &&
      sourceHashMismatches.length === 0;
    return {
      ok,
      sqliteIntegrity,
      foreignKeyViolations,
      missingArtifactFiles,
      mismatchedArtifactHashes,
      sourceHashMismatches,
    };
  }

  createCompletionSnapshot(
    projectId: string,
    options: CompletionSnapshotOptions = {},
  ): CompletionSnapshot {
    return this.database.transaction(() => {
      const project = this.requireProject(projectId);
      const taskCounts = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<TaskState, number>;
      for (const row of this.database.all<SqlRow>(
        'SELECT state,COUNT(*) AS count FROM tasks WHERE project_id=? GROUP BY state',
        [projectId],
      )) {
        taskCounts[requiredString(row['state'], 'task state') as TaskState] = requiredNumber(
          row['count'],
          'task count',
        );
      }
      const attemptCount = this.count('task_attempts', projectId);
      const activeArtifactCount = this.count('artifacts', projectId, "state='ACTIVE'");
      const staleArtifactCount = this.count('artifacts', projectId, "state='STALE'");
      const unresolvedHighIssues = this.count(
        'review_issues',
        projectId,
        "status='OPEN' AND severity='HIGH'",
      );
      const unresolvedCriticalIssues = this.count(
        'review_issues',
        projectId,
        "status='OPEN' AND severity='CRITICAL'",
      );
      const unresolvedMergeConflicts = this.count('merge_conflicts', projectId, "state='OPEN'");
      const finalTaskTypes = options.finalTaskTypes ?? [
        'render',
        'final-render',
        'epub-render',
        'txt-render',
        'render-final',
      ];
      const finalRows = finalTaskTypes.length
        ? this.database.all<SqlRow>(
            `SELECT a.artifact_id FROM artifacts a JOIN tasks t ON t.task_id=a.task_id
             WHERE a.project_id=? AND a.state='ACTIVE' AND t.state='SUCCEEDED'
               AND t.task_type IN (${finalTaskTypes.map(() => '?').join(',')})`,
            [projectId, ...finalTaskTypes],
          )
        : [];
      const finalArtifactIds = finalRows.map((row) => requiredString(row['artifact_id'], 'artifact_id'));
      const blockers: string[] = [];
      for (const state of ['PENDING', 'LEASED', 'RUNNING', 'FAILED', 'STALE', 'BLOCKED'] as const) {
        if (taskCounts[state] > 0) blockers.push(`${state}:${taskCounts[state]}`);
      }
      for (const taskType of options.requiredTaskTypes ?? []) {
        const succeeded = requiredNumber(
          this.database.get<SqlRow>(
            `SELECT COUNT(*) AS count FROM tasks
             WHERE project_id=? AND task_type=? AND state='SUCCEEDED'`,
            [projectId, taskType],
          )?.['count'] ?? 0,
          'required task count',
        );
        if (succeeded === 0) blockers.push(`MISSING_REQUIRED_TASK:${taskType}`);
      }
      if (unresolvedHighIssues > 0) blockers.push(`UNRESOLVED_HIGH:${unresolvedHighIssues}`);
      if (unresolvedCriticalIssues > 0) blockers.push(`UNRESOLVED_CRITICAL:${unresolvedCriticalIssues}`);
      if (unresolvedMergeConflicts > 0) blockers.push(`MERGE_CONFLICTS:${unresolvedMergeConflicts}`);
      if (finalArtifactIds.length === 0) blockers.push('NO_FINAL_ARTIFACT');
      const integrity = this.integrityCheck(projectId, options.verifyFiles ?? true);
      if (!integrity.ok) blockers.push('INTEGRITY_CHECK_FAILED');
      const cost = this.getBudgetStatus(projectId);
      const createdAt = this.nowIso();
      const snapshotId = randomUUID();
      const snapshot: CompletionSnapshot = {
        snapshotId,
        projectId,
        createdAt,
        sourceHash: project.sourceHash,
        instructionVersion: project.instructionVersion,
        taskCounts,
        attemptCount,
        activeArtifactCount,
        staleArtifactCount,
        unresolvedHighIssues,
        unresolvedCriticalIssues,
        unresolvedMergeConflicts,
        cost,
        integrity,
        finalArtifactIds,
        complete: blockers.length === 0,
        blockers,
      };
      const snapshotJson = canonicalJson(snapshot);
      this.database.run(
        `INSERT INTO completion_snapshots(
          snapshot_id,project_id,instruction_version,complete,snapshot_json,snapshot_hash,
          schema_version,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`,
        [
          snapshotId,
          projectId,
          project.instructionVersion,
          snapshot.complete ? 1 : 0,
          snapshotJson,
          sha256Text(snapshotJson),
          CURRENT_SCHEMA_VERSION,
          createdAt,
        ],
      );
      this.appendProjectEvent(projectId, 'COMPLETION_SNAPSHOT', 'ledger', {
        snapshotId,
        complete: snapshot.complete,
        blockers,
      });
      return snapshot;
    });
  }

  ledgerSummary(projectId: string): Record<string, unknown> {
    const project = this.requireProject(projectId);
    const tasks = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<TaskState, number>;
    for (const row of this.database.all<SqlRow>(
      'SELECT state,COUNT(*) AS count FROM tasks WHERE project_id=? GROUP BY state',
      [projectId],
    )) {
      tasks[requiredString(row['state'], 'state') as TaskState] = requiredNumber(row['count'], 'count');
    }
    return {
      project: {
        projectId: project.projectId,
        name: project.name,
        state: project.state,
        sourceHash: project.sourceHash,
        providerId: project.providerId,
        modelId: project.modelId,
        instructionVersion: project.instructionVersion,
        schemaVersion: project.schemaVersion,
      },
      tasks,
      attempts: this.count('task_attempts', projectId),
      artifacts: {
        active: this.count('artifacts', projectId, "state='ACTIVE'"),
        stale: this.count('artifacts', projectId, "state='STALE'"),
        rejected: this.count('artifacts', projectId, "state='REJECTED'"),
      },
      reviewIssues: {
        openHigh: this.count('review_issues', projectId, "status='OPEN' AND severity='HIGH'"),
        openCritical: this.count('review_issues', projectId, "status='OPEN' AND severity='CRITICAL'"),
      },
      mergeConflicts: this.count('merge_conflicts', projectId, "state='OPEN'"),
      memoryRecords: this.count('memory_records', projectId, "state='ACTIVE'"),
      canonicalEntities: this.count('canonical_entities', projectId, "state='ACTIVE'"),
      translationMemory: this.count('translation_memory_records', projectId, "state='ACTIVE'"),
      budget: this.getBudgetStatus(projectId),
    };
  }

  listProjectEvents(projectId: string, limit = 200): Array<Record<string, unknown>> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('limit must be a positive safe integer');
    return this.database
      .all<SqlRow>(
        `SELECT * FROM project_events WHERE project_id=? ORDER BY created_at DESC, event_id DESC LIMIT ?`,
        [projectId, limit],
      )
      .map((row) => ({
        eventId: row['event_id'],
        projectId: row['project_id'],
        eventType: row['event_type'],
        actor: row['actor'],
        taskId: row['task_id'],
        attemptId: row['attempt_id'],
        instructionVersion: row['instruction_version'],
        payload: parseJson<Record<string, unknown>>(row['payload_json'], 'payload_json'),
        createdAt: row['created_at'],
      }));
  }

  recordProjectEvent(
    projectId: string,
    eventType: string,
    actor: string,
    payload: Record<string, unknown>,
    taskId?: string,
    attemptId?: string,
  ): string {
    return this.database.transaction(() =>
      this.appendProjectEvent(projectId, eventType, actor, payload, taskId, attemptId),
    );
  }

  getDeterministicReportData(projectId: string): DeterministicReportData {
    const project = this.requireProject(projectId);
    const grouped = (table: string, column: string): Record<string, number> => {
      const output: Record<string, number> = {};
      for (const row of this.database.all<SqlRow>(
        `SELECT ${column} AS bucket, COUNT(*) AS count FROM ${table}
         WHERE project_id=? GROUP BY ${column} ORDER BY ${column}`,
        [projectId],
      )) {
        output[String(row['bucket'] ?? 'NULL')] = requiredNumber(row['count'], 'group count');
      }
      return output;
    };
    const sourceStats = this.database.get<SqlRow>(
      `SELECT COUNT(*) AS paragraph_count,
              COALESCE(SUM(LENGTH(source_text)),0) AS source_characters
       FROM paragraphs WHERE project_id=?`,
      [projectId],
    );
    const tokenStats = this.database.get<SqlRow>(
      `SELECT COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
              COALESCE(SUM(cached_tokens),0) AS cached_tokens,
              COALESCE(SUM(actual_cost_micros),0) AS actual_cost_micros,
              COALESCE(SUM(CASE WHEN discarded=1 THEN actual_cost_micros ELSE 0 END),0) AS discarded_cost_micros,
              COUNT(*) AS request_count,
              COALESCE(SUM(CASE WHEN retry_reason IS NOT NULL THEN 1 ELSE 0 END),0) AS retry_count
       FROM cost_events WHERE project_id=? AND billable=1`,
      [projectId],
    );
    const indexes = this.database
      .all<SqlRow>(
        `SELECT index_kind,schema_fingerprint,model_fingerprint,state,point_count,
                metadata_json,created_at,updated_at
         FROM index_versions WHERE project_id=? ORDER BY index_kind,created_at`,
        [projectId],
      )
      .map((row) => ({
        indexKind: row['index_kind'],
        schemaFingerprint: row['schema_fingerprint'],
        modelFingerprint: row['model_fingerprint'],
        state: row['state'],
        pointCount: row['point_count'],
        metadata: parseJson<Record<string, unknown>>(row['metadata_json'], 'metadata_json'),
        createdAt: row['created_at'],
        updatedAt: row['updated_at'],
      }));
    const completionSnapshots = this.database
      .all<SqlRow>(
        `SELECT snapshot_id,instruction_version,complete,snapshot_hash,created_at
         FROM completion_snapshots WHERE project_id=? ORDER BY created_at`,
        [projectId],
      )
      .map((row) => ({
        snapshotId: row['snapshot_id'],
        instructionVersion: row['instruction_version'],
        complete: asBoolean(row['complete']),
        snapshotHash: row['snapshot_hash'],
        createdAt: row['created_at'],
      }));
    return {
      project,
      source: {
        sourceItemCount: this.count('source_items', projectId),
        sourceItemsByKind: grouped('source_items', 'kind'),
        paragraphCount: requiredNumber(sourceStats?.['paragraph_count'] ?? 0, 'paragraph count'),
        sourceCharacters: requiredNumber(sourceStats?.['source_characters'] ?? 0, 'source characters'),
      },
      tasks: {
        total: this.count('tasks', projectId),
        byState: grouped('tasks', 'state'),
        byType: grouped('tasks', 'task_type'),
        byStage: grouped('tasks', 'stage'),
      },
      attempts: {
        total: this.count('task_attempts', projectId),
        byState: grouped('task_attempts', 'state'),
        discardedCostMicros: requiredNumber(
          this.database.get<SqlRow>(
            'SELECT COALESCE(SUM(discarded_cost_micros),0) AS total FROM task_attempts WHERE project_id=?',
            [projectId],
          )?.['total'] ?? 0,
          'discarded attempt cost',
        ),
      },
      artifacts: {
        total: this.count('artifacts', projectId),
        byState: grouped('artifacts', 'state'),
      },
      memory: {
        total: this.count('memory_records', projectId),
        byType: grouped('memory_records', 'memory_type'),
        byState: grouped('memory_records', 'state'),
      },
      canonical: {
        total: this.count('canonical_entities', projectId),
        byType: grouped('canonical_entities', 'entity_type'),
        byState: grouped('canonical_entities', 'state'),
      },
      translationMemory: {
        total: this.count('translation_memory_records', projectId),
        byApproval: grouped('translation_memory_records', 'approval'),
        byState: grouped('translation_memory_records', 'state'),
      },
      reviewIssues: {
        total: this.count('review_issues', projectId),
        bySeverity: grouped('review_issues', 'severity'),
        byCategory: grouped('review_issues', 'category'),
        byStatus: grouped('review_issues', 'status'),
      },
      repairPatches: {
        total: this.count('repair_patches', projectId),
        byState: grouped('repair_patches', 'state'),
      },
      mergeConflicts: {
        total: this.count('merge_conflicts', projectId),
        byState: grouped('merge_conflicts', 'state'),
      },
      costs: {
        inputTokens: requiredNumber(tokenStats?.['input_tokens'] ?? 0, 'input tokens'),
        outputTokens: requiredNumber(tokenStats?.['output_tokens'] ?? 0, 'output tokens'),
        reasoningTokens: requiredNumber(tokenStats?.['reasoning_tokens'] ?? 0, 'reasoning tokens'),
        cachedTokens: requiredNumber(tokenStats?.['cached_tokens'] ?? 0, 'cached tokens'),
        actualCostMicros: requiredNumber(tokenStats?.['actual_cost_micros'] ?? 0, 'actual cost'),
        discardedCostMicros: requiredNumber(
          tokenStats?.['discarded_cost_micros'] ?? 0,
          'discarded cost',
        ),
        requestCount: requiredNumber(tokenStats?.['request_count'] ?? 0, 'request count'),
        retryCount: requiredNumber(tokenStats?.['retry_count'] ?? 0, 'retry count'),
        byStage: this.getBudgetStatus(projectId).stageCostMicros,
        budget: this.getBudgetStatus(projectId),
      },
      indexes,
      completionSnapshots,
      rows: {
        tasks: this.listTasks(projectId),
        attempts: this.listTaskAttempts(projectId),
        memoryRecords: this.database
          .all<SqlRow>(
            `SELECT memory_id,memory_type,chapter_id,paragraph_ids_json,entities_json,summary,
                    importance,confidence,instruction_version,state,content_hash,created_at
             FROM memory_records WHERE project_id=? ORDER BY created_at,memory_id`,
            [projectId],
          )
          .map((row) => ({
            memoryId: row['memory_id'],
            memoryType: row['memory_type'],
            chapterId: row['chapter_id'],
            paragraphIds: parseJson<string[]>(row['paragraph_ids_json'], 'paragraph_ids_json'),
            entities: parseJson<string[]>(row['entities_json'], 'entities_json'),
            summary: row['summary'],
            importance: row['importance'],
            confidence: row['confidence'],
            instructionVersion: row['instruction_version'],
            state: row['state'],
            contentHash: row['content_hash'],
            createdAt: row['created_at'],
          })),
        reviewIssues: this.database
          .all<SqlRow>(
            `SELECT issue_id,task_id,chapter_id,paragraph_ids_json,category,severity,explanation,
                    suggested_action,status,resolution_event_id,instruction_version,created_at,updated_at
             FROM review_issues WHERE project_id=? ORDER BY created_at,issue_id`,
            [projectId],
          )
          .map((row) => ({
            issueId: row['issue_id'],
            taskId: row['task_id'],
            chapterId: row['chapter_id'],
            paragraphIds: parseJson<string[]>(row['paragraph_ids_json'], 'paragraph_ids_json'),
            category: row['category'],
            severity: row['severity'],
            explanation: row['explanation'],
            suggestedAction: row['suggested_action'],
            status: row['status'],
            resolutionEventId: row['resolution_event_id'],
            instructionVersion: row['instruction_version'],
            createdAt: row['created_at'],
            updatedAt: row['updated_at'],
          })),
        repairPatches: this.database
          .all<SqlRow>(
            `SELECT patch_id,issue_id,task_id,paragraph_id,old_translation_hash,new_translation_hash,
                    reason,state,instruction_version,created_at,updated_at
             FROM repair_patches WHERE project_id=? ORDER BY created_at,patch_id`,
            [projectId],
          )
          .map((row) => ({
            patchId: row['patch_id'],
            issueId: row['issue_id'],
            taskId: row['task_id'],
            paragraphId: row['paragraph_id'],
            oldTranslationHash: row['old_translation_hash'],
            newTranslationHash: row['new_translation_hash'],
            reason: row['reason'],
            state: row['state'],
            instructionVersion: row['instruction_version'],
            createdAt: row['created_at'],
            updatedAt: row['updated_at'],
          })),
        mergeConflicts: this.database
          .all<SqlRow>(
            `SELECT conflict_id,paragraph_id,patch_ids_json,base_translation_hash,state,
                    selected_patch_id,arbitration_artifact_id,instruction_version,resolution_json,
                    created_at,updated_at
             FROM merge_conflicts WHERE project_id=? ORDER BY created_at,conflict_id`,
            [projectId],
          )
          .map((row) => ({
            conflictId: row['conflict_id'],
            paragraphId: row['paragraph_id'],
            patchIds: parseJson<string[]>(row['patch_ids_json'], 'patch_ids_json'),
            baseTranslationHash: row['base_translation_hash'],
            state: row['state'],
            selectedPatchId: row['selected_patch_id'],
            arbitrationArtifactId: row['arbitration_artifact_id'],
            instructionVersion: row['instruction_version'],
            resolution: row['resolution_json']
              ? parseJson<Record<string, unknown>>(row['resolution_json'], 'resolution_json')
              : null,
            createdAt: row['created_at'],
            updatedAt: row['updated_at'],
          })),
        costEvents: this.database
          .all<SqlRow>(
            `SELECT cost_event_id,task_id,attempt_id,stage,provider_id,model_id,provider_request_id,
                    input_tokens,output_tokens,reasoning_tokens,cached_tokens,latency_ms,
                    price_snapshot_json,actual_cost_micros,retry_reason,prompt_fingerprint,
                    context_fingerprint,instruction_fingerprint,billable,discarded,created_at
             FROM cost_events WHERE project_id=? ORDER BY created_at,cost_event_id`,
            [projectId],
          )
          .map((row) => ({
            costEventId: row['cost_event_id'],
            taskId: row['task_id'],
            attemptId: row['attempt_id'],
            stage: row['stage'],
            providerId: row['provider_id'],
            modelId: row['model_id'],
            providerRequestId: row['provider_request_id'],
            inputTokens: row['input_tokens'],
            outputTokens: row['output_tokens'],
            reasoningTokens: row['reasoning_tokens'],
            cachedTokens: row['cached_tokens'],
            latencyMs: row['latency_ms'],
            priceSnapshot: parseJson<Record<string, unknown>>(row['price_snapshot_json'], 'price_snapshot_json'),
            actualCostMicros: row['actual_cost_micros'],
            retryReason: row['retry_reason'],
            promptFingerprint: row['prompt_fingerprint'],
            contextFingerprint: row['context_fingerprint'],
            instructionFingerprint: row['instruction_fingerprint'],
            billable: asBoolean(row['billable']),
            discarded: asBoolean(row['discarded']),
            createdAt: row['created_at'],
          })),
      },
      generatedAt: this.nowIso(),
    };
  }

  private ensureTaskInternal(
    input: CreateTaskInput,
  ): { task: TaskRecord; reused: boolean; artifact?: ArtifactRecord } {
    assertHash('scopeHash', input.scopeHash);
    if (hashCanonical(input.scope) !== input.scopeHash) {
      throw new Error('scopeHash does not match the canonical task scope');
    }
    assertHash('contextHash', input.contextHash);
    assertHash('decodingConfigHash', input.decodingConfigHash);
    const key = computeTaskIdempotencyKey(input);
    const existingRow = this.database.get<SqlRow>(
      'SELECT * FROM tasks WHERE project_id=? AND idempotency_key=?',
      [input.projectId, key],
    );
    if (existingRow) {
      const task = taskFromRow(existingRow);
      if (
        canonicalJson(task.scope) !== canonicalJson(input.scope) ||
        canonicalJson(task.dependencyIds) !== canonicalJson(input.dependencyIds ?? []) ||
        task.costClass !== (input.costClass ?? 'PAID') ||
        task.stage !== (input.stage ?? 'translation') ||
        task.maxAttempts !== (input.maxAttempts ?? this.requireProject(input.projectId).maxRetries + 1)
      ) {
        throw new Error('Idempotency key collision with different immutable task execution fields');
      }
      const artifact = task.state === 'SUCCEEDED' ? this.getArtifactByTask(task.taskId) : undefined;
      return artifact ? { task, reused: true, artifact } : { task, reused: true };
    }
    const project = this.requireProject(input.projectId);
    if (project.state !== 'ACTIVE') throw new Error(`Project is not active: ${project.state}`);
    if (input.instructionVersion !== project.instructionVersion) {
      throw new Error(
        `New task instruction version ${input.instructionVersion} is not current project version ${project.instructionVersion}`,
      );
    }
    const costClass = input.costClass ?? 'PAID';
    if (costClass === 'PAID' && input.modelId !== project.modelId) {
      throw new Error(`Paid task model ${input.modelId} differs from pinned project model ${project.modelId}`);
    }
    for (const dependencyId of input.dependencyIds ?? []) {
      const dependency = this.getTask(dependencyId);
      if (!dependency || dependency.projectId !== input.projectId) {
        throw new Error(`Task dependency is not in this project: ${dependencyId}`);
      }
    }
    const taskId = input.taskId ?? randomUUID();
    assertIdentifier('taskId', taskId);
    const maxAttempts = input.maxAttempts ?? project.maxRetries + 1;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error('maxAttempts must be a positive safe integer');
    }
    const timestamp = this.nowIso();
    this.database.run(
      `INSERT INTO tasks(
        task_id,project_id,task_type,scope_json,scope_hash,state,priority,dependency_ids_json,
        prompt_version,instruction_version,context_hash,model_id,decoding_config_hash,idempotency_key,
        cost_class,stage,max_attempts,schema_version,created_at,updated_at
      ) VALUES(?,?,?,?,?,'PENDING',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        taskId,
        input.projectId,
        input.taskType,
        canonicalJson(input.scope),
        input.scopeHash,
        input.priority ?? 0,
        canonicalJson(input.dependencyIds ?? []),
        input.promptVersion,
        input.instructionVersion,
        input.contextHash,
        input.modelId,
        input.decodingConfigHash,
        key,
        costClass,
        input.stage ?? 'translation',
        maxAttempts,
        CURRENT_SCHEMA_VERSION,
        timestamp,
        timestamp,
      ],
    );
    this.appendProjectEvent(input.projectId, 'TASK_CREATED', 'coordinator', {
      taskType: input.taskType,
      idempotencyKey: key,
      dependencyIds: input.dependencyIds ?? [],
    }, taskId);
    return {
      task: taskFromRow(this.database.get<SqlRow>('SELECT * FROM tasks WHERE task_id=?', [taskId])!),
      reused: false,
    };
  }

  private requireOwnedAttempt(taskId: string, attemptId: string, workerId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.activeAttemptId !== attemptId || task.leaseOwner !== workerId) {
      throw new Error('Task lease is not owned by this worker/attempt');
    }
    const attempt = this.database.get<SqlRow>(
      'SELECT worker_id FROM task_attempts WHERE attempt_id=? AND task_id=?',
      [attemptId, taskId],
    );
    if (!attempt || attempt['worker_id'] !== workerId) throw new Error('Attempt ownership mismatch');
    return task;
  }

  private getArtifactByAttempt(taskId: string, attemptId: string): ArtifactRecord | undefined {
    const row = this.database.get<SqlRow>(
      'SELECT * FROM artifacts WHERE task_id=? AND attempt_id=?',
      [taskId, attemptId],
    );
    return row ? artifactFromRow(row) : undefined;
  }

  private getArtifactByTask(taskId: string): ArtifactRecord | undefined {
    const row = this.database.get<SqlRow>(
      `SELECT * FROM artifacts WHERE task_id=? AND state='ACTIVE' ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    return row ? artifactFromRow(row) : undefined;
  }

  private dependenciesSatisfied(task: TaskRecord): boolean {
    if (task.dependencyIds.length === 0) return true;
    const placeholders = task.dependencyIds.map(() => '?').join(',');
    const rows = this.database.all<SqlRow>(
      `SELECT task_id,state FROM tasks WHERE project_id=? AND task_id IN (${placeholders})`,
      [task.projectId, ...task.dependencyIds],
    );
    if (rows.length !== task.dependencyIds.length) return false;
    return rows.every((row) => row['state'] === 'SUCCEEDED');
  }

  private recoverExpiredLeasesInternal(projectId: string): LeaseRecoveryResult {
    const timestamp = this.nowIso();
    const expired = this.database.all<SqlRow>(
      `SELECT * FROM tasks WHERE project_id=? AND state IN ('LEASED','RUNNING')
       AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`,
      [projectId, timestamp],
    );
    const recoveredTaskIds: string[] = [];
    const expiredAttemptIds: string[] = [];
    const uncertainTaskIds: string[] = [];
    for (const row of expired) {
      const task = taskFromRow(row);
      const attemptId = task.activeAttemptId;
      if (!attemptId) throw new Error(`Active task ${task.taskId} has no attempt identity`);
      const attemptCount = requiredNumber(
        this.database.get<SqlRow>('SELECT COUNT(*) AS count FROM task_attempts WHERE task_id=?', [task.taskId])?.[
          'count'
        ] ?? 0,
        'attempt count',
      );
      const attempt = this.getTaskAttempt(attemptId);
      if (!attempt) throw new Error(`Active task ${task.taskId} has no attempt row`);
      const cancelled = task.interruptMode !== null;
      const uncertain =
        !cancelled &&
        (attempt.providerRequestId !== null || (task.costClass === 'PAID' && task.state === 'RUNNING'));
      const retry = !cancelled && !uncertain && attemptCount < task.maxAttempts;
      this.database.run(
        `UPDATE task_attempts SET state='LEASE_EXPIRED', finished_at=?, error_code='LEASE_EXPIRED',
         retry_reason='ENGINE_OR_WORKER_CRASH', updated_at=? WHERE attempt_id=?`,
        [timestamp, timestamp, attemptId],
      );
      this.database.run(
        `UPDATE tasks SET state=?, lease_owner=NULL, lease_expires_at=NULL, active_attempt_id=NULL,
         interrupt_mode=NULL, interrupt_requested_at=NULL, block_reason=?, updated_at=? WHERE task_id=?`,
        [
          retry ? 'PENDING' : uncertain ? 'BLOCKED' : cancelled ? 'CANCELLED' : 'FAILED',
          retry
            ? null
            : uncertain
              ? `UNCERTAIN_PROVIDER_RESULT:${attempt.providerRequestId ?? 'UNKNOWN_REQUEST_ID'}`
              : cancelled
                ? 'INTERRUPTED'
                : 'MAX_ATTEMPTS',
          timestamp,
          task.taskId,
        ],
      );
      this.appendProjectEvent(
        projectId,
        retry ? 'TASK_LEASE_RECOVERED' : uncertain ? 'TASK_PROVIDER_RESULT_UNCERTAIN' : 'TASK_LEASE_EXPIRED_TERMINAL',
        'ledger',
        {
          previousOwner: task.leaseOwner,
          retry,
          cancelled,
          providerRequestId: attempt.providerRequestId,
          requiresProviderCheck: uncertain,
        },
        task.taskId,
        attemptId,
      );
      if (retry) recoveredTaskIds.push(task.taskId);
      if (uncertain) uncertainTaskIds.push(task.taskId);
      expiredAttemptIds.push(attemptId);
    }
    return { recoveredTaskIds, expiredAttemptIds, uncertainTaskIds };
  }

  private assertProvenanceMatchesTask(
    provenance: ArtifactProvenance,
    sourceHashes: string[],
    task: TaskRecord,
  ): void {
    if (provenance.modelId !== task.modelId) throw new Error('Artifact model provenance differs from task');
    if (provenance.promptVersion !== task.promptVersion) throw new Error('Artifact prompt provenance differs from task');
    if (provenance.instructionVersion !== task.instructionVersion) {
      throw new Error('Artifact instruction provenance differs from task');
    }
    if (provenance.contextHash !== task.contextHash) throw new Error('Artifact context provenance differs from task');
    if (!sameStringSet(provenance.sourceHashes, sourceHashes)) {
      throw new Error('Artifact provenance source hashes differ from its envelope');
    }
  }

  private taskMatchesAffectedScope(task: TaskRecord, scope: AffectedScope): boolean {
    if (scope.affectedTaskIds.includes(task.taskId)) return true;
    if (scope.global) {
      if (!scope.reason.toLowerCase().includes('global style')) return true;
      const identity = `${task.taskType} ${task.stage}`.toLowerCase();
      return identity.includes('translat') || identity.includes('review') || identity.includes('audit');
    }
    const chapters = new Set<string>();
    const entities = new Set<string>();
    collectScopeSelectors(task.scope, chapters, entities);
    return (
      scope.affectedChapterIds.some((chapter) => chapters.has(chapter)) ||
      scope.affectedEntities.some((entity) => entities.has(entity))
    );
  }

  private markKnowledgeStaleForScope(
    projectId: string,
    scope: AffectedScope,
    eventId: string,
    timestamp: string,
  ): void {
    if (scope.global) {
      if (scope.reason.toLowerCase().includes('global style')) {
        this.database.run(
          `UPDATE translation_memory_records SET state='STALE', updated_at=?
           WHERE project_id=? AND state='ACTIVE'`,
          [timestamp, projectId],
        );
        this.appendProjectEvent(projectId, 'KNOWLEDGE_SCOPE_STALE', 'ledger', {
          instructionEventId: eventId,
          globalStyleOnly: true,
        });
        return;
      }
      this.database.run(
        `UPDATE memory_records SET state='STALE', updated_at=? WHERE project_id=? AND state='ACTIVE'`,
        [timestamp, projectId],
      );
      this.database.run(
        `UPDATE canonical_entities SET state='STALE', updated_at=? WHERE project_id=? AND state='ACTIVE'`,
        [timestamp, projectId],
      );
      this.database.run(
        `UPDATE translation_memory_records SET state='STALE', updated_at=? WHERE project_id=? AND state='ACTIVE'`,
        [timestamp, projectId],
      );
      return;
    }
    for (const row of this.database.all<SqlRow>(
      `SELECT memory_id,chapter_id,entities_json FROM memory_records
       WHERE project_id=? AND state='ACTIVE'`,
      [projectId],
    )) {
      const chapter = optionalString(row['chapter_id']);
      const entities = parseJson<string[]>(row['entities_json'], 'entities_json');
      if (
        (chapter !== null && scope.affectedChapterIds.includes(chapter)) ||
        entities.some((entity) => scope.affectedEntities.includes(entity))
      ) {
        this.database.run("UPDATE memory_records SET state='STALE', updated_at=? WHERE memory_id=?", [
          timestamp,
          requiredString(row['memory_id'], 'memory_id'),
        ]);
      }
    }
    for (const row of this.database.all<SqlRow>(
      `SELECT canonical_record_id,entity_key,aliases_json FROM canonical_entities
       WHERE project_id=? AND state='ACTIVE'`,
      [projectId],
    )) {
      const aliases = parseJson<string[]>(row['aliases_json'], 'aliases_json');
      const key = requiredString(row['entity_key'], 'entity_key');
      if (scope.affectedEntities.includes(key) || aliases.some((alias) => scope.affectedEntities.includes(alias))) {
        this.database.run(
          "UPDATE canonical_entities SET state='STALE', updated_at=? WHERE canonical_record_id=?",
          [timestamp, requiredString(row['canonical_record_id'], 'canonical_record_id')],
        );
      }
    }
    for (const row of this.database.all<SqlRow>(
      `SELECT tm.tm_record_id,p.entities_json,si.source_item_id
       FROM translation_memory_records tm
       LEFT JOIN paragraphs p ON p.paragraph_id=tm.paragraph_id
       LEFT JOIN source_items si ON si.source_item_id=p.source_item_id
       WHERE tm.project_id=? AND tm.state='ACTIVE'`,
      [projectId],
    )) {
      const entities = row['entities_json'] ? parseJson<string[]>(row['entities_json'], 'entities_json') : [];
      const chapter = optionalString(row['source_item_id']);
      if (
        (chapter !== null && scope.affectedChapterIds.includes(chapter)) ||
        entities.some((entity) => scope.affectedEntities.includes(entity))
      ) {
        this.database.run(
          "UPDATE translation_memory_records SET state='STALE', updated_at=? WHERE tm_record_id=?",
          [timestamp, requiredString(row['tm_record_id'], 'tm_record_id')],
        );
      }
    }
    this.appendProjectEvent(projectId, 'KNOWLEDGE_SCOPE_STALE', 'ledger', {
      instructionEventId: eventId,
      chapters: scope.affectedChapterIds,
      entities: scope.affectedEntities,
    });
  }

  private appendProjectEvent(
    projectId: string,
    eventType: string,
    actor: string,
    payload: Record<string, unknown>,
    taskId?: string,
    attemptId?: string,
  ): string {
    const project = this.requireProject(projectId);
    const eventId = randomUUID();
    this.database.run(
      `INSERT INTO project_events(
        event_id,project_id,event_type,actor,task_id,attempt_id,instruction_version,
        payload_json,schema_version,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        eventId,
        projectId,
        eventType,
        actor,
        taskId ?? null,
        attemptId ?? null,
        project.instructionVersion,
        canonicalJson(payload),
        CURRENT_SCHEMA_VERSION,
        this.nowIso(),
      ],
    );
    return eventId;
  }

  private count(table: string, projectId: string, predicate?: string): number {
    const row = this.database.get<SqlRow>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE project_id=?${predicate ? ` AND ${predicate}` : ''}`,
      [projectId],
    );
    return requiredNumber(row?.['count'] ?? 0, `${table} count`);
  }

  private assertCurrentInstruction(projectId: string, instructionVersion: number): ProjectRecord {
    const project = this.requireProject(projectId);
    if (instructionVersion !== project.instructionVersion) {
      throw new Error(
        `Record instruction version ${instructionVersion} is stale; current project version is ${project.instructionVersion}`,
      );
    }
    return project;
  }

  private assertRelatedRowProject(
    table: string,
    idColumn: string,
    id: string,
    projectId: string,
  ): void {
    const row = this.database.get<SqlRow>(
      `SELECT project_id FROM ${table} WHERE ${idColumn}=?`,
      [id],
    );
    if (!row || row['project_id'] !== projectId) {
      throw new Error(`${table} record ${id} is not in project ${projectId}`);
    }
  }

  private assertMatchingCostReplay(row: SqlRow, input: CostEventInput): void {
    const matches =
      row['project_id'] === input.projectId &&
      row['task_id'] === input.taskId &&
      row['attempt_id'] === input.attemptId &&
      row['stage'] === input.stage &&
      row['provider_id'] === input.providerId &&
      row['model_id'] === input.modelId &&
      optionalString(row['provider_request_id']) === (input.providerRequestId ?? null) &&
      row['input_tokens'] === input.inputTokens &&
      row['output_tokens'] === input.outputTokens &&
      row['reasoning_tokens'] === (input.reasoningTokens ?? 0) &&
      row['cached_tokens'] === (input.cachedTokens ?? 0) &&
      row['latency_ms'] === input.latencyMs &&
      row['actual_cost_micros'] === input.actualCostMicros &&
      canonicalJson(parseJson<Record<string, unknown>>(row['price_snapshot_json'], 'price_snapshot_json')) ===
        canonicalJson(input.priceSnapshot) &&
      row['prompt_fingerprint'] === input.promptFingerprint &&
      row['context_fingerprint'] === input.contextFingerprint &&
      row['instruction_fingerprint'] === input.instructionFingerprint &&
      asBoolean(row['billable']) === (input.billable !== false) &&
      asBoolean(row['discarded']) === (input.discarded === true);
    if (!matches) throw new Error('Cost idempotency key was replayed with different accounting data');
  }

  private assertMergerLease(lease: MergerLeaseToken, projectId: string): void {
    if (lease.projectId !== projectId) throw new Error('Merger lease is for another project');
    const row = this.database.get<SqlRow>(
      `SELECT generation FROM merger_leases
       WHERE project_id=? AND lease_owner=? AND generation=? AND lease_expires_at>?`,
      [projectId, lease.owner, lease.generation, this.nowIso()],
    );
    if (!row) throw new Error('Merger fencing token is missing, expired, or superseded');
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
