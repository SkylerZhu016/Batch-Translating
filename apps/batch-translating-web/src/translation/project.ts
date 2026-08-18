import {
  buildStagePlan,
  createStageRunStates,
  isValidMaxAgents,
  normalizeMaxAgents,
  planFingerprint,
  stageIndexOf,
} from './stages';
import {
  TRANSLATION_PROJECT_SCHEMA_ID,
  TRANSLATION_PROJECT_SCHEMA_VERSION,
  TRANSLATION_RUNTIME_RECEIPT_VERSION,
  type OverrideScope,
  type ParseResult,
  type TranslationCompletionVerification,
  type TranslationExecutionPolicy,
  type TranslationInitializationReceipt,
  type TranslationInstructionReceipt,
  type TranslationPaths,
  type TranslationProject,
  type TranslationProjectQualityPolicyReceipt,
  type TranslationReportReceipt,
  type TranslationRuntimeError,
  type TranslationSource,
  type TranslationSourceKind,
  type UserOverride,
  type UserOverrideStatus,
  type WorkflowOptions,
} from './types';
import { TRANSLATION_PROMPT_VERSION } from './prompts';
import {
  detectTranslationQualityCapability,
  isAllowedTranslationQualityModel,
} from './qualityPolicy';

export const MAX_OVERRIDE_INSTRUCTION_LENGTH = 12_000;

/** v1 stored the source under `epubPath`; v2 generalizes it to kind + sourcePath. */
export const SOURCE_KIND_V1 = 'epub' as const;

export function sourceKindOfPath(path: string): TranslationSourceKind {
  if (/\.txt$/i.test(path.trim())) return 'txt';
  return 'epub';
}

