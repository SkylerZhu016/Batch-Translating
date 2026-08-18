export const TASK_STATES = [
  'PENDING',
  'LEASED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'STALE',
  'CANCELLED',
  'BLOCKED',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const ATTEMPT_STATES = [
  'LEASED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'LEASE_EXPIRED',
  'INTERRUPTED',
  'CANCELLED',
] as const;

export type AttemptState = (typeof ATTEMPT_STATES)[number];
export type ArtifactState = 'ACTIVE' | 'STALE' | 'REJECTED';
export type InterruptMode = 'SOFT' | 'HARD';
export type CostClass = 'LOCAL' | 'PAID';

export interface ProjectRecord {
  projectId: string;
  name: string;
  sourceRootPath: string;
  artifactRootPath: string;
  sourceHash: string;
  providerId: string;
  modelId: string;
  state: string;
  instructionVersion: number;
  softBudgetMicros: number | null;
  hardBudgetMicros: number | null;
  perStageBudgetMicros: Record<string, number>;
  maxRetries: number;
  maxConcurrency: number;
  reviewPolicy: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  projectId?: string;
  name: string;
  sourceRootPath: string;
  artifactRootPath: string;
  sourceHash: string;
  providerId: string;
  modelId: string;
  softBudgetMicros?: number | null;
  hardBudgetMicros?: number | null;
  perStageBudgetMicros?: Record<string, number>;
  maxRetries?: number;
  maxConcurrency?: number;
  reviewPolicy?: string;
}

export interface SourceItemRecord {
  sourceItemId: string;
  projectId: string;
  href: string;
  mediaType: string;
  kind: string;
  spineIndex: number | null;
  linear: boolean;
  sourceHash: string;
  immutablePath: string;
  metadata: Record<string, unknown>;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterSourceItemInput {
  sourceItemId: string;
  projectId: string;
  href: string;
  mediaType: string;
  kind: string;
  spineIndex?: number | null;
  linear?: boolean;
  sourceHash: string;
  immutablePath: string;
  metadata?: Record<string, unknown>;
}

export interface ParagraphRecord {
  paragraphId: string;
  projectId: string;
  sourceItemId: string;
  ordinal: number;
  sourceText: string;
  sourceHash: string;
  entities: string[];
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterParagraphInput {
  paragraphId: string;
  projectId: string;
  sourceItemId: string;
  ordinal: number;
  sourceText: string;
  sourceHash: string;
  entities?: string[];
}

export interface TaskIdentityInput {
  projectId: string;
  taskType: string;
  scopeHash: string;
  promptVersion: string;
  instructionVersion: number;
  contextHash: string;
  modelId: string;
  decodingConfigHash: string;
}

export interface CreateTaskInput extends TaskIdentityInput {
  taskId?: string;
  scope: Record<string, unknown>;
  priority?: number;
  dependencyIds?: string[];
  costClass?: CostClass;
  stage?: string;
  maxAttempts?: number;
}

export interface TaskRecord extends TaskIdentityInput {
  taskId: string;
  scope: Record<string, unknown>;
  state: TaskState;
  priority: number;
  dependencyIds: string[];
  idempotencyKey: string;
  costClass: CostClass;
  stage: string;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  activeAttemptId: string | null;
  interruptMode: InterruptMode | null;
  interruptRequestedAt: string | null;
  blockReason: string | null;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAttemptRecord {
  attemptId: string;
  projectId: string;
  taskId: string;
  attemptNumber: number;
  state: AttemptState;
  workerId: string;
  instructionVersion: number;
  idempotencyKey: string;
  providerRequestId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryReason: string | null;
  discardedCostMicros: number;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedTask {
  task: TaskRecord;
  attempt: TaskAttemptRecord;
}

export interface ArtifactEnvelope<T = unknown> {
  artifactId: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  schemaVersion: number;
  sourceHashes: string[];
  promptVersion: string;
  instructionVersion: number;
  contextHash: string;
  modelId: string;
  createdAt: string;
  payload: T;
  payloadHash: string;
  provenance: ArtifactProvenance;
}

export interface ArtifactProvenance {
  providerId: string;
  modelId: string;
  promptVersion: string;
  instructionVersion: number;
  contextHash: string;
  sourceHashes: string[];
  consumedMemoryIds?: string[];
  paragraphIds?: string[];
  oldTranslationHashes?: Record<string, string>;
  [key: string]: unknown;
}

export interface CompleteAttemptInput<T = unknown> {
  projectId: string;
  taskId: string;
  attemptId: string;
  workerId: string;
  sourceHashes: string[];
  payload: T;
  provenance: ArtifactProvenance;
}

export interface ArtifactRecord {
  artifactId: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  state: ArtifactState;
  schemaVersion: number;
  sourceHashes: string[];
  promptVersion: string;
  instructionVersion: number;
  contextHash: string;
  modelId: string;
  filePath: string;
  payloadHash: string;
  envelopeHash: string;
  provenance: ArtifactProvenance;
  staleReason: string | null;
  readoptedByEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AffectedScope {
  affectedTaskIds: string[];
  affectedChapterIds: string[];
  affectedEntities: string[];
  global: boolean;
  reason: string;
}

export interface ApplyInstructionInput {
  projectId: string;
  eventId?: string;
  sessionMessageId: string;
  message: string;
  affectedScope: AffectedScope;
  interruptMode?: InterruptMode;
  replacementTasks?: Omit<CreateTaskInput, 'projectId' | 'instructionVersion'>[];
}

export interface InstructionEventRecord {
  eventId: string;
  projectId: string;
  sessionMessageId: string;
  instructionVersion: number;
  message: string;
  affectedScope: AffectedScope;
  interruptMode: InterruptMode;
  createdAt: string;
}

export interface InstructionApplicationResult {
  instruction: InstructionEventRecord;
  continuedTaskIds: string[];
  cancelledTaskIds: string[];
  interruptedTaskIds: string[];
  staleTaskIds: string[];
  replacementTaskIds: string[];
}

export interface CostEventInput {
  costEventId?: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  stage: string;
  providerId: string;
  modelId: string;
  providerRequestId?: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  latencyMs: number;
  priceSnapshot: Record<string, unknown>;
  actualCostMicros: number;
  retryReason?: string | null;
  promptFingerprint: string;
  contextFingerprint: string;
  instructionFingerprint: string;
  billable?: boolean;
  discarded?: boolean;
}

export interface SyntheticUsageEventInput {
  projectId: string;
  eventId: string;
  sessionId: string;
  agentId: string;
  turnId: string;
  step: string | number;
  modelId: string;
  providerId: string;
  traceId?: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  latencyMs?: number;
  priceSnapshot: Record<string, unknown>;
  actualCostMicros: number;
  stage?: string;
  retryReason?: string | null;
}

export interface SyntheticUsageEventResult {
  costEventId: string;
  taskId: string;
  attemptId: string;
  reused: boolean;
  budget: BudgetStatus;
}

export interface BudgetStatus {
  projectId: string;
  actualCostMicros: number;
  softBudgetMicros: number | null;
  hardBudgetMicros: number | null;
  stageCostMicros: Record<string, number>;
  perStageBudgetMicros: Record<string, number>;
  softExceeded: boolean;
  hardExceeded: boolean;
  blockedStages: string[];
}

export interface IntegrityReport {
  ok: boolean;
  sqliteIntegrity: string[];
  foreignKeyViolations: Array<Record<string, unknown>>;
  missingArtifactFiles: string[];
  mismatchedArtifactHashes: string[];
  sourceHashMismatches: string[];
}

export interface CompletionSnapshot {
  snapshotId: string;
  projectId: string;
  createdAt: string;
  sourceHash: string;
  instructionVersion: number;
  taskCounts: Record<TaskState, number>;
  attemptCount: number;
  activeArtifactCount: number;
  staleArtifactCount: number;
  unresolvedHighIssues: number;
  unresolvedCriticalIssues: number;
  unresolvedMergeConflicts: number;
  cost: BudgetStatus;
  integrity: IntegrityReport;
  finalArtifactIds: string[];
  complete: boolean;
  blockers: string[];
}

export interface MergeValidationInput {
  artifactId: string;
  projectId: string;
  expectedInstructionVersion: number;
  expectedPromptVersion?: string;
  expectedContextHash?: string;
  expectedSourceHashes?: string[];
  expectedParagraphIds?: string[];
  expectedOldTranslationHashes?: Record<string, string>;
}

export interface LeaseRecoveryResult {
  recoveredTaskIds: string[];
  expiredAttemptIds: string[];
  uncertainTaskIds: string[];
}

export interface LedgerOptions {
  databasePath: string;
  busyTimeoutMs?: number;
  now?: () => Date;
}

export interface MemoryRecordInput {
  memoryId?: string;
  projectId: string;
  memoryType: string;
  chapterId?: string | null;
  paragraphIds?: string[];
  entities?: string[];
  summary: string;
  importance: number;
  confidence: number;
  sourceProvenance: Record<string, unknown>;
  instructionVersion: number;
}

export interface CanonicalEntityInput {
  canonicalRecordId?: string;
  projectId: string;
  entityKey: string;
  entityType: string;
  canonicalValue: Record<string, unknown>;
  aliases?: string[];
  sourceProvenance: Record<string, unknown>;
  instructionVersion: number;
}

export interface TranslationMemoryInput {
  tmRecordId?: string;
  projectId: string;
  paragraphId?: string | null;
  sourceHash: string;
  targetText: string;
  approval: 'APPROVED' | 'FINAL';
  providerId: string;
  modelId: string;
  promptVersion: string;
  instructionVersion: number;
  provenance: Record<string, unknown>;
}

export interface ReviewIssueInput {
  issueId?: string;
  projectId: string;
  taskId?: string | null;
  chapterId?: string | null;
  paragraphIds?: string[];
  category: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  sourceEvidenceIds?: string[];
  targetEvidenceIds?: string[];
  storyMemoryIds?: string[];
  explanation: string;
  suggestedAction: string;
  instructionVersion: number;
}

export interface RepairPatchInput {
  patchId?: string;
  projectId: string;
  issueId: string;
  taskId?: string | null;
  paragraphId: string;
  oldTranslationHash: string;
  newTranslation: string;
  reason: string;
  instructionVersion: number;
  provenance: Record<string, unknown>;
}

export interface MergeConflictInput {
  conflictId?: string;
  projectId: string;
  paragraphId: string;
  patchIds: string[];
  baseTranslationHash: string;
  instructionVersion: number;
}

export interface MergerLeaseToken {
  projectId: string;
  owner: string;
  generation: number;
  expiresAt: string;
}

export interface IndexVersionInput {
  indexVersionId?: string;
  projectId: string;
  indexKind: string;
  schemaFingerprint: string;
  modelFingerprint: string;
  state: 'STAGING' | 'CURRENT' | 'DEGRADED' | 'STALE' | 'FAILED';
  pointCount?: number;
  metadata?: Record<string, unknown>;
}

export interface CompletionSnapshotOptions {
  finalTaskTypes?: string[];
  requiredTaskTypes?: string[];
  verifyFiles?: boolean;
}

export interface AffectedScopeParagraph {
  paragraphId: string;
  chapterId: string;
  entities: string[];
}

export interface AffectedScopeEntity {
  entityKey: string;
  aliases?: string[];
}

export interface AnalyzeAffectedScopeInput {
  message: string;
  tasks: TaskRecord[];
  paragraphs: AffectedScopeParagraph[];
  canonicalEntities: AffectedScopeEntity[];
  explicitScope?: Partial<Pick<AffectedScope, 'affectedTaskIds' | 'affectedChapterIds' | 'affectedEntities' | 'global'>>;
}

export interface AffectedScopeAnalysis extends AffectedScope {
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  matchedParagraphIds: string[];
}

export interface DeterministicReportData {
  project: ProjectRecord;
  source: Record<string, unknown>;
  tasks: Record<string, unknown>;
  attempts: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  memory: Record<string, unknown>;
  canonical: Record<string, unknown>;
  translationMemory: Record<string, unknown>;
  reviewIssues: Record<string, unknown>;
  repairPatches: Record<string, unknown>;
  mergeConflicts: Record<string, unknown>;
  costs: Record<string, unknown>;
  indexes: Array<Record<string, unknown>>;
  completionSnapshots: Array<Record<string, unknown>>;
  rows: {
    tasks: TaskRecord[];
    attempts: TaskAttemptRecord[];
    memoryRecords: Array<Record<string, unknown>>;
    reviewIssues: Array<Record<string, unknown>>;
    repairPatches: Array<Record<string, unknown>>;
    mergeConflicts: Array<Record<string, unknown>>;
    costEvents: Array<Record<string, unknown>>;
  };
  generatedAt: string;
}
