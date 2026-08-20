import type { TranslationQualityCapabilityProbe, TranslationQualityPolicy } from './qualityPolicy';

export const TRANSLATION_PROJECT_SCHEMA_VERSION = 2 as const;
export const TRANSLATION_PROJECT_SCHEMA_ID = 'https://moonshot.example/schemas/batch-translation-project-v2.json';
export const TRANSLATION_RUNTIME_RECEIPT_VERSION = 1 as const;

export type TranslationProjectSchemaVersion = typeof TRANSLATION_PROJECT_SCHEMA_VERSION;

export type TranslationSourceKind = 'epub' | 'txt';

export type TranslationSourceLanguage = string;
export type TranslationTargetLanguage = 'zh-CN' | 'en';

export interface TranslationLanguageSettings {
  source: TranslationSourceLanguage;
  target: TranslationTargetLanguage;
}

export interface TranslationOutputMilestone {
  round: number;
  path: string;
  sha256: string;
  byteLength: number;
  structuralValidationPassed: true;
  recordedAt: string;
}

export type ProjectRunStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'paused'
  | 'failed'
  | 'completed';

export type StageRunStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'stale';

export type TaskRunStatus =
  | 'pending'
  | 'running'
  | 'failed'
  | 'stale'
  | 'needs_review'
  | 'completed';

export type ChapterRunStatus =
  | 'pending'
  | 'analyzing'
  | 'translating'
  | 'reviewing'
  | 'repairing'
  | 'failed'
  | 'completed';

export type TranslationStageKind =
  | 'parse_epub'
  | 'parse_txt'
  | 'analyze_book'
  | 'smoke_test'
  | 'translate'
  | 'review'
  | 'repair'
  | 'consistency_review'
  | 'consistency_repair'
  | 'final_audit'
  | 'export_epub'
  | 'export_txt';

export type StageExecutionMode = 'deterministic' | 'single_agent' | 'agent_swarm';

export interface WorkflowOptions {
  /** A first translation pass is always present. This checkbox only adds pass two. */
  secondTranslation: boolean;
  /** A first independent review is always present. This checkbox only adds pass two. */
  secondReview: boolean;
  /** Adds the whole-book, retrieval-driven consistency review and its repair stage. */
  consistencyReview: boolean;
}

export interface StageDefinition {
  id: string;
  kind: TranslationStageKind;
  label: string;
  /** Every stage present in a materialized plan is required; unselected optional passes are absent. */
  required: boolean;
  execution: StageExecutionMode;
  pass?: 1 | 2;
  dependsOn: string[];
}

export interface StageTaskCounts {
  total: number;
  pending: number;
  running: number;
  failed: number;
  completed: number;
}

export interface StageRunState {
  definition: StageDefinition;
  status: StageRunStatus;
  attempt: number;
  taskCounts: StageTaskCounts;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  checkpointId?: string;
}

export interface TranslationSource {
  /** 'epub' for ZIP/OCF books, 'txt' for plain-text books. */
  kind: TranslationSourceKind;
  /** Daemon-readable local path or a session attachment reference. */
  sourcePath: string;
  /** The source is never edited or overwritten. */
  immutable: true;
  sha256?: string;
  sizeBytes?: number;
  /** TXT only: custom chapter-heading regular expression override. */
  chapterPattern?: string;
}

export interface TranslationPaths {
  projectRoot: string;
  sourcePath: string;
  sourceCopy: string;
  unpackedDir: string;
  manifestPath: string;
  memoryDir: string;
  translationDir: string;
  reviewsDir: string;
  repairsDir: string;
  finalDir: string;
  logsDir: string;
  stateDir: string;
  taskManifestPath: string;
  issuesPath: string;
  checkpointPath: string;
  /** Per-kind final artifact: book.zh-CN.epub or book.zh-CN.txt. */
  finalOutputPath: string;
  finalReportPath: string;
}

export interface ChapterProgress {
  chapterId: string;
  title: string;
  spineIndex: number;
  sourcePath: string;
  paragraphCount: number;
  completedParagraphs: number;
  status: ChapterRunStatus;
  activeStageId?: string;
  openIssueCount: number;
  highOrCriticalIssueCount: number;
  updatedAt: string;
}

export type TranslationIssueSeverity = 'info' | 'minor' | 'major' | 'high' | 'critical';
export type TranslationIssueStatus = 'open' | 'repair_pending' | 'resolved' | 'wont_fix';

export interface TranslationIssue {
  issueId: string;
  stageId: string;
  chapterId?: string;
  paragraphIds: string[];
  category: string;
  severity: TranslationIssueSeverity;
  status: TranslationIssueStatus;
  sourceEvidence: string[];
  targetEvidence: string[];
  storyMemoryIds: string[];
  explanation: string;
  suggestedAction: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedByPatchIds: string[];
}

export type TranslationArtifactType =
  | 'source_copy'
  | 'book_manifest'
  | 'story_memory'
  | 'canonical_state'
  | 'translation'
  | 'review_ledger'
  | 'repair_patch'
  | 'checkpoint'
  | 'final_epub'
  | 'final_txt'
  | 'final_report'
  | 'log';