export const TRANSLATION_PROJECT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: TRANSLATION_PROJECT_SCHEMA_ID,
  title: 'Batch translation project metadata',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'projectId',
    'name',
    'instructionVersion',
    'instructionReceipts',
    'executionPolicy',
    'revision',
    'createdAt',
    'updatedAt',
    'source',
    'paths',
    'workflow',
    'maxAgents',
    'status',
    'planFingerprint',
    'stages',
    'chapters',
    'issues',
    'artifacts',
    'checkpoints',
    'overrides',
    'overrideRevision',
    'promptVersion',
  ],
  properties: {
    schemaVersion: { const: TRANSLATION_PROJECT_SCHEMA_VERSION },
    projectId: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    qualityPolicy: { type: 'object' },
    initialization: { type: 'object' },
    instructionVersion: { type: 'integer', minimum: 0 },
    latestInstruction: { type: 'object' },
    instructionReceipts: { type: 'array' },
    completionVerification: { type: 'object' },
    reportReceipt: { type: 'object' },
    runtimeError: { type: 'object' },
    executionPolicy: {
      type: 'object',
      additionalProperties: false,
      required: ['softBudgetMicros', 'hardBudgetMicros', 'maxRetries', 'maxConcurrency'],
      properties: {
        softBudgetMicros: { type: ['integer', 'null'], minimum: 0 },
        hardBudgetMicros: { type: ['integer', 'null'], minimum: 0 },
        maxRetries: { type: 'integer', minimum: 0 },
        maxConcurrency: { type: 'integer', minimum: 1 },
      },
    },
    model: { type: 'string', minLength: 1 },
    coordinatorLaunch: {
      type: 'object',
      additionalProperties: false,
      required: ['launchId', 'attempt', 'status', 'preparedAt', 'updatedAt', 'attachments'],
      properties: {
        launchId: { type: 'string', minLength: 1 },
        attempt: { type: 'integer', minimum: 1 },
        status: { enum: ['prepared', 'uncertain', 'accepted', 'rejected'] },
        preparedAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        promptId: { type: 'string', minLength: 1 },
        goalId: { type: 'string', minLength: 1 },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['fileId', 'kind'],
            properties: {
              fileId: { type: 'string', minLength: 1 },
              kind: { enum: ['image', 'video', 'file'] },
              name: { type: 'string' },
              mediaType: { type: 'string' },
              size: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    revision: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    source: {
      type: 'object',
      required: ['kind', 'sourcePath', 'immutable'],
      properties: {
        kind: { enum: ['epub', 'txt'] },
        sourcePath: { type: 'string', minLength: 1 },
        immutable: { const: true },
        sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        sizeBytes: { type: 'integer', minimum: 0 },
        chapterPattern: { type: 'string' },
      },
    },
    workflow: {
      type: 'object',
      additionalProperties: false,
      required: ['secondTranslation', 'secondReview', 'consistencyReview'],
      properties: {
        secondTranslation: { type: 'boolean' },
        secondReview: { type: 'boolean' },
        consistencyReview: { type: 'boolean' },
      },
    },
    maxAgents: { type: 'integer', minimum: 2, maximum: 128 },
    status: {
      enum: ['draft', 'ready', 'running', 'paused', 'failed', 'completed'],
    },
    activeStageId: { type: 'string' },
    planFingerprint: { type: 'string' },
    stages: { type: 'array', minItems: 8 },
    chapters: { type: 'array' },
    issues: { type: 'array' },
    artifacts: { type: 'array' },
    checkpoints: { type: 'array' },
    overrides: { type: 'array' },
    overrideRevision: { type: 'integer', minimum: 0 },
    promptVersion: { type: 'string', minLength: 1 },
    paths: { type: 'object' },
  },
} as const;

export interface CreateTranslationProjectInput {
  name: string;
  /** Model pinned by the native translation Coordinator. */
  model?: string;
  /** Must be produced from a real capability probe; never synthesized as ready. */
  qualityPolicy?: TranslationProjectQualityPolicyReceipt;
  executionPolicy?: TranslationExecutionPolicy;
  sourcePath: string;
  /** Immutable byte identity supplied by the upload service when available. */
  sourceSha256?: string;
  sourceSizeBytes?: number;
  /** Optional explicit kind; derived from the file extension when absent. */
  kind?: TranslationSourceKind;
  /** TXT only: custom chapter-heading regular expression override. */
  chapterPattern?: string;
  projectRoot: string;
  workflow: WorkflowOptions;
  maxAgents: number;
  projectId?: string;
  now?: string;
}

export interface AppendUserOverrideInput {
  instruction: string;
  scope?: OverrideScope;
  expectedProjectRevision?: number;
  effectiveFromStageIndex?: number;
  overrideId?: string;
  now?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isCountRecord(value: unknown): value is Record<string, number> {
  return isRecord(value)
    && Object.entries(value).every(([key, count]) => key.length > 0 && isNonNegativeInteger(count));
}

function sameWorkflow(left: WorkflowOptions, right: WorkflowOptions): boolean {
  return left.secondTranslation === right.secondTranslation
    && left.secondReview === right.secondReview
    && left.consistencyReview === right.consistencyReview;
}

function normalizeExecutionPolicy(
  value: TranslationExecutionPolicy | undefined,
  defaultConcurrency: number,
): TranslationExecutionPolicy {
  const policy: TranslationExecutionPolicy = value === undefined
    ? {
        softBudgetMicros: null,
        hardBudgetMicros: null,
        maxRetries: 3,
        maxConcurrency: defaultConcurrency,
      }
    : { ...value };
  for (const key of ['softBudgetMicros', 'hardBudgetMicros'] as const) {
    if (policy[key] !== null && !isNonNegativeInteger(policy[key])) {
      throw new Error(`executionPolicy.${key} must be a non-negative integer or null`);
    }
  }
  if (!isNonNegativeInteger(policy.maxRetries)) {
    throw new Error('executionPolicy.maxRetries must be a non-negative integer');
  }
  if (!isNonNegativeInteger(policy.maxConcurrency) || policy.maxConcurrency < 1) {
    throw new Error('executionPolicy.maxConcurrency must be a positive integer');
  }
  if (
    policy.softBudgetMicros !== null
    && policy.hardBudgetMicros !== null
    && policy.hardBudgetMicros < policy.softBudgetMicros
  ) {
    throw new Error('executionPolicy.hardBudgetMicros must be greater than or equal to softBudgetMicros');
  }
  return policy;
}

function parseExecutionPolicy(value: unknown, errors: string[]): TranslationExecutionPolicy | null {
  if (!isRecord(value)) {
    errors.push('executionPolicy must be an object');
    return null;
  }
  const candidate = {
    softBudgetMicros: value.softBudgetMicros,
    hardBudgetMicros: value.hardBudgetMicros,
    maxRetries: value.maxRetries,
    maxConcurrency: value.maxConcurrency,
  } as TranslationExecutionPolicy;
  try {
    return normalizeExecutionPolicy(candidate, 8);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireParsed<T>(result: ParseResult<T>, label: string): T {
  if (!result.ok) throw new Error(`Invalid ${label}: ${result.errors.join('; ')}`);
  return result.value;
}

function parseWorkflowAt(
  value: unknown,
  path: string,
  errors: string[],
): WorkflowOptions | null {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const secondTranslation = value.secondTranslation;
  const secondReview = value.secondReview;
  const consistencyReview = value.consistencyReview;
  if (!isBoolean(secondTranslation)) errors.push(`${path}.secondTranslation must be boolean`);
  if (!isBoolean(secondReview)) errors.push(`${path}.secondReview must be boolean`);
  if (!isBoolean(consistencyReview)) errors.push(`${path}.consistencyReview must be boolean`);
  if (!isBoolean(secondTranslation) || !isBoolean(secondReview) || !isBoolean(consistencyReview)) {
    return null;
  }
  return { secondTranslation, secondReview, consistencyReview };
}

function field(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

function normalizedStringArray(value: unknown): unknown {
  return Array.isArray(value) ? value : [];
}

function normalizeInitializationInput(
  value: unknown,
  fallbackNow: string,
  context?: { manifestPath: string; databasePath: string },
): unknown {
  if (!isRecord(value) || value.receiptVersion === TRANSLATION_RUNTIME_RECEIPT_VERSION) return value;
  const sourceEnvelope = field(value, 'sourceReceipt', 'source_receipt');
  const sourceRecord = isRecord(sourceEnvelope) ? sourceEnvelope : {};
  const original = isRecord(sourceRecord.original) ? sourceRecord.original : sourceRecord;
  const manifestValue = value.manifest;
  const manifest = isRecord(manifestValue) ? manifestValue : {};
  const ledgerValue = field(value, 'ledgerSummary', 'ledger_summary');
  const ledger = isRecord(ledgerValue) ? ledgerValue : {};
  const ledgerProject = isRecord(ledger.project) ? ledger.project : {};
  const ledgerArtifacts = isRecord(ledger.artifacts) ? ledger.artifacts : {};
  const chapterValue = Array.isArray(value.chapters)
    ? value.chapters
    : (Array.isArray(manifest.chapters) ? manifest.chapters : []);
  const projectId = field(value, 'projectId', 'project_id');
  const initializedAt = field(value, 'initializedAt', 'initialized_at')
    ?? field(value, 'generatedAt', 'generated_at')
    ?? field(value, 'createdAt', 'created_at')
    ?? fallbackNow;
  const copiedPath = field(sourceRecord, 'copiedPath', 'copied_path');
  const copiedSha256 = field(sourceRecord, 'copiedSha256', 'copied_sha256');
  return {
    receiptVersion: TRANSLATION_RUNTIME_RECEIPT_VERSION,
    initialized: true,
    initializedAt,
    sourceReceipt: {
      sourcePath: field(original, 'sourcePath', 'source_path'),
      format: original.format,
      sha256: original.sha256,
      byteLength: field(original, 'byteLength', 'byte_length'),
      modifiedAtMs: field(original, 'modifiedAtMs', 'modified_at_ms'),
      copiedPath,
      copiedSha256,
      immutable: true,
      verified: true,
    },
    manifest: {
      path: manifest.path
        ?? field(manifest, 'manifestPath', 'manifest_path')
        ?? field(value, 'manifestPath', 'manifest_path')
        ?? context?.manifestPath,
      sha256: manifest.sha256
        ?? field(manifest, 'manifestSha256', 'manifest_sha256')
        ?? field(value, 'manifestSha256', 'manifest_sha256'),
      schemaVersion: field(manifest, 'schemaVersion', 'schema_version'),
      bookId: field(manifest, 'bookId', 'book_id'),
      chapterCount: field(manifest, 'chapterCount', 'chapter_count') ?? chapterValue.length,
      paragraphCount: field(manifest, 'paragraphCount', 'paragraph_count'),
      sourceWordCount: field(manifest, 'sourceWordCount', 'source_word_count'),
    },
    ledgerSummary: {
      databasePath: field(ledger, 'databasePath', 'database_path')
        ?? field(value, 'databasePath', 'database_path')
        ?? context?.databasePath,
      schemaVersion: field(ledger, 'schemaVersion', 'schema_version')
        ?? field(ledgerProject, 'schemaVersion', 'schema_version'),
      journalMode: String(field(ledger, 'journalMode', 'journal_mode') ?? 'wal').toLowerCase(),
      projectId: field(ledger, 'projectId', 'project_id')
        ?? field(ledgerProject, 'projectId', 'project_id')
        ?? projectId,
      instructionVersion: field(ledger, 'instructionVersion', 'instruction_version')
        ?? field(ledgerProject, 'instructionVersion', 'instruction_version'),
      taskCounts: field(ledger, 'taskCounts', 'task_counts') ?? ledger.tasks,
      artifactCount: field(ledger, 'artifactCount', 'artifact_count')
        ?? (['active', 'stale', 'rejected'].reduce((total, key) => (
          total + (isNonNegativeInteger(ledgerArtifacts[key]) ? ledgerArtifacts[key] : 0)
        ), 0)),
      integrityOk: field(ledger, 'integrityOk', 'integrity_ok')
        ?? field(value, 'integrityOk', 'integrity_ok'),
    },
    chapters: chapterValue.map((entry) => {
      const chapter = isRecord(entry) ? entry : {};
      return {
        chapterId: field(chapter, 'chapterId', 'chapter_id'),
        title: chapter.title,
        spineIndex: field(chapter, 'spineIndex', 'spine_index')
          ?? (typeof chapter.ordinal === 'number' ? chapter.ordinal - 1 : undefined),
        sourcePath: field(chapter, 'sourcePath', 'source_path'),
        paragraphCount: field(chapter, 'paragraphCount', 'paragraph_count')
          ?? (Array.isArray(chapter.paragraphs) ? chapter.paragraphs.length : undefined),
        sourceHash: field(chapter, 'sourceHash', 'source_hash'),
      };
    }),
  };
}

function normalizeInstructionInput(value: unknown, fallbackNow: string): unknown {
  if (!isRecord(value) || value.receiptVersion === TRANSLATION_RUNTIME_RECEIPT_VERSION) return value;
  const instructionValue = value.instruction;
  const instruction = isRecord(instructionValue) ? instructionValue : value;
  const scopeValue = field(instruction, 'affectedScope', 'affected_scope');
  const scope = isRecord(scopeValue) ? scopeValue : {};
  const costValue = field(value, 'costImpact', 'cost_impact');
  const cost = isRecord(costValue) ? costValue : {};
  return {
    receiptVersion: TRANSLATION_RUNTIME_RECEIPT_VERSION,
    eventId: field(instruction, 'eventId', 'event_id'),
    sessionMessageId: field(instruction, 'sessionMessageId', 'session_message_id'),
    instructionVersion: field(instruction, 'instructionVersion', 'instruction_version'),
    message: instruction.message,
    affectedScope: {
      affectedTaskIds: normalizedStringArray(field(scope, 'affectedTaskIds', 'affected_task_ids')),
      affectedChapterIds: normalizedStringArray(field(scope, 'affectedChapterIds', 'affected_chapter_ids')),
      affectedEntities: normalizedStringArray(field(scope, 'affectedEntities', 'affected_entities')),
      global: scope.global ?? false,
      reason: scope.reason ?? 'User correction',
    },
    interruptMode: field(instruction, 'interruptMode', 'interrupt_mode') ?? 'SOFT',
    appliedAt: field(instruction, 'appliedAt', 'applied_at')
      ?? field(instruction, 'createdAt', 'created_at')
      ?? fallbackNow,
    continuedTaskIds: normalizedStringArray(field(value, 'continuedTaskIds', 'continued_task_ids')),
    cancelledTaskIds: normalizedStringArray(field(value, 'cancelledTaskIds', 'cancelled_task_ids')),
    interruptedTaskIds: normalizedStringArray(field(value, 'interruptedTaskIds', 'interrupted_task_ids')),
    staleTaskIds: normalizedStringArray(field(value, 'staleTaskIds', 'stale_task_ids')),
    replacementTaskIds: normalizedStringArray(field(value, 'replacementTaskIds', 'replacement_task_ids')),
    costImpact: {
      actualCostMicrosDelta: field(cost, 'actualCostMicrosDelta', 'actual_cost_micros_delta') ?? 0,
      discardedCostMicros: field(cost, 'discardedCostMicros', 'discarded_cost_micros') ?? 0,
      estimatedAdditionalCostMicros: field(cost, 'estimatedAdditionalCostMicros', 'estimated_additional_cost_micros') ?? 0,
      additionalPaidTaskCount: field(cost, 'additionalPaidTaskCount', 'additional_paid_task_count') ?? 0,
      reason: cost.reason,
    },
  };
}

function normalizeIntegrityInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ok: value.ok,
    sqliteIntegrity: field(value, 'sqliteIntegrity', 'sqlite_integrity') ?? [],
    foreignKeyViolations: field(value, 'foreignKeyViolations', 'foreign_key_violations') ?? [],
    missingArtifactFiles: field(value, 'missingArtifactFiles', 'missing_artifact_files') ?? [],
    mismatchedArtifactHashes: field(value, 'mismatchedArtifactHashes', 'mismatched_artifact_hashes') ?? [],
    sourceHashMismatches: field(value, 'sourceHashMismatches', 'source_hash_mismatches') ?? [],
  };
}

function normalizeFinalOutputInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const structuralValue = field(value, 'structuralValidation', 'structural_validation');
  const structural = isRecord(structuralValue) ? structuralValue : {};
  const epubcheck = isRecord(value.epubcheck) ? value.epubcheck : {};
  return {
    artifactType: field(value, 'artifactType', 'artifact_type'),
    path: value.path ?? field(value, 'outputPath', 'output_path'),
    sourcePath: field(value, 'sourcePath', 'source_path'),
    sourceSha256: field(value, 'sourceSha256', 'source_sha256'),
    sha256: value.sha256 ?? field(value, 'artifactSha256', 'artifact_sha256'),
    byteLength: field(value, 'byteLength', 'byte_length'),
    immutable: value.immutable,
    paragraphCount: field(value, 'paragraphCount', 'paragraph_count'),
    translatedParagraphCount: field(value, 'translatedParagraphCount', 'translated_paragraph_count'),
    coverage: value.coverage,
    structuralValidationPassed: field(value, 'structuralValidationPassed', 'structural_validation_passed')
      ?? structural.valid,
    epubcheckStatus: field(value, 'epubcheckStatus', 'epubcheck_status') ?? epubcheck.status,
    createdAt: field(value, 'createdAt', 'created_at'),
  };
}

function normalizeCompletionInput(
  value: unknown,
  finalOutput: unknown,
  fallbackNow: string,
): unknown {
  if (!isRecord(value)) return value;
  const nestedReceipt = isRecord(value.receipt) ? value.receipt : undefined;
  const base: Record<string, unknown> = nestedReceipt === undefined
    ? value
    : {
        ...nestedReceipt,
        finalOutput: value.finalOutput ?? nestedReceipt.finalOutput,
        failures: value.failures ?? nestedReceipt.failures,
      };
  const snapshot = isRecord(base.completion) ? base.completion : base;
  if (
    base.receiptVersion === TRANSLATION_RUNTIME_RECEIPT_VERSION
    && (finalOutput === undefined || base.finalOutput !== undefined)
    && nestedReceipt === undefined
  ) return base;
  const output = base.finalOutput
    ?? base.final_output
    ?? finalOutput
    ?? (field(base, 'outputPath', 'output_path') !== undefined ? base : undefined);
  const blockers = base.blockers ?? snapshot.blockers;
  const failures = base.failures ?? field(base, 'failureReasons', 'failure_reasons') ?? [];
  const integrity = normalizeIntegrityInput(base.integrity ?? snapshot.integrity);
  const complete = snapshot.complete === true;
  const integrityOk = isRecord(integrity) && integrity.ok === true;
  const hasOutput = isRecord(output);
  const passed = complete
    && integrityOk
    && hasOutput
    && Array.isArray(blockers)
    && blockers.length === 0
    && Array.isArray(failures)
    && failures.length === 0;
  return {
    receiptVersion: TRANSLATION_RUNTIME_RECEIPT_VERSION,
    snapshotId: field(base, 'snapshotId', 'snapshot_id')
      ?? field(snapshot, 'snapshotId', 'snapshot_id'),
    verifiedAt: field(base, 'verifiedAt', 'verified_at')
      ?? field(base, 'createdAt', 'created_at')
      ?? fallbackNow,
    status: passed ? 'passed' : 'failed',
    verified: passed,
    complete,
    sourceSha256: field(base, 'sourceSha256', 'source_sha256')
      ?? field(base, 'sourceHash', 'source_hash')
      ?? field(snapshot, 'sourceHash', 'source_hash'),
    planFingerprint: field(base, 'planFingerprint', 'plan_fingerprint'),
    instructionVersion: field(base, 'instructionVersion', 'instruction_version')
      ?? field(snapshot, 'instructionVersion', 'instruction_version'),
    taskCounts: field(base, 'taskCounts', 'task_counts')
      ?? field(snapshot, 'taskCounts', 'task_counts'),
    attemptCount: field(base, 'attemptCount', 'attempt_count')
      ?? field(snapshot, 'attemptCount', 'attempt_count'),
    activeArtifactCount: field(base, 'activeArtifactCount', 'active_artifact_count')
      ?? field(snapshot, 'activeArtifactCount', 'active_artifact_count'),
    staleArtifactCount: field(base, 'staleArtifactCount', 'stale_artifact_count')
      ?? field(snapshot, 'staleArtifactCount', 'stale_artifact_count'),
    unresolvedHighIssues: field(base, 'unresolvedHighIssues', 'unresolved_high_issues')
      ?? field(snapshot, 'unresolvedHighIssues', 'unresolved_high_issues'),
    unresolvedCriticalIssues: field(base, 'unresolvedCriticalIssues', 'unresolved_critical_issues')
      ?? field(snapshot, 'unresolvedCriticalIssues', 'unresolved_critical_issues'),
    unresolvedMergeConflicts: field(base, 'unresolvedMergeConflicts', 'unresolved_merge_conflicts')
      ?? field(snapshot, 'unresolvedMergeConflicts', 'unresolved_merge_conflicts'),
    integrity,
    finalOutput: normalizeFinalOutputInput(output),
    blockers: Array.isArray(blockers) ? blockers : [],
    failures: Array.isArray(failures) ? failures : [],
  };
}

function normalizeRuntimeErrorInput(value: unknown, fallbackNow: string): unknown {
  if (typeof value === 'string') {
    const hardBudget = /hard[\s_-]*budget/i.test(value);
    return {
      phase: hardBudget ? 'budget' : 'translation',
      code: hardBudget ? 'HARD_BUDGET_EXCEEDED' : 'TRANSLATION_RUNTIME_ERROR',
      message: value,
      retryable: !hardBudget,
      occurredAt: fallbackNow,
    };
  }
  if (!isRecord(value)) return value;
  const code = typeof value.code === 'string' ? value.code : 'TRANSLATION_RUNTIME_ERROR';
  const hardBudget = code.toUpperCase().includes('HARD_BUDGET');
  return {
    phase: value.phase ?? (hardBudget ? 'budget' : 'translation'),
    code,
    message: value.message,
    retryable: value.retryable ?? !hardBudget,
    occurredAt: field(value, 'occurredAt', 'occurred_at') ?? fallbackNow,
    details: value.details,
  };
}

export function parseTranslationQualityPolicyReceipt(
  value: unknown,
): ParseResult<TranslationProjectQualityPolicyReceipt> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['qualityPolicy must be an object'] };
  if (value.receiptVersion !== TRANSLATION_RUNTIME_RECEIPT_VERSION) {
    errors.push('qualityPolicy.receiptVersion is unsupported');
  }
  if (!isIsoDate(value.recordedAt)) errors.push('qualityPolicy.recordedAt is invalid');
  const probe = value.capabilityEvidence;
  if (!isRecord(probe)) {
    errors.push('qualityPolicy.capabilityEvidence must be an object');
  } else {
    for (const key of ['bgeM3', 'rag'] as const) {
      const entry = probe[key];
      if (entry !== undefined && !isRecord(entry)) {
        errors.push(`qualityPolicy.capabilityEvidence.${key} must be an object when present`);
      } else if (
        isRecord(entry)
        && !['ready', 'missing', 'unhealthy', 'unknown'].includes(String(entry.status))
      ) {
        errors.push(`qualityPolicy.capabilityEvidence.${key}.status is invalid`);
      }
    }
  }
  const effectiveWorkflow = parseWorkflowAt(
    value.effectiveWorkflow,
    'qualityPolicy.effectiveWorkflow',
    errors,
  );
  const policy = value.policy;
  let requestedWorkflow: WorkflowOptions | null = null;
  let policyWorkflow: WorkflowOptions | null = null;
  if (!isRecord(policy)) {
    errors.push('qualityPolicy.policy must be an object');
  } else {
    requestedWorkflow = parseWorkflowAt(
      policy.requestedWorkflow,
      'qualityPolicy.policy.requestedWorkflow',
      errors,
    );
    policyWorkflow = parseWorkflowAt(
      policy.effectiveWorkflow,
      'qualityPolicy.policy.effectiveWorkflow',
      errors,
    );
    if (!isRecord(policy.model) || !isNonEmptyString(policy.model.selectedModelId)) {
      errors.push('qualityPolicy.policy.model.selectedModelId is required');
    } else {
      if (!isAllowedTranslationQualityModel(policy.model.selectedModelId)) {
        errors.push('qualityPolicy.policy.model identifier is invalid');
      }
      const selectedName = policy.model.selectedModelName;
      const fallbackUsed = policy.model.fallbackUsed;
      const expectedName = policy.model.selectedModelId.split(/[\\/]/).at(-1)?.trim();
      if (!isNonEmptyString(selectedName) || selectedName !== expectedName) {
        errors.push('qualityPolicy.policy.model.selectedModelName must match the selected model id');
      }
      if (typeof fallbackUsed !== 'boolean') {
        errors.push('qualityPolicy.policy.model.fallbackUsed must be boolean');
      }
    }
    if (!isRecord(policy.capability)) {
      errors.push('qualityPolicy.policy.capability must be an object');
    } else if (isRecord(probe)) {
      try {
        const resolved = detectTranslationQualityCapability(
          probe as unknown as Parameters<typeof detectTranslationQualityCapability>[0],
        );
        for (const key of ['mode', 'bgeM3Ready', 'ragReady', 'retrievalUsable'] as const) {
          if (policy.capability[key] !== resolved[key]) {
            errors.push(`qualityPolicy.policy.capability.${key} does not match probe evidence`);
          }
        }
      } catch {
        errors.push('qualityPolicy.capabilityEvidence contains invalid probe values');
      }
    }
  }
  if (effectiveWorkflow && policyWorkflow && !sameWorkflow(effectiveWorkflow, policyWorkflow)) {
    errors.push('qualityPolicy.effectiveWorkflow does not match policy.effectiveWorkflow');
  }
  const mode = isRecord(policy) && isRecord(policy.capability) ? policy.capability.mode : undefined;
  if (mode !== 'bge-rag' && mode !== 'adjacent-chapter-fallback') {
    errors.push('qualityPolicy.policy.capability.mode is invalid');
  }
  if (
    mode === 'adjacent-chapter-fallback'
    && effectiveWorkflow !== null
    && effectiveWorkflow.secondReview !== true
  ) {
    errors.push('qualityPolicy must force the second review when BGE-M3/RAG is unavailable');
  }
  if (
    requestedWorkflow
    && effectiveWorkflow
    && mode === 'bge-rag'
    && !sameWorkflow(requestedWorkflow, effectiveWorkflow)
  ) {
    errors.push('qualityPolicy must not silently change workflow when BGE-M3/RAG is ready');
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as TranslationProjectQualityPolicyReceipt };
}

export function createTranslationQualityPolicyReceipt(
  input: Omit<TranslationProjectQualityPolicyReceipt, 'receiptVersion' | 'effectiveWorkflow'>
    & { effectiveWorkflow?: WorkflowOptions },
): TranslationProjectQualityPolicyReceipt {
  return requireParsed(
    parseTranslationQualityPolicyReceipt({
      ...input,
      receiptVersion: TRANSLATION_RUNTIME_RECEIPT_VERSION,
      effectiveWorkflow: {
        ...(input.effectiveWorkflow ?? input.policy.effectiveWorkflow),
      },
    }),
    'quality policy receipt',
  );
}

export function parseTranslationInitialization(
  value: unknown,
): ParseResult<TranslationInitializationReceipt> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['initialization must be an object'] };
  if (value.receiptVersion !== TRANSLATION_RUNTIME_RECEIPT_VERSION) {
    errors.push('initialization.receiptVersion is unsupported');
  }
  if (value.initialized !== true) errors.push('initialization.initialized must be true');
  if (!isIsoDate(value.initializedAt)) errors.push('initialization.initializedAt is invalid');
  const source = value.sourceReceipt;
  if (!isRecord(source)) {
    errors.push('initialization.sourceReceipt must be an object');
  } else {
    if (!isNonEmptyString(source.sourcePath)) errors.push('initialization.sourceReceipt.sourcePath is required');
    if (!['epub', 'txt'].includes(String(source.format))) errors.push('initialization.sourceReceipt.format is invalid');
    if (!isSha256(source.sha256)) errors.push('initialization.sourceReceipt.sha256 is invalid');
    if (!isNonNegativeInteger(source.byteLength)) errors.push('initialization.sourceReceipt.byteLength is invalid');
    if (source.immutable !== true || source.verified !== true) {
      errors.push('initialization.sourceReceipt must be immutable and verified');
    }
    if (!isNonEmptyString(source.copiedPath)) {
      errors.push('initialization.sourceReceipt.copiedPath is required');
    }
    if (!isSha256(source.copiedSha256) || source.copiedSha256 !== source.sha256) {
      errors.push('initialization.sourceReceipt copied hash does not match source hash');
    }
  }
  const manifest = value.manifest;
  if (!isRecord(manifest)) {
    errors.push('initialization.manifest must be an object');
  } else {
    if (!isNonEmptyString(manifest.path)) errors.push('initialization.manifest.path is required');
    if (!isSha256(manifest.sha256)) errors.push('initialization.manifest.sha256 is invalid');
    for (const key of ['schemaVersion', 'chapterCount', 'paragraphCount', 'sourceWordCount'] as const) {
      if (!isNonNegativeInteger(manifest[key])) errors.push(`initialization.manifest.${key} is invalid`);
    }
    if (!isNonEmptyString(manifest.bookId)) errors.push('initialization.manifest.bookId is required');
  }
  const ledger = value.ledgerSummary;
  if (!isRecord(ledger)) {
    errors.push('initialization.ledgerSummary must be an object');
  } else {
    if (!isNonEmptyString(ledger.databasePath)) errors.push('initialization.ledgerSummary.databasePath is required');
    if (!isNonEmptyString(ledger.projectId)) errors.push('initialization.ledgerSummary.projectId is required');
    if (String(ledger.journalMode).toLowerCase() !== 'wal') errors.push('initialization.ledgerSummary.journalMode must be wal');
    if (!isNonNegativeInteger(ledger.schemaVersion)) errors.push('initialization.ledgerSummary.schemaVersion is invalid');
    if (!isNonNegativeInteger(ledger.instructionVersion)) errors.push('initialization.ledgerSummary.instructionVersion is invalid');
    if (!isCountRecord(ledger.taskCounts)) errors.push('initialization.ledgerSummary.taskCounts is invalid');
    if (!isNonNegativeInteger(ledger.artifactCount)) errors.push('initialization.ledgerSummary.artifactCount is invalid');
    if (ledger.integrityOk !== true) errors.push('initialization.ledgerSummary.integrityOk must be true');
  }
  if (!Array.isArray(value.chapters)) {
    errors.push('initialization.chapters must be an array');
  } else {
    const chapterIds = new Set<string>();
    value.chapters.forEach((chapter, index) => {
      const path = `initialization.chapters[${index}]`;
      if (!isRecord(chapter)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (!isNonEmptyString(chapter.chapterId) || chapterIds.has(chapter.chapterId)) {
        errors.push(`${path}.chapterId must be unique and non-empty`);
      } else chapterIds.add(chapter.chapterId);
      if (!isNonNegativeInteger(chapter.spineIndex)) errors.push(`${path}.spineIndex is invalid`);
      if (!isNonEmptyString(chapter.sourcePath)) errors.push(`${path}.sourcePath is required`);
      if (!isNonNegativeInteger(chapter.paragraphCount)) errors.push(`${path}.paragraphCount is invalid`);
      if (chapter.sourceHash !== undefined && !isSha256(chapter.sourceHash)) errors.push(`${path}.sourceHash is invalid`);
    });
    if (isRecord(manifest) && isNonNegativeInteger(manifest.chapterCount) && value.chapters.length !== manifest.chapterCount) {
      errors.push('initialization chapter count does not match manifest');
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as TranslationInitializationReceipt };
}

export function createTranslationInitialization(
  input: Omit<TranslationInitializationReceipt, 'receiptVersion' | 'initialized'>,
): TranslationInitializationReceipt {
  return requireParsed(
    parseTranslationInitialization({
      ...input,
      receiptVersion: TRANSLATION_RUNTIME_RECEIPT_VERSION,
      initialized: true,
    }),
    'translation initialization',
  );
}

export function parseTranslationInstructionReceipt(
  value: unknown,
): ParseResult<TranslationInstructionReceipt> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['instruction receipt must be an object'] };
  if (value.receiptVersion !== TRANSLATION_RUNTIME_RECEIPT_VERSION) {
    errors.push('instruction receipt version is unsupported');
  }
  if (!isNonEmptyString(value.eventId)) errors.push('instruction.eventId is required');
  if (!isNonEmptyString(value.sessionMessageId)) errors.push('instruction.sessionMessageId is required');
  if (!isNonNegativeInteger(value.instructionVersion) || value.instructionVersion < 1) {
    errors.push('instruction.instructionVersion must be a positive integer');
  }
  if (!isNonEmptyString(value.message)) errors.push('instruction.message is required');
  if (!['SOFT', 'HARD'].includes(String(value.interruptMode))) {
    errors.push('instruction.interruptMode is invalid');
  }
  if (!isIsoDate(value.appliedAt)) errors.push('instruction.appliedAt is invalid');
  const scope = value.affectedScope;
  if (!isRecord(scope)) {
    errors.push('instruction.affectedScope must be an object');
  } else {
    for (const key of ['affectedTaskIds', 'affectedChapterIds', 'affectedEntities'] as const) {
      if (!isStringArray(scope[key])) errors.push(`instruction.affectedScope.${key} is invalid`);
    }
    if (typeof scope.global !== 'boolean') errors.push('instruction.affectedScope.global must be boolean');
    if (!isNonEmptyString(scope.reason)) errors.push('instruction.affectedScope.reason is required');
  }
  for (const key of [
    'continuedTaskIds',
    'cancelledTaskIds',
    'interruptedTaskIds',
    'staleTaskIds',
    'replacementTaskIds',
  ] as const) {
    if (!isStringArray(value[key])) errors.push(`instruction.${key} is invalid`);
  }
  const cost = value.costImpact;
  if (!isRecord(cost)) {
    errors.push('instruction.costImpact must be an object');
  } else {
    for (const key of [
      'actualCostMicrosDelta',
      'discardedCostMicros',
      'estimatedAdditionalCostMicros',
      'additionalPaidTaskCount',
    ] as const) {
      if (!isNonNegativeInteger(cost[key])) errors.push(`instruction.costImpact.${key} is invalid`);
    }
    if (cost.reason !== undefined && !isNonEmptyString(cost.reason)) {
      errors.push('instruction.costImpact.reason must be non-empty when present');
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as TranslationInstructionReceipt };
}

