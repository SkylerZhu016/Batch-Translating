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
  type OverrideScope,
  type ParseResult,
  type TranslationPaths,
  type TranslationProject,
  type TranslationSource,
  type TranslationSourceKind,
  type UserOverride,
  type UserOverrideStatus,
  type WorkflowOptions,
} from './types';
import { TRANSLATION_PROMPT_VERSION } from './prompts';

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
        sha256: { type: 'string' },
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
  sourcePath: string;
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
  const now = input.now ?? new Date().toISOString();
  if (!isIsoDate(now)) throw new Error('Project timestamp must be a valid ISO date');
  const workflow = { ...input.workflow };
  const stages = createStageRunStates(workflow, kind);
  const plan = stages.map((stage) => stage.definition);
  const source: TranslationSource = {
    kind,
    sourcePath,
    immutable: true,
    ...(input.chapterPattern?.trim() ? { chapterPattern: input.chapterPattern.trim() } : {}),
  };
  return {
    schemaVersion: TRANSLATION_PROJECT_SCHEMA_VERSION,
    projectId: input.projectId ?? generatedId('translation'),
    name: input.name.trim(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    source,
    paths: buildTranslationPaths(input.projectRoot, sourcePath, kind),
    workflow,
    maxAgents: normalizeMaxAgents(input.maxAgents),
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
  if (!isRecord(value)) {
    errors.push('workflow must be an object');
    return null;
  }
  const secondTranslation = value.secondTranslation;
  const secondReview = value.secondReview;
  const consistencyReview = value.consistencyReview;
  if (!isBoolean(secondTranslation)) errors.push('workflow.secondTranslation must be boolean');
  if (!isBoolean(secondReview)) errors.push('workflow.secondReview must be boolean');
  if (!isBoolean(consistencyReview)) errors.push('workflow.consistencyReview must be boolean');
  if (!isBoolean(secondTranslation) || !isBoolean(secondReview) || !isBoolean(consistencyReview)) {
    return null;
  }
  return { secondTranslation, secondReview, consistencyReview };
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

export function parseProjectMetadata(value: unknown): ParseResult<TranslationProject> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['project metadata must be an object'] };
  }
  const migrated = migrateProjectMetadataV1(value);
  if (migrated.schemaVersion !== TRANSLATION_PROJECT_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${String(migrated.schemaVersion)}`);
  }
  if (!isNonEmptyString(migrated.projectId)) errors.push('projectId must be a non-empty string');
  if (!isNonEmptyString(migrated.name)) errors.push('name must be a non-empty string');
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
