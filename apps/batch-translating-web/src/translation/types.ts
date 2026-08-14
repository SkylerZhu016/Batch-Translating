export const TRANSLATION_PROJECT_SCHEMA_VERSION = 2 as const;
export const TRANSLATION_PROJECT_SCHEMA_ID = 'https://moonshot.example/schemas/batch-translation-project-v2.json';

export type TranslationProjectSchemaVersion = typeof TRANSLATION_PROJECT_SCHEMA_VERSION;

export type TranslationSourceKind = 'epub' | 'txt';

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

export interface TranslationProject {
  schemaVersion: TranslationProjectSchemaVersion;
  projectId: string;
  name: string;
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