export function createTranslationInstructionReceipt(
  input: Omit<TranslationInstructionReceipt, 'receiptVersion'>,
): TranslationInstructionReceipt {
  return requireParsed(
    parseTranslationInstructionReceipt({
      ...input,
      receiptVersion: TRANSLATION_RUNTIME_RECEIPT_VERSION,
    }),
    'translation instruction receipt',
  );
}

function validateCompletionIntegrity(value: unknown, errors: string[]): boolean {
  if (!isRecord(value)) {
    errors.push('completionVerification.integrity must be an object');
    return false;
  }
  if (typeof value.ok !== 'boolean') errors.push('completionVerification.integrity.ok must be boolean');
  for (const key of [
    'sqliteIntegrity',
    'missingArtifactFiles',
    'mismatchedArtifactHashes',
    'sourceHashMismatches',
  ] as const) {
    if (!Array.isArray(value[key]) || value[key].some((entry) => typeof entry !== 'string')) {
      errors.push(`completionVerification.integrity.${key} is invalid`);
    }
  }
  if (!Array.isArray(value.foreignKeyViolations) || value.foreignKeyViolations.some((entry) => !isRecord(entry))) {
    errors.push('completionVerification.integrity.foreignKeyViolations is invalid');
  }
  return value.ok === true;
}