export interface TranslationArtifact {
  artifactId: string;
  stageId: string;
  type: TranslationArtifactType;
  path: string;
  status: 'pending' | 'ready' | 'invalid';
  createdAt: string;
  immutable: boolean;
  sha256?: string;
  sourceRevision?: number;
}

export interface TranslationCheckpoint {
  checkpointId: string;
  stageId: string;
  stageIndex: number;
  sequence: number;
  createdAt: string;
  promptVersion: string;
  overrideRevision: number;
  planFingerprint: string;
  completedTaskIds: string[];
}

export type TranslationCoordinatorLaunchStatus =
  | 'prepared'
  | 'uncertain'
  | 'accepted'
  | 'rejected';

export interface TranslationCoordinatorAttachment {
  fileId: string;
  kind: 'image' | 'video' | 'file';
  name?: string;
  mediaType?: string;
  size?: number;
}

/**
 * Durable exactly-once handshake for the Coordinator's first paid prompt.
 * `launchId` is also the daemon idempotency key; attachments are retained so
 * a browser restart can reconstruct the identical request.
 */
export interface TranslationCoordinatorLaunch {
  launchId: string;
  attempt: number;
  status: TranslationCoordinatorLaunchStatus;
  preparedAt: string;
  updatedAt: string;
  promptId?: string;
  goalId?: string;
  attachments: TranslationCoordinatorAttachment[];
}

export type OverrideScope =
  | { kind: 'project' }
  | { kind: 'chapter'; chapterId: string }
  | { kind: 'paragraph'; chapterId: string; paragraphIds: string[] };

export type UserOverrideStatus = 'queued' | 'applied' | 'superseded' | 'rejected';

export interface UserOverride {
  overrideId: string;
  version: number;
  instruction: string;
  scope: OverrideScope;
  status: UserOverrideStatus;
  createdAt: string;
  effectiveFromStageIndex: number;
  basedOnProjectRevision: number;
  /** User guidance can affect translation choices, never the protected workflow contract. */
  canModifyWorkflow: false;
  appliedAt?: string;
  supersededBy?: string;
  rejectionReason?: string;
}

export interface TranslationProjectQualityPolicyReceipt {
  receiptVersion: typeof TRANSLATION_RUNTIME_RECEIPT_VERSION;
  recordedAt: string;
  capabilityEvidence: TranslationQualityCapabilityProbe;
  effectiveWorkflow: WorkflowOptions;
  policy: TranslationQualityPolicy;
}

export interface TranslationInitializationSourceReceipt {
  sourcePath: string;
  format: TranslationSourceKind;
  sha256: string;
  byteLength: number;
  modifiedAtMs?: number;
  copiedPath: string;
  copiedSha256: string;
  immutable: true;
  verified: true;
}

export interface TranslationManifestReceipt {
  path: string;
  sha256: string;
  schemaVersion: number;
  bookId: string;
  chapterCount: number;
  paragraphCount: number;
  sourceWordCount: number;
}

export interface TranslationLedgerSummaryReceipt {
  databasePath: string;
  schemaVersion: number;
  journalMode: 'wal';
  projectId: string;
  instructionVersion: number;
  taskCounts: Record<string, number>;
  artifactCount: number;
  integrityOk: boolean;
}

export interface TranslationInitializedChapterReceipt {
  chapterId: string;
  title?: string;
  spineIndex: number;
  sourcePath: string;
  paragraphCount: number;
  sourceHash?: string;
}

export interface TranslationInitializationReceipt {
  receiptVersion: typeof TRANSLATION_RUNTIME_RECEIPT_VERSION;
  initialized: true;
  initializedAt: string;
  sourceReceipt: TranslationInitializationSourceReceipt;
  manifest: TranslationManifestReceipt;
  ledgerSummary: TranslationLedgerSummaryReceipt;
  chapters: TranslationInitializedChapterReceipt[];
}

/** Mirrors the durable ledger's explicit, non-retroactive instruction scope. */
export interface TranslationInstructionAffectedScope {
  affectedTaskIds: string[];
  affectedChapterIds: string[];
  affectedEntities: string[];
  global: boolean;
  reason: string;
}

export interface TranslationInstructionCostImpact {
  actualCostMicrosDelta: number;
  discardedCostMicros: number;
  estimatedAdditionalCostMicros: number;
  additionalPaidTaskCount: number;
  reason?: string;
}

export interface TranslationInstructionReceipt {
  receiptVersion: typeof TRANSLATION_RUNTIME_RECEIPT_VERSION;
  eventId: string;
  sessionMessageId: string;
  instructionVersion: number;
  message: string;
  affectedScope: TranslationInstructionAffectedScope;
  interruptMode: 'SOFT' | 'HARD';
  appliedAt: string;
  continuedTaskIds: string[];
  cancelledTaskIds: string[];
  interruptedTaskIds: string[];
  staleTaskIds: string[];
  replacementTaskIds: string[];
  costImpact: TranslationInstructionCostImpact;
}