export function parseTranslationCompletionVerification(
  value: unknown,
): ParseResult<TranslationCompletionVerification> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['completionVerification must be an object'] };
  if (value.receiptVersion !== TRANSLATION_RUNTIME_RECEIPT_VERSION) {
    errors.push('completionVerification.receiptVersion is unsupported');
  }
  if (!isNonEmptyString(value.snapshotId)) errors.push('completionVerification.snapshotId is required');
  if (!isIsoDate(value.verifiedAt)) errors.push('completionVerification.verifiedAt is invalid');
  if (!['passed', 'failed'].includes(String(value.status))) errors.push('completionVerification.status is invalid');
  if (typeof value.verified !== 'boolean') errors.push('completionVerification.verified must be boolean');
  if (typeof value.complete !== 'boolean') errors.push('completionVerification.complete must be boolean');
  if (!isSha256(value.sourceSha256)) errors.push('completionVerification.sourceSha256 is invalid');
  if (!isNonEmptyString(value.planFingerprint)) {
    errors.push('completionVerification.planFingerprint is required');
  }
  if (!isNonNegativeInteger(value.instructionVersion)) errors.push('completionVerification.instructionVersion is invalid');
  if (!isCountRecord(value.taskCounts)) errors.push('completionVerification.taskCounts is invalid');
  for (const key of [
    'attemptCount',
    'activeArtifactCount',
    'staleArtifactCount',
    'unresolvedHighIssues',
    'unresolvedCriticalIssues',
    'unresolvedMergeConflicts',
  ] as const) {
    if (!isNonNegativeInteger(value[key])) errors.push(`completionVerification.${key} is invalid`);
  }
  const integrityOk = validateCompletionIntegrity(value.integrity, errors);
  if (!Array.isArray(value.blockers) || value.blockers.some((entry) => typeof entry !== 'string')) {
    errors.push('completionVerification.blockers is invalid');
  }
  if (!Array.isArray(value.failures) || value.failures.some((entry) => typeof entry !== 'string')) {
    errors.push('completionVerification.failures is invalid');
  }
  const output = value.finalOutput;
  if (output !== undefined) {
    if (!isRecord(output)) {
      errors.push('completionVerification.finalOutput must be an object');
    } else {
      if (!['epub', 'txt'].includes(String(output.artifactType))) errors.push('completionVerification.finalOutput.artifactType is invalid');
      for (const key of ['path', 'sourcePath'] as const) {
        if (!isNonEmptyString(output[key])) errors.push(`completionVerification.finalOutput.${key} is required`);
      }
      for (const key of ['sourceSha256', 'sha256'] as const) {
        if (!isSha256(output[key])) errors.push(`completionVerification.finalOutput.${key} is invalid`);
      }
      for (const key of ['byteLength', 'paragraphCount', 'translatedParagraphCount'] as const) {
        if (!isNonNegativeInteger(output[key])) errors.push(`completionVerification.finalOutput.${key} is invalid`);
      }
      if (!isFiniteNonNegativeNumber(output.coverage) || output.coverage > 1) {
        errors.push('completionVerification.finalOutput.coverage is invalid');
      }
      if (output.immutable !== true) errors.push('completionVerification.finalOutput.immutable must be true');
      if (typeof output.structuralValidationPassed !== 'boolean') {
        errors.push('completionVerification.finalOutput.structuralValidationPassed must be boolean');
      }
      if (
        output.epubcheckStatus !== undefined
        && !['passed', 'failed', 'unavailable', 'timed_out'].includes(String(output.epubcheckStatus))
      ) {
        errors.push('completionVerification.finalOutput.epubcheckStatus is invalid');
      }
      if (!isIsoDate(output.createdAt)) errors.push('completionVerification.finalOutput.createdAt is invalid');
    }
  }
  const blockersEmpty = Array.isArray(value.blockers) && value.blockers.length === 0;
  const failuresEmpty = Array.isArray(value.failures) && value.failures.length === 0;
  if (value.status === 'passed') {
    if (value.verified !== true || value.complete !== true || !integrityOk) {
      errors.push('passed completion verification must be verified, complete, and integrity-safe');
    }
    if (!blockersEmpty || !failuresEmpty) errors.push('passed completion verification cannot contain blockers or failures');
    if (!isRecord(output)) errors.push('passed completion verification requires finalOutput');
    else {
      if (output.coverage !== 1 || output.structuralValidationPassed !== true) {
        errors.push('passed final output requires full coverage and structural validation');
      }
      if (output.sourceSha256 !== value.sourceSha256) {
        errors.push('completionVerification final output source hash mismatch');
      }
    }
    for (const key of ['staleArtifactCount', 'unresolvedHighIssues', 'unresolvedCriticalIssues', 'unresolvedMergeConflicts'] as const) {
      if (value[key] !== 0) errors.push(`passed completion verification requires ${key}=0`);
    }
  } else if (value.verified !== false) {
    errors.push('failed completion verification must set verified=false');
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as TranslationCompletionVerification };
}

export function createTranslationCompletionVerification(
  input: Omit<TranslationCompletionVerification, 'receiptVersion'>,
): TranslationCompletionVerification {
  return requireParsed(
    parseTranslationCompletionVerification({
      ...input,
      receiptVersion: TRANSLATION_RUNTIME_RECEIPT_VERSION,
    }),
    'translation completion verification',
  );
}

export function parseTranslationRuntimeError(value: unknown): ParseResult<TranslationRuntimeError> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['runtimeError must be an object'] };
  if (!['quality_probe', 'initialization', 'translation', 'instruction', 'budget', 'completion', 'export'].includes(String(value.phase))) {
    errors.push('runtimeError.phase is invalid');
  }
  if (!isNonEmptyString(value.code)) errors.push('runtimeError.code is required');
  if (!isNonEmptyString(value.message)) errors.push('runtimeError.message is required');
  if (typeof value.retryable !== 'boolean') errors.push('runtimeError.retryable must be boolean');
  if (!isIsoDate(value.occurredAt)) errors.push('runtimeError.occurredAt is invalid');
  if (value.details !== undefined && !isRecord(value.details)) errors.push('runtimeError.details must be an object when present');
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as TranslationRuntimeError };
}

export function parseTranslationReportReceipt(value: unknown): ParseResult<TranslationReportReceipt> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['reportReceipt must be an object'] };
  const normalized = {
    path: value.path,
    sha256: value.sha256,
    generatedAt: field(value, 'generatedAt', 'generated_at'),
    summary: value.summary,
  };
  if (!isNonEmptyString(normalized.path)) errors.push('reportReceipt.path is required');
  if (!isSha256(normalized.sha256)) errors.push('reportReceipt.sha256 is invalid');
  if (!isIsoDate(normalized.generatedAt)) errors.push('reportReceipt.generatedAt is invalid');
  if (normalized.summary !== undefined && !isRecord(normalized.summary)) {
    errors.push('reportReceipt.summary must be an object when present');
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: normalized as TranslationReportReceipt };
}

function pathSeparator(path: string): '/' | '\\' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

export function joinLocalPath(root: string, ...parts: string[]): string {
  const separator = pathSeparator(root);
  const cleanRoot = root.replace(/[\\/]+$/, '');
  const cleanParts = parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''));
  const joined = [cleanRoot, ...cleanParts].filter(Boolean).join(separator);
  if (!cleanRoot && root.startsWith(separator)) return `${separator}${joined}`;
  return joined;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'source.epub';
}

export function buildTranslationPaths(
  projectRoot: string,
  sourcePath: string,
  kind: TranslationSourceKind,
): TranslationPaths {
  const stateDir = joinLocalPath(projectRoot, 'state');
  const finalDir = joinLocalPath(projectRoot, 'final');
  const finalOutputName = kind === 'txt' ? 'book.zh-CN.txt' : 'book.zh-CN.epub';
  return {
    projectRoot,
    sourcePath,
    sourceCopy: joinLocalPath(projectRoot, 'source', basename(sourcePath)),
    unpackedDir: joinLocalPath(projectRoot, 'source', 'unpacked'),
    manifestPath: joinLocalPath(stateDir, 'book_manifest.json'),
    memoryDir: joinLocalPath(projectRoot, 'memory'),
    translationDir: joinLocalPath(projectRoot, 'translation'),
    reviewsDir: joinLocalPath(projectRoot, 'reviews'),
    repairsDir: joinLocalPath(projectRoot, 'repairs'),
    finalDir,
    logsDir: joinLocalPath(projectRoot, 'logs'),
    stateDir,
    taskManifestPath: joinLocalPath(stateDir, 'tasks.jsonl'),
    issuesPath: joinLocalPath(projectRoot, 'reviews', 'issues.jsonl'),
    checkpointPath: joinLocalPath(stateDir, 'checkpoints.jsonl'),
    finalOutputPath: joinLocalPath(finalDir, finalOutputName),
    finalReportPath: joinLocalPath(finalDir, 'report.md'),
  };
}

function generatedId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return `${prefix}_${randomId}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createTranslationProject(
  input: CreateTranslationProjectInput,
): TranslationProject {
  if (!input.name.trim()) throw new Error('Project name cannot be empty');
  const sourcePath = input.sourcePath.trim();
  if (!sourcePath) throw new Error('Source file path cannot be empty');
  if (!/\.(epub|txt)$/i.test(sourcePath)) {
    throw new Error('Source file must have an .epub or .txt extension');
  }
  const kind = input.kind ?? sourceKindOfPath(sourcePath);
  const extensionKind = sourceKindOfPath(sourcePath);
  if (kind !== extensionKind) {
    throw new Error(`Source kind ${kind} does not match the .${extensionKind} file extension`);
  }
  if (!input.projectRoot.trim()) throw new Error('Project root cannot be empty');
  if (input.projectId !== undefined && !input.projectId.trim()) {
    throw new Error('Project ID cannot be empty');
  }
  if (input.model !== undefined && !input.model.trim()) {
    throw new Error('Project model cannot be empty');
  }
  if (input.sourceSha256 !== undefined && !isSha256(input.sourceSha256)) {
    throw new Error('Source SHA-256 must contain exactly 64 lowercase hexadecimal characters');
  }
  if (input.sourceSizeBytes !== undefined && !isNonNegativeInteger(input.sourceSizeBytes)) {
    throw new Error('Source size must be a non-negative integer');
  }
  const now = input.now ?? new Date().toISOString();
  if (!isIsoDate(now)) throw new Error('Project timestamp must be a valid ISO date');
  const qualityPolicy = input.qualityPolicy === undefined
    ? undefined
    : requireParsed(
        parseTranslationQualityPolicyReceipt(input.qualityPolicy),
        'quality policy receipt',
      );
  if (
    qualityPolicy !== undefined
    && !sameWorkflow(qualityPolicy.policy.requestedWorkflow, input.workflow)
    && !sameWorkflow(qualityPolicy.effectiveWorkflow, input.workflow)
  ) {
    throw new Error('Quality policy workflow does not match project creation options');
  }
  const workflow = {
    ...(qualityPolicy?.effectiveWorkflow ?? input.workflow),
  };
  const normalizedMaxAgents = normalizeMaxAgents(input.maxAgents);
  const executionPolicy = normalizeExecutionPolicy(
    input.executionPolicy,
    Math.min(normalizedMaxAgents, 8),
  );
  const selectedModel = input.model?.trim() || qualityPolicy?.policy.model.selectedModelId;
  if (
    qualityPolicy !== undefined
    && selectedModel !== qualityPolicy.policy.model.selectedModelId
  ) {
    throw new Error('Project model does not match the recorded quality policy');
  }
  const stages = createStageRunStates(workflow, kind);
  const plan = stages.map((stage) => stage.definition);
  const source: TranslationSource = {
    kind,
    sourcePath,
    immutable: true,
    ...(input.sourceSha256 !== undefined ? { sha256: input.sourceSha256 } : {}),
    ...(input.sourceSizeBytes !== undefined ? { sizeBytes: input.sourceSizeBytes } : {}),
    ...(input.chapterPattern?.trim() ? { chapterPattern: input.chapterPattern.trim() } : {}),
  };
  return {
    schemaVersion: TRANSLATION_PROJECT_SCHEMA_VERSION,
    projectId: input.projectId ?? generatedId('translation'),
    name: input.name.trim(),
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(qualityPolicy ? { qualityPolicy } : {}),
    instructionVersion: 0,
    instructionReceipts: [],
    executionPolicy,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    source,
    paths: buildTranslationPaths(input.projectRoot, sourcePath, kind),
    workflow,
    maxAgents: normalizedMaxAgents,
    status: 'draft',
    planFingerprint: planFingerprint(plan),
    stages,
    chapters: [],
    issues: [],
    artifacts: [],
    checkpoints: [],
    overrides: [],
    overrideRevision: 0,
    promptVersion: TRANSLATION_PROMPT_VERSION,
  };
}

function validatePaths(value: unknown, errors: string[]): value is TranslationPaths {
  if (!isRecord(value)) {
    errors.push('paths must be an object');
    return false;
  }
  const keys: Array<keyof TranslationPaths> = [
    'projectRoot',
    'sourcePath',
    'sourceCopy',
    'unpackedDir',
    'manifestPath',
    'memoryDir',
    'translationDir',
    'reviewsDir',
    'repairsDir',
    'finalDir',
    'logsDir',
    'stateDir',
    'taskManifestPath',
    'issuesPath',
    'checkpointPath',
    'finalOutputPath',
    'finalReportPath',
  ];
  for (const key of keys) {
    if (!isNonEmptyString(value[key])) {
      errors.push(`paths.${key} must be a non-empty string`);
    }
  }
  return errors.length === 0;
}

function parseWorkflow(value: unknown, errors: string[]): WorkflowOptions | null {
  return parseWorkflowAt(value, 'workflow', errors);
}

function sameStageDefinition(
  stored: Record<string, unknown>,
  expected: ReturnType<typeof buildStagePlan>[number],
): boolean {
  return (
    stored.id === expected.id
    && stored.kind === expected.kind
    && stored.label === expected.label
    && stored.required === expected.required
    && stored.execution === expected.execution
    && stored.pass === expected.pass
    && Array.isArray(stored.dependsOn)
    && stored.dependsOn.length === expected.dependsOn.length
    && stored.dependsOn.every((dependency, index) => dependency === expected.dependsOn[index])
  );
}

function validateStages(
  value: unknown,
  workflow: WorkflowOptions | null,
  kind: TranslationSourceKind,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push('stages must be an array');
    return;
  }
  if (!workflow) return;
  const expected = buildStagePlan(workflow, kind);
  if (value.length !== expected.length) {
    errors.push('stages do not match the program-owned workflow plan');
    return;
  }
  value.forEach((state, index) => {
    if (!isRecord(state) || !isRecord(state.definition)) {
      errors.push(`stages[${index}] is invalid`);
      return;
    }
    if (!sameStageDefinition(state.definition, expected[index]!)) {
      errors.push(`stages[${index}].definition was changed or reordered`);
    }
    if (!['pending', 'running', 'blocked', 'failed', 'completed', 'stale'].includes(String(state.status))) {
      errors.push(`stages[${index}].status is invalid`);
    }
    if (!isNonNegativeInteger(state.attempt)) {
      errors.push(`stages[${index}].attempt is invalid`);
    }
    if (!isRecord(state.taskCounts)) {
      errors.push(`stages[${index}].taskCounts is invalid`);
    } else {
      for (const key of ['total', 'pending', 'running', 'failed', 'completed'] as const) {
        if (!isNonNegativeInteger(state.taskCounts[key])) {
          errors.push(`stages[${index}].taskCounts.${key} is invalid`);
        }
      }
    }
  });
}

function validateChapters(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('chapters must be an array');
    return;
  }
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const path = `chapters[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!isNonEmptyString(entry.chapterId) || ids.has(entry.chapterId)) {
      errors.push(`${path}.chapterId must be unique and non-empty`);
    } else ids.add(entry.chapterId);
    if (!isNonEmptyString(entry.title)) errors.push(`${path}.title is required`);
    if (!isNonNegativeInteger(entry.spineIndex)) errors.push(`${path}.spineIndex is invalid`);
    if (!isNonEmptyString(entry.sourcePath)) errors.push(`${path}.sourcePath is required`);
    if (!isNonNegativeInteger(entry.paragraphCount)) errors.push(`${path}.paragraphCount is invalid`);
    if (!isNonNegativeInteger(entry.completedParagraphs)) {
      errors.push(`${path}.completedParagraphs is invalid`);
    } else if (
      isNonNegativeInteger(entry.paragraphCount)
      && entry.completedParagraphs > entry.paragraphCount
    ) {
      errors.push(`${path}.completedParagraphs exceeds paragraphCount`);
    }
    if (!['pending', 'analyzing', 'translating', 'reviewing', 'repairing', 'failed', 'completed'].includes(String(entry.status))) {
      errors.push(`${path}.status is invalid`);
    }
    if (!isNonNegativeInteger(entry.openIssueCount)) errors.push(`${path}.openIssueCount is invalid`);
    if (!isNonNegativeInteger(entry.highOrCriticalIssueCount)) {
      errors.push(`${path}.highOrCriticalIssueCount is invalid`);
    }
    if (!isIsoDate(entry.updatedAt)) errors.push(`${path}.updatedAt is invalid`);
  });
}

function validateIssues(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('issues must be an array');
    return;
  }
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const path = `issues[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!isNonEmptyString(entry.issueId) || ids.has(entry.issueId)) {
      errors.push(`${path}.issueId must be unique and non-empty`);
    } else ids.add(entry.issueId);
    if (!isNonEmptyString(entry.stageId)) errors.push(`${path}.stageId is required`);
    if (!Array.isArray(entry.paragraphIds) || entry.paragraphIds.some((id) => !isNonEmptyString(id))) {
      errors.push(`${path}.paragraphIds is invalid`);
    }
    if (!isNonEmptyString(entry.category)) errors.push(`${path}.category is required`);
    if (!['info', 'minor', 'major', 'high', 'critical'].includes(String(entry.severity))) {
      errors.push(`${path}.severity is invalid`);
    }
    if (!['open', 'repair_pending', 'resolved', 'wont_fix'].includes(String(entry.status))) {
      errors.push(`${path}.status is invalid`);
    }
    for (const key of ['sourceEvidence', 'targetEvidence', 'storyMemoryIds', 'resolvedByPatchIds'] as const) {
      const evidence = entry[key];
      if (!Array.isArray(evidence) || evidence.some((item) => !isNonEmptyString(item))) {
        errors.push(`${path}.${key} is invalid`);
      }
    }
    if (!isNonEmptyString(entry.explanation)) errors.push(`${path}.explanation is required`);
    if (!isNonEmptyString(entry.suggestedAction)) errors.push(`${path}.suggestedAction is required`);
    if (!isIsoDate(entry.createdAt)) errors.push(`${path}.createdAt is invalid`);
  });
}

function validateArtifacts(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('artifacts must be an array');
    return;
  }
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const path = `artifacts[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!isNonEmptyString(entry.artifactId) || ids.has(entry.artifactId)) {
      errors.push(`${path}.artifactId must be unique and non-empty`);
    } else ids.add(entry.artifactId);
    if (!isNonEmptyString(entry.stageId)) errors.push(`${path}.stageId is required`);
    if (!isNonEmptyString(entry.type)) errors.push(`${path}.type is required`);
    if (!isNonEmptyString(entry.path)) errors.push(`${path}.path is required`);
    if (!['pending', 'ready', 'invalid'].includes(String(entry.status))) {
      errors.push(`${path}.status is invalid`);
    }
    if (!isIsoDate(entry.createdAt)) errors.push(`${path}.createdAt is invalid`);
    if (typeof entry.immutable !== 'boolean') errors.push(`${path}.immutable must be boolean`);
  });
}

function validateCheckpoints(
  value: unknown,
  expectedFingerprint: string | null,
  overrideRevision: unknown,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push('checkpoints must be an array');
    return;
  }
  let previousSequence = 0;
  value.forEach((entry, index) => {
    const path = `checkpoints[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!isNonEmptyString(entry.checkpointId)) errors.push(`${path}.checkpointId is required`);
    if (!isNonEmptyString(entry.stageId)) errors.push(`${path}.stageId is required`);
    if (!isNonNegativeInteger(entry.stageIndex)) errors.push(`${path}.stageIndex is invalid`);
    if (!isNonNegativeInteger(entry.sequence) || entry.sequence <= previousSequence) {
      errors.push(`${path}.sequence must be strictly increasing`);
    } else previousSequence = entry.sequence;
    if (!isIsoDate(entry.createdAt)) errors.push(`${path}.createdAt is invalid`);
    if (!isNonEmptyString(entry.promptVersion)) errors.push(`${path}.promptVersion is required`);
    if (!isNonNegativeInteger(entry.overrideRevision)) {
      errors.push(`${path}.overrideRevision is invalid`);
    } else if (
      isNonNegativeInteger(overrideRevision)
      && entry.overrideRevision > overrideRevision
    ) {
      errors.push(`${path}.overrideRevision is ahead of the project ledger`);
    }
    if (expectedFingerprint !== null && entry.planFingerprint !== expectedFingerprint) {
      errors.push(`${path}.planFingerprint does not match the project plan`);
    }
    if (!Array.isArray(entry.completedTaskIds) || entry.completedTaskIds.some((id) => !isNonEmptyString(id))) {
      errors.push(`${path}.completedTaskIds is invalid`);
    }
  });
}

function validateOverrideScope(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}.scope must be an object`);
    return;
  }
  if (value.kind === 'project') return;
  if (value.kind === 'chapter') {
    if (!isNonEmptyString(value.chapterId)) errors.push(`${path}.scope.chapterId is required`);
    return;
  }
  if (value.kind === 'paragraph') {
    if (!isNonEmptyString(value.chapterId)) errors.push(`${path}.scope.chapterId is required`);
    if (
      !Array.isArray(value.paragraphIds)
      || value.paragraphIds.length === 0
      || value.paragraphIds.some((paragraphId) => !isNonEmptyString(paragraphId))
    ) {
      errors.push(`${path}.scope.paragraphIds must contain stable paragraph IDs`);
    }
    return;
  }
  errors.push(`${path}.scope.kind is invalid`);
}