export interface TranslationCompletionIntegrityEvidence {
  ok: boolean;
  sqliteIntegrity: string[];
  foreignKeyViolations: Array<Record<string, unknown>>;
  missingArtifactFiles: string[];
  mismatchedArtifactHashes: string[];
  sourceHashMismatches: string[];
}

export interface TranslationFinalOutputReceipt {
  artifactType: TranslationSourceKind;
  path: string;
  sourcePath: string;
  sourceSha256: string;
  sha256: string;
  byteLength: number;
  immutable: true;
  paragraphCount: number;
  translatedParagraphCount: number;
  coverage: number;
  structuralValidationPassed: boolean;
  epubcheckStatus?: 'passed' | 'failed' | 'unavailable' | 'timed_out';
  createdAt: string;
}

export interface TranslationCompletionVerification {
  receiptVersion: typeof TRANSLATION_RUNTIME_RECEIPT_VERSION;
  snapshotId: string;
  verifiedAt: string;
  status: 'passed' | 'failed';
  verified: boolean;
  complete: boolean;
  sourceSha256: string;
  planFingerprint: string;
  instructionVersion: number;
  taskCounts: Record<string, number>;
  attemptCount: number;
  activeArtifactCount: number;
  staleArtifactCount: number;
  unresolvedHighIssues: number;
  unresolvedCriticalIssues: number;
  unresolvedMergeConflicts: number;
  integrity: TranslationCompletionIntegrityEvidence;
  finalOutput?: TranslationFinalOutputReceipt;
  blockers: string[];
  failures: string[];
}

export interface TranslationRuntimeError {
  phase: 'quality_probe' | 'initialization' | 'translation' | 'instruction' | 'budget' | 'completion' | 'export';
  code: string;
  message: string;
  retryable: boolean;
  occurredAt: string;
  details?: Record<string, unknown>;
}

export interface TranslationExecutionPolicy {
  /** Null means warning/stop thresholds are disabled explicitly, not unknown. */
  softBudgetMicros: number | null;
  hardBudgetMicros: number | null;
  maxRetries: number;
  maxConcurrency: number;
}

export interface TranslationReportReceipt {
  path: string;
  sha256: string;
  generatedAt: string;
  summary?: Record<string, unknown>;
}

export interface TranslationProject {
  schemaVersion: TranslationProjectSchemaVersion;
  projectId: string;
  name: string;
  /** Source can be auto-detected; target is deliberately limited to Chinese or English. */
  languages: TranslationLanguageSettings;
  /** Round one is the first complete edition; later rounds are normal messages in this session. */
  revisionRound: number;
  latestOutput?: TranslationOutputMilestone;
  outputHistory: TranslationOutputMilestone[];
  /** Model pinned for every paid Coordinator turn. Optional only for legacy imports. */
  model?: string;
  /** Optional only for legacy projects created before the native Coordinator. */
  coordinatorLaunch?: TranslationCoordinatorLaunch;
  /** Present only after a real BGE/RAG probe and model-policy resolution. */
  qualityPolicy?: TranslationProjectQualityPolicyReceipt;
  /** Durable deterministic source/manifest/ledger initialization receipt. */
  initialization?: TranslationInitializationReceipt;
  /** Monotonic ledger instruction version; zero before the first correction. */
  instructionVersion: number;
  latestInstruction?: TranslationInstructionReceipt;
  instructionReceipts: TranslationInstructionReceipt[];
  /** A final output is usable only when this receipt passes every integrity gate. */
  completionVerification?: TranslationCompletionVerification;
  reportReceipt?: TranslationReportReceipt;
  runtimeError?: TranslationRuntimeError;
  executionPolicy: TranslationExecutionPolicy;
  revision: number;
  createdAt: string;
  updatedAt: string;
  source: TranslationSource;
  paths: TranslationPaths;
  workflow: WorkflowOptions;
  maxAgents: number;
  status: ProjectRunStatus;
  activeStageId?: string;
  planFingerprint: string;
  stages: StageRunState[];
  chapters: ChapterProgress[];
  issues: TranslationIssue[];
  artifacts: TranslationArtifact[];
  checkpoints: TranslationCheckpoint[];
  overrides: UserOverride[];
  overrideRevision: number;
  promptVersion: string;
}

export interface TranslationTaskDescriptor {
  taskId: string;
  chapterId: string;
  paragraphIds: string[];
  sourcePath: string;
  outputPath: string;
  sourceHash: string;
  snapshotId: string;
  attemptNumber: number;
  baseTranslationVersion?: string;
  notes?: string;
}

export interface StagePromptInput {
  project: TranslationProject;
  stageId: string;
  paths: TranslationPaths;
  tasks: TranslationTaskDescriptor[];
  maxAgents: number;
}

export interface StagePromptBundle {
  promptVersion: string;
  stage: StageDefinition;
  systemPrompt: string;
  instruction: string;
  fullPrompt: string;
}

export interface ParseFailure {
  ok: false;
  errors: string[];
}

export interface ParseSuccess<T> {
  ok: true;
  value: T;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;