function validateOverrides(
  value: unknown,
  overrideRevision: unknown,
  stageCount: number,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push('overrides must be an array');
    return;
  }
  let previousVersion = 0;
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const path = `overrides[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!isNonEmptyString(entry.overrideId) || ids.has(entry.overrideId)) {
      errors.push(`${path}.overrideId must be unique and non-empty`);
    } else {
      ids.add(entry.overrideId);
    }
    if (!isNonNegativeInteger(entry.version) || entry.version <= previousVersion) {
      errors.push(`${path}.version must be strictly increasing`);
    } else {
      previousVersion = entry.version;
    }
    if (
      !isNonEmptyString(entry.instruction)
      || entry.instruction.length > MAX_OVERRIDE_INSTRUCTION_LENGTH
    ) {
      errors.push(`${path}.instruction is invalid`);
    }
    validateOverrideScope(entry.scope, path, errors);
    if (!['queued', 'applied', 'superseded', 'rejected'].includes(String(entry.status))) {
      errors.push(`${path}.status is invalid`);
    }
    if (!isIsoDate(entry.createdAt)) errors.push(`${path}.createdAt is invalid`);
    if (
      !isNonNegativeInteger(entry.effectiveFromStageIndex)
      || entry.effectiveFromStageIndex >= stageCount
    ) {
      errors.push(`${path}.effectiveFromStageIndex is out of range`);
    }
    if (!isNonNegativeInteger(entry.basedOnProjectRevision)) {
      errors.push(`${path}.basedOnProjectRevision is invalid`);
    }
    if (entry.canModifyWorkflow !== false) {
      errors.push(`${path}.canModifyWorkflow must remain false`);
    }
    if (entry.status === 'applied' && !isIsoDate(entry.appliedAt)) {
      errors.push(`${path}.appliedAt is required for an applied override`);
    }
    if (entry.status === 'superseded' && !isNonEmptyString(entry.supersededBy)) {
      errors.push(`${path}.supersededBy is required for a superseded override`);
    }
    if (entry.status === 'rejected' && !isNonEmptyString(entry.rejectionReason)) {
      errors.push(`${path}.rejectionReason is required for a rejected override`);
    }
  });
  if (isNonNegativeInteger(overrideRevision) && previousVersion !== overrideRevision) {
    errors.push('overrideRevision must equal the latest immutable override version');
  }
}

/**
 * v1 projects stored the source under `epubPath` and the paths under
 * `sourceEpub`/`finalEpubPath`. v2 generalizes both to `sourcePath` and
 * `finalOutputPath` with an explicit `source.kind`. Migration is a pure
 * rename; the stage plan, plan fingerprint and prompt version for EPUB
 * projects are unchanged, so in-flight v1 projects resume seamlessly.
 */
function migrateProjectMetadataV1(value: Record<string, unknown>): Record<string, unknown> {
  if (value.schemaVersion !== 1) return value;
  const source = isRecord(value.source) ? { ...value.source } : value.source;
  if (isRecord(source)) {
    source.kind = SOURCE_KIND_V1;
    source.sourcePath = source.epubPath;
    delete source.epubPath;
  }
  const paths = isRecord(value.paths) ? { ...value.paths } : value.paths;
  if (isRecord(paths)) {
    paths.sourcePath = paths.sourceEpub;
    delete paths.sourceEpub;
    paths.finalOutputPath = paths.finalEpubPath;
    delete paths.finalEpubPath;
  }
  return {
    ...value,
    schemaVersion: TRANSLATION_PROJECT_SCHEMA_VERSION,
    source,
    paths,
  };
}

function normalizeProjectRuntimeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const instructionReceipts = value.instructionReceipts === undefined
    ? []
    : value.instructionReceipts;
  const normalized: Record<string, unknown> = {
    ...value,
    instructionVersion: value.instructionVersion === undefined ? 0 : value.instructionVersion,
    instructionReceipts,
    executionPolicy: value.executionPolicy ?? {
      softBudgetMicros: null,
      hardBudgetMicros: null,
      maxRetries: 3,
      maxConcurrency: isValidMaxAgents(value.maxAgents) ? Math.min(value.maxAgents, 8) : 8,
    },
  };
  if (
    normalized.latestInstruction === undefined
    && Array.isArray(instructionReceipts)
    && instructionReceipts.length > 0
  ) {
    normalized.latestInstruction = instructionReceipts.at(-1);
  }
  return normalized;
}

export function parseProjectMetadata(value: unknown): ParseResult<TranslationProject> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['project metadata must be an object'] };
  }
  const migrated = normalizeProjectRuntimeMetadata(migrateProjectMetadataV1(value));
  if (migrated.schemaVersion !== TRANSLATION_PROJECT_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${String(migrated.schemaVersion)}`);
  }
  if (!isNonEmptyString(migrated.projectId)) errors.push('projectId must be a non-empty string');
  if (!isNonEmptyString(migrated.name)) errors.push('name must be a non-empty string');
  if (migrated.model !== undefined && !isNonEmptyString(migrated.model)) {
    errors.push('model must be a non-empty string when present');
  }
  if (migrated.qualityPolicy !== undefined) {
    const parsed = parseTranslationQualityPolicyReceipt(migrated.qualityPolicy);
    if (!parsed.ok) errors.push(...parsed.errors);
    else {
      const storedWorkflow = migrated.workflow;
      if (
        isRecord(storedWorkflow)
        && isBoolean(storedWorkflow.secondTranslation)
        && isBoolean(storedWorkflow.secondReview)
        && isBoolean(storedWorkflow.consistencyReview)
        && !sameWorkflow(parsed.value.effectiveWorkflow, storedWorkflow as unknown as WorkflowOptions)
      ) {
        errors.push('qualityPolicy.effectiveWorkflow must match the materialized project workflow');
      }
      if (
        isNonEmptyString(migrated.model)
        && migrated.model !== parsed.value.policy.model.selectedModelId
      ) {
        errors.push('model must match qualityPolicy.policy.model.selectedModelId');
      }
    }
  }
  if (migrated.initialization !== undefined) {
    const parsed = parseTranslationInitialization(migrated.initialization);
    if (!parsed.ok) errors.push(...parsed.errors);
    else {
      if (parsed.value.ledgerSummary.projectId !== migrated.projectId) {
        errors.push('initialization.ledgerSummary.projectId does not match projectId');
      }
      if (isRecord(migrated.source)) {
        if (parsed.value.sourceReceipt.format !== migrated.source.kind) {
          errors.push('initialization source format does not match project source');
        }
        if (
          isSha256(migrated.source.sha256)
          && parsed.value.sourceReceipt.sha256 !== migrated.source.sha256
        ) {
          errors.push('initialization source hash does not match project source');
        }
      }
      if (
        isRecord(migrated.paths)
        && isNonEmptyString(migrated.paths.sourceCopy)
        && parsed.value.sourceReceipt.copiedPath !== migrated.paths.sourceCopy
      ) {
        errors.push('initialization source copy path does not match project paths');
      }
    }
  }
  if (!isNonNegativeInteger(migrated.instructionVersion)) {
    errors.push('instructionVersion must be a non-negative integer');
  }
  if (!Array.isArray(migrated.instructionReceipts)) {
    errors.push('instructionReceipts must be an array');
  } else {
    let previousVersion = 0;
    const eventIds = new Set<string>();
    migrated.instructionReceipts.forEach((receipt, index) => {
      const parsed = parseTranslationInstructionReceipt(receipt);
      if (!parsed.ok) {
        errors.push(...parsed.errors.map((error) => `instructionReceipts[${index}]: ${error}`));
        return;
      }
      if (parsed.value.instructionVersion !== previousVersion + 1) {
        errors.push(`instructionReceipts[${index}].instructionVersion must be contiguous`);
      }
      previousVersion = parsed.value.instructionVersion;
      if (eventIds.has(parsed.value.eventId)) errors.push(`instructionReceipts[${index}].eventId is duplicated`);
      eventIds.add(parsed.value.eventId);
    });
    if (isNonNegativeInteger(migrated.instructionVersion) && previousVersion !== migrated.instructionVersion) {
      errors.push('instructionVersion must equal the latest instruction receipt version');
    }
    if (migrated.latestInstruction !== undefined) {
      const parsed = parseTranslationInstructionReceipt(migrated.latestInstruction);
      if (!parsed.ok) errors.push(...parsed.errors.map((error) => `latestInstruction: ${error}`));
      else if (
        migrated.instructionReceipts.length === 0
        || !sameJson(parsed.value, migrated.instructionReceipts.at(-1))
      ) {
        errors.push('latestInstruction must equal the last instruction receipt');
      }
    } else if (migrated.instructionReceipts.length > 0) {
      errors.push('latestInstruction is required when instruction receipts exist');
    }
  }
  if (migrated.completionVerification !== undefined) {
    const parsed = parseTranslationCompletionVerification(migrated.completionVerification);
    if (!parsed.ok) errors.push(...parsed.errors);
    else {
      if (
        isRecord(migrated.source)
        && isSha256(migrated.source.sha256)
        && parsed.value.sourceSha256 !== migrated.source.sha256
      ) {
        errors.push('completionVerification source hash does not match project source');
      }
      if (
        isNonNegativeInteger(migrated.instructionVersion)
        && parsed.value.instructionVersion !== migrated.instructionVersion
      ) {
        errors.push('completionVerification instruction version is stale');
      }
      if (
        isNonEmptyString(migrated.planFingerprint)
        && parsed.value.planFingerprint !== migrated.planFingerprint
      ) {
        errors.push('completionVerification plan fingerprint is stale');
      }
    }
  }
  if (migrated.reportReceipt !== undefined) {
    const parsed = parseTranslationReportReceipt(migrated.reportReceipt);
    if (!parsed.ok) errors.push(...parsed.errors);
    else if (
      isRecord(migrated.paths)
      && isNonEmptyString(migrated.paths.finalReportPath)
      && parsed.value.path !== migrated.paths.finalReportPath
    ) {
      errors.push('reportReceipt path does not match project paths');
    }
  }
  if (migrated.runtimeError !== undefined) {
    const parsed = parseTranslationRuntimeError(migrated.runtimeError);
    if (!parsed.ok) errors.push(...parsed.errors);
  }
  if (migrated.coordinatorLaunch !== undefined) {
    const launch = migrated.coordinatorLaunch;
    if (!isRecord(launch)) {
      errors.push('coordinatorLaunch must be an object when present');
    } else {
      if (!isNonEmptyString(launch.launchId)) errors.push('coordinatorLaunch.launchId is required');
      if (!isNonNegativeInteger(launch.attempt) || launch.attempt < 1) {
        errors.push('coordinatorLaunch.attempt must be a positive integer');
      }
      if (!['prepared', 'uncertain', 'accepted', 'rejected'].includes(String(launch.status))) {
        errors.push('coordinatorLaunch.status is invalid');
      }
      if (!isIsoDate(launch.preparedAt)) errors.push('coordinatorLaunch.preparedAt is invalid');
      if (!isIsoDate(launch.updatedAt)) errors.push('coordinatorLaunch.updatedAt is invalid');
      if (launch.promptId !== undefined && !isNonEmptyString(launch.promptId)) {
        errors.push('coordinatorLaunch.promptId must be non-empty when present');
      }
      if (launch.goalId !== undefined && !isNonEmptyString(launch.goalId)) {
        errors.push('coordinatorLaunch.goalId must be non-empty when present');
      }
      if (!Array.isArray(launch.attachments)) {
        errors.push('coordinatorLaunch.attachments must be an array');
      } else {
        launch.attachments.forEach((attachment, index) => {
          const path = `coordinatorLaunch.attachments[${index}]`;
          if (!isRecord(attachment)) {
            errors.push(`${path} must be an object`);
            return;
          }
          if (!isNonEmptyString(attachment.fileId)) errors.push(`${path}.fileId is required`);
          if (!['image', 'video', 'file'].includes(String(attachment.kind))) {
            errors.push(`${path}.kind is invalid`);
          }
          if (attachment.name !== undefined && typeof attachment.name !== 'string') {
            errors.push(`${path}.name must be a string when present`);
          }
          if (attachment.mediaType !== undefined && typeof attachment.mediaType !== 'string') {
            errors.push(`${path}.mediaType must be a string when present`);
          }
          if (attachment.size !== undefined && !isNonNegativeInteger(attachment.size)) {
            errors.push(`${path}.size must be a non-negative integer when present`);
          }
        });
      }
    }
  }
  if (!isNonNegativeInteger(migrated.revision)) errors.push('revision must be a non-negative integer');
  if (!isIsoDate(migrated.createdAt)) errors.push('createdAt must be an ISO date');
  if (!isIsoDate(migrated.updatedAt)) errors.push('updatedAt must be an ISO date');
  let sourceKind: TranslationSourceKind | null = null;
  if (!isRecord(migrated.source)) {
    errors.push('source must be an object');
  } else {
    if (!['epub', 'txt'].includes(String(migrated.source.kind))) {
      errors.push('source.kind must be "epub" or "txt"');
    } else {
      sourceKind = migrated.source.kind as TranslationSourceKind;
    }
    if (!isNonEmptyString(migrated.source.sourcePath)) {
      errors.push('source.sourcePath is required');
    }
    if (migrated.source.immutable !== true) errors.push('source.immutable must remain true');
    if (migrated.source.sha256 !== undefined && !isSha256(migrated.source.sha256)) {
      errors.push('source.sha256 must contain exactly 64 lowercase hexadecimal characters when present');
    }
    if (migrated.source.sizeBytes !== undefined && !isNonNegativeInteger(migrated.source.sizeBytes)) {
      errors.push('source.sizeBytes must be a non-negative integer when present');
    }
    if (
      migrated.source.chapterPattern !== undefined
      && !isNonEmptyString(migrated.source.chapterPattern)
    ) {
      errors.push('source.chapterPattern must be a non-empty string when present');
    }
  }
  validatePaths(migrated.paths, errors);
  const workflow = parseWorkflow(migrated.workflow, errors);
  if (!isValidMaxAgents(migrated.maxAgents)) errors.push('maxAgents must be an integer from 2 to 128');
  const executionPolicy = parseExecutionPolicy(migrated.executionPolicy, errors);
  if (
    executionPolicy !== null
    && isValidMaxAgents(migrated.maxAgents)
    && executionPolicy.maxConcurrency > migrated.maxAgents
  ) {
    errors.push('executionPolicy.maxConcurrency cannot exceed maxAgents');
  }
  if (!['draft', 'ready', 'running', 'paused', 'failed', 'completed'].includes(String(migrated.status))) {
    errors.push('status is invalid');
  }
  if (migrated.activeStageId !== undefined && !isNonEmptyString(migrated.activeStageId)) {
    errors.push('activeStageId must be a non-empty string when present');
  }
  const kind = sourceKind ?? 'epub';
  validateStages(migrated.stages, workflow, kind, errors);
  validateChapters(migrated.chapters, errors);
  validateIssues(migrated.issues, errors);
  validateArtifacts(migrated.artifacts, errors);
  if (!isNonNegativeInteger(migrated.overrideRevision)) {
    errors.push('overrideRevision must be a non-negative integer');
  }
  validateOverrides(
    migrated.overrides,
    migrated.overrideRevision,
    Array.isArray(migrated.stages) ? migrated.stages.length : 0,
    errors,
  );
  if (!isNonEmptyString(migrated.promptVersion)) errors.push('promptVersion is required');

  if (workflow && Array.isArray(migrated.stages)) {
    const expectedFingerprint = planFingerprint(buildStagePlan(workflow, kind));
    if (migrated.planFingerprint !== expectedFingerprint) {
      errors.push('planFingerprint does not match the selected workflow options');
    }
    validateCheckpoints(migrated.checkpoints, expectedFingerprint, migrated.overrideRevision, errors);
  } else {
    validateCheckpoints(migrated.checkpoints, null, migrated.overrideRevision, errors);
  }
  if (
    migrated.activeStageId !== undefined
    && Array.isArray(migrated.stages)
    && !migrated.stages.some((stage) => (
      isRecord(stage)
      && isRecord(stage.definition)
      && stage.definition.id === migrated.activeStageId
    ))
  ) {
    errors.push('activeStageId does not exist in stages');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: migrated as unknown as TranslationProject };
}

export function parseProjectMetadataJson(text: string): ParseResult<TranslationProject> {
  try {
    return parseProjectMetadata(JSON.parse(text));
  } catch (error) {
    return {
      ok: false,
      errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function serializeProjectMetadata(project: TranslationProject): string {
  const parsed = parseProjectMetadata(project);
  if (!parsed.ok) {
    throw new Error(`Cannot serialize invalid project metadata: ${parsed.errors.join('; ')}`);
  }
  return `${JSON.stringify(project, null, 2)}\n`;
}

export interface MergeTranslationRuntimeOptions {
  expectedProjectRevision?: number;
  now?: string;
}

function assertMergeOptions(
  project: TranslationProject,
  options: MergeTranslationRuntimeOptions,
): string {
  if (
    options.expectedProjectRevision !== undefined
    && options.expectedProjectRevision !== project.revision
  ) {
    throw new Error(
      `Stale project revision: expected ${options.expectedProjectRevision}, current ${project.revision}`,
    );
  }
  const now = options.now ?? new Date().toISOString();
  if (!isIsoDate(now)) throw new Error('Runtime merge timestamp must be a valid ISO date');
  return now;
}

function commitRuntimePatch(
  project: TranslationProject,
  patch: Partial<TranslationProject>,
  now: string,
): TranslationProject {
  const candidate = { ...project, ...patch };
  const changed = Object.keys(patch).some((key) => (
    !sameJson(
      project[key as keyof TranslationProject],
      candidate[key as keyof TranslationProject],
    )
  ));
  if (!changed) return project;
  return {
    ...candidate,
    revision: project.revision + 1,
    updatedAt: now,
  };
}

/** Merge a deterministic source/manifest/ledger receipt and materialize chapter progress. */
export function mergeTranslationInitialization(
  project: TranslationProject,
  value: unknown,
  options: MergeTranslationRuntimeOptions = {},
): TranslationProject {
  const now = assertMergeOptions(project, options);
  const receipt = requireParsed(
    parseTranslationInitialization(normalizeInitializationInput(value, now, {
      manifestPath: project.paths.manifestPath,
      databasePath: joinLocalPath(project.paths.projectRoot, 'ledger', 'translation.sqlite3'),
    })),
    'translation initialization',
  );
  if (receipt.ledgerSummary.projectId !== project.projectId) {
    throw new Error('Initialization receipt belongs to a different project');
  }
  if (receipt.sourceReceipt.format !== project.source.kind) {
    throw new Error('Initialization source format does not match project source');
  }
  if (project.source.sha256 !== undefined && receipt.sourceReceipt.sha256 !== project.source.sha256) {
    throw new Error('Initialization source hash does not match the immutable uploaded source');
  }
  if (receipt.sourceReceipt.copiedPath !== project.paths.sourceCopy) {
    throw new Error('Initialization source copy path does not match the program-owned project path');
  }
  if (receipt.sourceReceipt.copiedSha256 !== receipt.sourceReceipt.sha256) {
    throw new Error('Initialization source copy was not verified against the uploaded bytes');
  }
  if (receipt.ledgerSummary.instructionVersion !== project.instructionVersion) {
    throw new Error('Initialization ledger instruction version does not match project metadata');
  }
  if (project.initialization !== undefined && !sameJson(project.initialization, receipt)) {
    throw new Error('A different immutable initialization receipt is already recorded');
  }
  const chapters = receipt.chapters.map((chapter) => ({
    chapterId: chapter.chapterId,
    title: chapter.title?.trim() || chapter.chapterId,
    spineIndex: chapter.spineIndex,
    sourcePath: chapter.sourcePath,
    paragraphCount: chapter.paragraphCount,
    completedParagraphs: 0,
    status: 'pending' as const,
    openIssueCount: 0,
    highOrCriticalIssueCount: 0,
    updatedAt: receipt.initializedAt,
  }));
  return commitRuntimePatch(project, {
    initialization: receipt,
    source: {
      ...project.source,
      sha256: receipt.sourceReceipt.sha256,
      sizeBytes: receipt.sourceReceipt.byteLength,
    },
    chapters: project.initialization === undefined ? chapters : project.chapters,
    status: project.status === 'draft' || project.status === 'failed' ? 'ready' : project.status,
    runtimeError: project.runtimeError?.phase === 'initialization' ? undefined : project.runtimeError,
    completionVerification: undefined,
    reportReceipt: undefined,
  }, now);
}

/** Merge a correction receipt exactly once; every accepted instruction invalidates old completion. */
export function mergeTranslationInstructionReceipt(
  project: TranslationProject,
  value: unknown,
  options: MergeTranslationRuntimeOptions = {},
): TranslationProject {
  const now = assertMergeOptions(project, options);
  const receipt = requireParsed(
    parseTranslationInstructionReceipt(normalizeInstructionInput(value, now)),
    'translation instruction receipt',
  );
  const duplicate = project.instructionReceipts.find((entry) => (
    entry.eventId === receipt.eventId || entry.sessionMessageId === receipt.sessionMessageId
  ));
  if (duplicate !== undefined) {
    if (!sameJson(duplicate, receipt)) {
      throw new Error('Instruction idempotency identity already belongs to a different receipt');
    }
    return project;
  }
  if (receipt.instructionVersion !== project.instructionVersion + 1) {
    throw new Error(
      `Instruction version must advance from ${project.instructionVersion} to ${project.instructionVersion + 1}`,
    );
  }
  return commitRuntimePatch(project, {
    instructionVersion: receipt.instructionVersion,
    latestInstruction: receipt,
    instructionReceipts: [...project.instructionReceipts, receipt],
    completionVerification: undefined,
    reportReceipt: undefined,
    status: project.status === 'completed' ? 'ready' : project.status,
    runtimeError: project.runtimeError?.phase === 'instruction' ? undefined : project.runtimeError,
  }, now);
}

/** Persist the byte-level completion snapshot; a failed snapshot cannot mark the project complete. */
export function mergeTranslationCompletionVerification(
  project: TranslationProject,
  value: unknown,
  options: MergeTranslationRuntimeOptions = {},
): TranslationProject {
  const now = assertMergeOptions(project, options);
  const verification = requireParsed(
    parseTranslationCompletionVerification(normalizeCompletionInput(value, undefined, now)),
    'translation completion verification',
  );
  if (!project.source.sha256 || verification.sourceSha256 !== project.source.sha256) {
    throw new Error('Completion verification source hash does not match the immutable project source');
  }
  if (verification.instructionVersion !== project.instructionVersion) {
    throw new Error('Completion verification was produced for a stale instruction version');
  }
  if (verification.planFingerprint !== project.planFingerprint) {
    throw new Error('Completion verification was produced for a different workflow plan');
  }
  if (verification.finalOutput !== undefined) {
    if (verification.finalOutput.artifactType !== project.source.kind) {
      throw new Error('Final output type does not match project source type');
    }
    if (verification.finalOutput.path !== project.paths.finalOutputPath) {
      throw new Error('Final output path does not match the program-owned project path');
    }
  }
  const failureMessage = [...verification.failures, ...verification.blockers]
    .filter((entry) => entry.trim().length > 0)
    .join('; ') || 'Completion integrity verification failed';
  return commitRuntimePatch(project, {
    completionVerification: verification,
    reportReceipt: undefined,
    status: verification.status === 'passed' ? 'ready' : 'failed',
    activeStageId: verification.status === 'passed' ? undefined : project.activeStageId,
    runtimeError: verification.status === 'passed'
      ? (project.runtimeError?.phase === 'completion' ? undefined : project.runtimeError)
      : {
          phase: 'completion',
          code: 'COMPLETION_VERIFICATION_FAILED',
          message: failureMessage,
          retryable: true,
          occurredAt: verification.verifiedAt,
          details: {
            snapshotId: verification.snapshotId,
            blockers: [...verification.blockers],
            failures: [...verification.failures],
          },
        },
  }, now);
}

function currentVerifiedFinalOutput(project: TranslationProject) {
  if (project.qualityPolicy === undefined || !hasVerifiedTranslationInitialization(project)) {
    return undefined;
  }
  if (!parseTranslationQualityPolicyReceipt(project.qualityPolicy).ok) return undefined;
  const parsed = parseTranslationCompletionVerification(project.completionVerification);
  if (!parsed.ok) return undefined;
  const verification = parsed.value;
  const output = verification.finalOutput;
  if (
    verification.status !== 'passed'
    || verification.verified !== true
    || verification.complete !== true
    || verification.integrity.ok !== true
    || verification.blockers.length > 0
    || verification.failures.length > 0
    || verification.instructionVersion !== project.instructionVersion
    || verification.planFingerprint !== project.planFingerprint
    || !project.source.sha256
    || verification.sourceSha256 !== project.source.sha256
    || output === undefined
    || output.path !== project.paths.finalOutputPath
    || output.sourceSha256 !== project.source.sha256
    || output.artifactType !== project.source.kind
    || output.coverage !== 1
    || output.structuralValidationPassed !== true
  ) {
    return undefined;
  }
  return output;
}

export function mergeTranslationReportReceipt(
  project: TranslationProject,
  value: unknown,
  options: MergeTranslationRuntimeOptions = {},
): TranslationProject {
  const receipt = requireParsed(parseTranslationReportReceipt(value), 'translation report receipt');
  const now = assertMergeOptions(project, options);
  if (currentVerifiedFinalOutput(project) === undefined) {
    throw new Error('A report cannot be accepted before current completion verification passes');
  }
  if (receipt.path !== project.paths.finalReportPath) {
    throw new Error('Translation report path does not match the program-owned project path');
  }
  if (
    project.completionVerification !== undefined
    && Date.parse(receipt.generatedAt) < Date.parse(project.completionVerification.verifiedAt)
  ) {
    throw new Error('Translation report predates the completion verification it describes');
  }
  if (project.reportReceipt !== undefined && !sameJson(project.reportReceipt, receipt)) {
    throw new Error('A different immutable report receipt is already recorded');
  }
  return commitRuntimePatch(project, {
    reportReceipt: receipt,
    status: 'completed',
    activeStageId: undefined,
    runtimeError: project.runtimeError?.phase === 'completion' || project.runtimeError?.phase === 'export'
      ? undefined
      : project.runtimeError,
  }, now);
}

/**
 * Merge a camelCase runtime status projection. Receipt fields are parsed as
 * unknown and fail closed so API types cannot accidentally bypass validation.
 */
export function mergeTranslationRuntimeStatus(
  project: TranslationProject,
  value: unknown,
  options: MergeTranslationRuntimeOptions = {},
): TranslationProject {
  if (!isRecord(value)) throw new Error('Translation runtime status must be an object');
  let next = project;
  let expectedRevision = options.expectedProjectRevision;
  const stepOptions = (): MergeTranslationRuntimeOptions => ({
    ...(expectedRevision === undefined ? {} : { expectedProjectRevision: expectedRevision }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const advance = (updated: TranslationProject): void => {
    next = updated;
    expectedRevision = updated.revision;
  };

  if (value.qualityPolicy !== undefined) {
    const receipt = requireParsed(
      parseTranslationQualityPolicyReceipt(value.qualityPolicy),
      'quality policy receipt',
    );
    const now = assertMergeOptions(next, stepOptions());
    let stages = next.stages;
    let fingerprint = next.planFingerprint;
    if (!sameWorkflow(receipt.effectiveWorkflow, next.workflow)) {
      const planStarted = next.stages.some((stage) => stage.status !== 'pending' || stage.attempt > 0);
      if (next.status !== 'draft' || planStarted || next.initialization !== undefined) {
        throw new Error('Cannot replace the effective quality workflow after execution has started');
      }
      stages = createStageRunStates(receipt.effectiveWorkflow, next.source.kind);
      fingerprint = planFingerprint(stages.map((stage) => stage.definition));
    }
    if (next.model && next.model !== receipt.policy.model.selectedModelId) {
      throw new Error('Runtime quality policy model does not match the pinned project model');
    }
    advance(commitRuntimePatch(next, {
      qualityPolicy: receipt,
      model: next.model ?? receipt.policy.model.selectedModelId,
      workflow: { ...receipt.effectiveWorkflow },
      stages,
      planFingerprint: fingerprint,
      runtimeError: next.runtimeError?.phase === 'quality_probe' ? undefined : next.runtimeError,
    }, now));
  }
  const initializationProjection = next.initialization === undefined ? (value.initialization ?? (
    value.manifest !== undefined
    && field(value, 'ledgerSummary', 'ledger_summary') !== undefined
    && field(value, 'sourceReceipt', 'source_receipt') !== undefined
      ? {
          ...value,
          initialization: undefined,
        }
      : undefined
  )) : undefined;
  if (initializationProjection !== undefined) {
    advance(mergeTranslationInitialization(next, initializationProjection, stepOptions()));
  }
  const instructionProjection = field(value, 'latestInstruction', 'latest_instruction');
  if (instructionProjection !== undefined) {
    advance(mergeTranslationInstructionReceipt(next, instructionProjection, stepOptions()));
  }
  const completionProjection = value.completionVerification
    ?? field(value, 'completionReceipt', 'completion_receipt');
  if (completionProjection !== undefined) {
    const now = options.now ?? new Date().toISOString();
    const normalized = normalizeCompletionInput(
      completionProjection,
      field(value, 'finalOutput', 'final_output'),
      now,
    );
    advance(mergeTranslationCompletionVerification(next, normalized, stepOptions()));
  }
  const reportProjection = field(value, 'reportReceipt', 'report_receipt');
  if (reportProjection !== undefined) {
    advance(mergeTranslationReportReceipt(next, reportProjection, stepOptions()));
  }
  if (value.instructionVersion !== undefined && value.instructionVersion !== next.instructionVersion) {
    throw new Error('Runtime status cannot advance instructionVersion without its durable receipt');
  }

  const runtimeErrorProjection = value.runtimeError !== undefined ? value.runtimeError : value.error;
  if (runtimeErrorProjection !== undefined) {
    const now = assertMergeOptions(next, stepOptions());
    const runtimeError = runtimeErrorProjection === null
      ? undefined
      : requireParsed(
          parseTranslationRuntimeError(normalizeRuntimeErrorInput(runtimeErrorProjection, now)),
          'translation runtime error',
        );
    advance(commitRuntimePatch(next, { runtimeError }, now));
  }
  const budgetProjection = value.budget;
  const hardBudgetExceeded = isRecord(budgetProjection)
    && field(budgetProjection, 'hardExceeded', 'hard_exceeded') === true;
  if (hardBudgetExceeded) {
    const now = assertMergeOptions(next, stepOptions());
    advance(commitRuntimePatch(next, {
      status: 'paused',
      runtimeError: {
        phase: 'budget',
        code: 'HARD_BUDGET_EXCEEDED',
        message: 'The configured maximum cost has been reached. Translation is paused before any further paid call.',
        retryable: false,
        occurredAt: now,
        details: { budget: budgetProjection },
      },
    }, now));
  }
  if (value.status !== undefined || value.activeStageId !== undefined) {
    const rawStatus = hardBudgetExceeded ? 'blocked' : (value.status ?? next.status);
    const status = rawStatus === 'initializing'
      ? (['running', 'paused', 'failed', 'completed'].includes(next.status)
          ? next.status
          : (next.initialization === undefined ? 'draft' : 'ready'))
      : (rawStatus === 'blocked' ? 'paused' : rawStatus);
    if (!['draft', 'ready', 'running', 'paused', 'failed', 'completed'].includes(String(status))) {
      throw new Error('Runtime project status is invalid');
    }
    if (status === 'completed' && !hasVerifiedTranslationCompletion(next)) {
      throw new Error('Runtime status cannot mark a project complete without verified output');
    }
    const activeStageId = value.activeStageId === null ? undefined : value.activeStageId;
    if (
      activeStageId !== undefined
      && (
        !isNonEmptyString(activeStageId)
        || !next.stages.some((stage) => stage.definition.id === activeStageId)
      )
    ) {
      throw new Error('Runtime activeStageId is invalid');
    }
    const now = assertMergeOptions(next, stepOptions());
    advance(commitRuntimePatch(next, {
      status: status as TranslationProject['status'],
      activeStageId: activeStageId as string | undefined,
      runtimeError: rawStatus === 'blocked' && next.runtimeError === undefined
        ? {
            phase: 'translation',
            code: 'TRANSLATION_RUNTIME_BLOCKED',
            message: 'Translation runtime is blocked and requires attention before it can continue.',
            retryable: true,
            occurredAt: now,
          }
        : next.runtimeError,
    }, now));
  }
  return next;
}

export function hasVerifiedTranslationInitialization(project: TranslationProject): boolean {
  if (project.initialization === undefined || !project.source.sha256) return false;
  const parsed = parseTranslationInitialization(project.initialization);
  if (!parsed.ok) return false;
  const receipt = parsed.value;
  return receipt.initialized === true
    && receipt.sourceReceipt.verified === true
    && receipt.sourceReceipt.sha256 === project.source.sha256
    && receipt.sourceReceipt.copiedSha256 === project.source.sha256
    && receipt.sourceReceipt.copiedPath === project.paths.sourceCopy
    && receipt.ledgerSummary.projectId === project.projectId
    && receipt.ledgerSummary.integrityOk === true;
}

/** Return the final artifact only when every persisted quality and integrity gate is current. */
export function verifiedTranslationOutputPath(project: TranslationProject): string | undefined {
  if (project.status !== 'completed') return undefined;
  const output = currentVerifiedFinalOutput(project);
  if (output === undefined || project.reportReceipt === undefined) return undefined;
  const report = parseTranslationReportReceipt(project.reportReceipt);
  if (
    !report.ok
    || report.value.path !== project.paths.finalReportPath
    || !isSha256(report.value.sha256)
  ) return undefined;
  return output.path;
}

export function hasVerifiedTranslationCompletion(project: TranslationProject): boolean {
  return verifiedTranslationOutputPath(project) !== undefined;
}

function sameScope(left: OverrideScope, right: OverrideScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'project' && right.kind === 'project') return true;
  if (left.kind === 'chapter' && right.kind === 'chapter') {
    return left.chapterId === right.chapterId;
  }
  if (left.kind === 'paragraph' && right.kind === 'paragraph') {
    return (
      left.chapterId === right.chapterId
      && left.paragraphIds.join('\u0000') === right.paragraphIds.join('\u0000')
    );
  }
  return false;
}

function assertValidOverrideScope(scope: OverrideScope): void {
  if (scope.kind === 'project') return;
  if (!scope.chapterId.trim()) throw new Error('Override chapterId cannot be empty');
  if (scope.kind === 'paragraph') {
    if (scope.paragraphIds.length === 0 || scope.paragraphIds.some((id) => !id.trim())) {
      throw new Error('Paragraph override scope requires stable paragraph IDs');
    }
    if (new Set(scope.paragraphIds.map((id) => id.trim())).size !== scope.paragraphIds.length) {
      throw new Error('Paragraph override scope cannot contain duplicate IDs');
    }
  }
}

function normalizeOverrideScope(scope: OverrideScope): OverrideScope {
  assertValidOverrideScope(scope);
  if (scope.kind === 'project') return { kind: 'project' };
  if (scope.kind === 'chapter') return { kind: 'chapter', chapterId: scope.chapterId.trim() };
  return {
    kind: 'paragraph',
    chapterId: scope.chapterId.trim(),
    paragraphIds: [...scope.paragraphIds].map((id) => id.trim()).sort(),
  };
}

function earliestMutableStageIndex(project: TranslationProject): number {
  if (project.activeStageId) {
    const activeIndex = stageIndexOf(
      project.stages.map((stage) => stage.definition),
      project.activeStageId,
    );
    if (activeIndex >= 0) return activeIndex;
  }
  const pendingIndex = project.stages.findIndex((stage) => stage.status !== 'completed');
  return pendingIndex >= 0 ? pendingIndex : project.stages.length - 1;
}

export function appendUserOverride(
  project: TranslationProject,
  input: AppendUserOverrideInput,
): TranslationProject {
  const instruction = input.instruction.trim();
  if (!instruction) throw new Error('Override instruction cannot be empty');
  if (instruction.length > MAX_OVERRIDE_INSTRUCTION_LENGTH) {
    throw new Error(`Override instruction exceeds ${MAX_OVERRIDE_INSTRUCTION_LENGTH} characters`);
  }
  if (
    input.expectedProjectRevision !== undefined
    && input.expectedProjectRevision !== project.revision
  ) {
    throw new Error(
      `Stale project revision: expected ${input.expectedProjectRevision}, current ${project.revision}`,
    );
  }
  const scope = normalizeOverrideScope(input.scope ?? { kind: 'project' });
  const mutableFrom = earliestMutableStageIndex(project);
  const requestedFrom = input.effectiveFromStageIndex ?? mutableFrom;
  if (!Number.isInteger(requestedFrom)) {
    throw new Error('effectiveFromStageIndex must be an integer');
  }
  const effectiveFromStageIndex = Math.min(
    project.stages.length - 1,
    Math.max(mutableFrom, Math.trunc(requestedFrom)),
  );
  const version = project.overrideRevision + 1;
  const now = input.now ?? new Date().toISOString();
  const override: UserOverride = {
    overrideId: input.overrideId ?? generatedId('override'),
    version,
    instruction,
    scope,
    status: 'queued',
    createdAt: now,
    effectiveFromStageIndex,
    basedOnProjectRevision: project.revision,
    canModifyWorkflow: false,
  };
  const overrides = project.overrides.map((existing): UserOverride => {
    if (existing.status !== 'queued' || !sameScope(existing.scope, scope)) return existing;
    return {
      ...existing,
      status: 'superseded',
      supersededBy: override.overrideId,
    };
  });
  overrides.push(override);
  return {
    ...project,
    revision: project.revision + 1,
    updatedAt: now,
    overrides,
    overrideRevision: version,
  };
}

export function setUserOverrideStatus(
  project: TranslationProject,
  overrideId: string,
  status: Extract<UserOverrideStatus, 'applied' | 'rejected'>,
  options: { now?: string; rejectionReason?: string } = {},
): TranslationProject {
  const now = options.now ?? new Date().toISOString();
  let found = false;
  const overrides = project.overrides.map((override): UserOverride => {
    if (override.overrideId !== overrideId) return override;
    found = true;
    if (override.status !== 'queued') {
      throw new Error(`Override ${overrideId} is ${override.status}, not queued`);
    }
    return {
      ...override,
      status,
      appliedAt: status === 'applied' ? now : undefined,
      rejectionReason: status === 'rejected' ? options.rejectionReason ?? 'Rejected' : undefined,
    };
  });
  if (!found) throw new Error(`Unknown override: ${overrideId}`);
  return {
    ...project,
    revision: project.revision + 1,
    updatedAt: now,
    overrides,
  };
}

export function activeUserOverrides(
  project: TranslationProject,
  stageIndex: number,
  chapterId?: string,
  paragraphIds: readonly string[] = [],
): UserOverride[] {
  const paragraphSet = new Set(paragraphIds);
  return project.overrides.filter((override) => {
    if (!['queued', 'applied'].includes(override.status)) return false;
    if (override.effectiveFromStageIndex > stageIndex) return false;
    if (override.scope.kind === 'project') return true;
    if (override.scope.chapterId !== chapterId) return false;
    if (override.scope.kind === 'chapter') return true;
    return override.scope.paragraphIds.some((paragraphId) => paragraphSet.has(paragraphId));
  });
}
