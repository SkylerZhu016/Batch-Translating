import { computed, reactive, ref, type ComputedRef } from 'vue';
import type {
  AppGoal,
  AppSession,
  TranslationInitializeResult,
  TranslationRuntimeStatus,
} from '../api/types';
import {
  createTranslationProject as createProjectMetadata,
  createTranslationInstructionReceipt,
  createTranslationQualityPolicy,
  createTranslationQualityPolicyReceipt,
  hasVerifiedTranslationInitialization,
  hasVerifiedTranslationCompletion,
  isAllowedTranslationQualityModel,
  mergeTranslationCompletionVerification,
  mergeTranslationInitialization,
  mergeTranslationInstructionReceipt,
  mergeTranslationRuntimeStatus,
  mergeTranslationReportReceipt,
  parseProjectMetadata,
  type BgeM3CapabilityProbe,
  type OverrideScope,
  type RagCapabilityProbe,
  type TranslationCoordinatorAttachment,
  type TranslationCoordinatorLaunch,
  type TranslationProject,
  type WorkflowOptions,
} from '../translation';
import type { PromptAttachment } from './useKimiWebClient';

export const TRANSLATION_METADATA_KEY = 'batchTranslation';
export const TRANSLATION_COORDINATOR_PROFILE = 'translation-coordinator';
/** @deprecated Use TRANSLATION_COORDINATOR_PROFILE. */
export const TRANSLATION_AGENT_PROFILE = TRANSLATION_COORDINATOR_PROFILE;

type SubmitOutcome = 'ok' | 'terminal' | 'rejected' | 'uncertain';
type GoalControl = 'pause' | 'resume' | 'cancel';

export interface TranslationProjectSession {
  sessionId: string;
  session: AppSession;
  project: TranslationProject;
}

export interface CreateTranslationProjectRequest {
  name: string;
  /** Preferred non-technical path: a File from the native file picker. */
  sourceFile?: File;
  /** Advanced fallback for an EPUB/TXT that is already available to the daemon. */
  sourcePath?: string;
  languages: {
    source: string;
    target: 'zh-CN' | 'en';
  };
  /** TXT only: custom chapter-heading regular expression override. */
  chapterPattern?: string;
  projectRoot: string;
  workspaceId?: string;
  /** The session model is pinned when the Coordinator session is created. */
  model?: string;
  workflow: WorkflowOptions;
  maxAgents: number;
  executionPolicy?: {
    softBudgetMicros: number;
    hardBudgetMicros: number;
    maxRetries: number;
    maxConcurrency: number;
  };
}

export interface ApplyTranslationOverrideRequest {
  text: string;
  /** Reserved for the Phase 3 affected-scope ledger. Never encoded into a side-channel prompt. */
  scope?: OverrideScope;
}

/** Strict runtime evidence used to select the RAG or adjacent-chapter policy. */
export interface TranslationRagRuntimeCapability {
  status: 'detected' | 'missing' | 'downloading' | 'verifying' | 'available' | 'failed';
  modelId?: string;
  fingerprint?: string;
  source?: 'environment' | 'local-cache' | 'managed-download' | 'unknown';
  denseReady?: boolean;
  indexReady?: boolean;
  serviceReachable?: boolean;
  indexVersion?: string;
  degraded?: boolean;
}

export interface TranslationInstructionRuntimeAck {
  instructionVersion: number;
  affectedScope: {
    affectedTaskIds: string[];
    affectedChapterIds: string[];
    affectedEntities: string[];
    global: boolean;
    reason: string;
  };
  staleTaskIds: string[];
  cancelledTaskIds: string[];
  continuedTaskIds: string[];
  interruptedTaskIds?: string[];
  replacementTaskIds?: string[];
  costImpact?: Record<string, unknown>;
  acceptedAt: string;
}

export interface TranslationCoordinatorHost {
  sessions: ComputedRef<AppSession[]>;
  activeSessionId: ComputedRef<string>;
  /** Configured model catalog used to validate the user's selected/default model. */
  availableModelIds?: ComputedRef<string[]>;
  createSession(input: {
    title?: string;
    cwd?: string;
    model?: string;
    workspaceId?: string;
    metadata?: Record<string, unknown>;
    agentProfile?: string;
  }): Promise<AppSession>;
  updateSessionMetadata(sessionId: string, project: TranslationProject): Promise<AppSession>;
  /** Persist `/auto` before creating or resuming the native goal. */
  ensureSessionPermission(
    sessionId: string,
    mode: 'manual' | 'auto' | 'yolo',
  ): Promise<AppSession>;
  /** Re-apply the durable project model before any paid prompt/control action. */
  ensureSessionModel(sessionId: string, model: string): Promise<AppSession>;
  /** Recovery path for legacy projects created before the model was persisted. */
  loadSessionModel(sessionId: string): Promise<string | undefined>;
  getSessionGoal(sessionId: string): Promise<AppGoal | null>;
  setSessionGoal(sessionId: string, objective: string): Promise<AppSession>;
  controlSessionGoal(sessionId: string, action: GoalControl): Promise<AppSession>;
  deleteSession(sessionId: string): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  submitPromptToSession(
    sessionId: string,
    text: string,
    attachments?: PromptAttachment[],
    options?: {
      profile?: string;
      disabledTools?: string[];
      permissionMode?: 'manual' | 'auto' | 'yolo';
      idempotencyKey?: string;
    },
  ): Promise<SubmitOutcome>;
  /** Native Kimi send/steer path: sends immediately when idle and steers the active turn otherwise. */
  steerPrompt(
    sessionId: string,
    text: string,
    attachments?: PromptAttachment[],
    options?: {
      permissionMode?: 'manual' | 'auto' | 'yolo';
      throwOnFailure?: boolean;
      /** Match Kimi Code ctrl+s while a native goal owns the session, including between goal turns. */
      goalActive?: boolean;
    },
  ): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  uploadFile(file: Blob, name?: string): Promise<PromptAttachment>;
  initializeTranslationProject(input: {
    project: TranslationProject;
    sourceFileId: string;
  }): Promise<TranslationInitializeResult>;
  getTranslationProjectStatus(input: {
    projectId: string;
    projectRoot: string;
  }): Promise<TranslationRuntimeStatus>;
  recordTranslationInstruction(input: {
    projectId: string;
    projectRoot: string;
    sessionMessageId: string;
    message: string;
    affectedScope: {
      affectedTaskIds: string[];
      affectedChapterIds: string[];
      affectedEntities: string[];
      global: boolean;
      reason: string;
    };
    interruptMode?: 'SOFT' | 'HARD';
  }): Promise<TranslationInstructionRuntimeAck>;
  verifyTranslationCompletion(input: {
    projectId: string;
    projectRoot: string;
    finalArtifact?: Record<string, unknown>;
    finalArtifactIds?: string[];
    finalTaskTypes?: string[];
    requiredTaskTypes?: string[];
  }): Promise<unknown>;
  generateTranslationReport(input: {
    projectId: string;
    projectRoot: string;
    outputPath: string;
    finalArtifact?: Record<string, unknown>;
    finalTaskTypes?: string[];
    requiredTaskTypes?: string[];
  }): Promise<unknown>;
  getTranslationRagCapability(): Promise<TranslationRagRuntimeCapability>;
  forgetSession(sessionId: string): void;
  pushOperationFailure(operation: string, error: unknown, options?: { sessionId?: string }): void;
}

function metadataProject(session: AppSession): TranslationProject | null {
  // parseProjectMetadata retains the schema-v1 migration path, so legacy
  // fixed-runner projects remain visible/importable without reviving its scheduler.
  const parsed = parseProjectMetadata(session.metadata[TRANSLATION_METADATA_KEY]);
  return parsed.ok ? parsed.value : null;
}

function now(): string {
  return new Date().toISOString();
}

export function isAllowedTranslationModel(model: string | undefined): boolean {
  return typeof model === 'string' && isAllowedTranslationQualityModel(model);
}

function requireAllowedTranslationModel(model: string | undefined): string {
  const pinned = model?.trim();
  if (pinned && isAllowedTranslationModel(pinned)) return pinned;
  throw new Error('Select a configured model before starting the translation project.');
}

function qualityProbeFromRuntime(
  runtime: TranslationRagRuntimeCapability | undefined,
): { bgeM3?: BgeM3CapabilityProbe; rag?: RagCapabilityProbe } {
  if (runtime === undefined) return {};
  const available = runtime.status === 'available' && runtime.degraded !== true;
  const serviceReady = available && runtime.serviceReachable === true;
  return {
    bgeM3: {
      status: available ? 'ready' : runtime.status === 'failed' ? 'unhealthy' : 'missing',
      ...(runtime.modelId ? { modelId: runtime.modelId } : {}),
      ...(runtime.fingerprint ? { fingerprint: runtime.fingerprint } : {}),
      ...(runtime.source ? { source: runtime.source } : {}),
      denseAvailable: available && runtime.denseReady === true,
    },
    rag: {
      // A new project has no per-project index yet. Service + dense capability
      // is enough to select the RAG workflow; the Coordinator builds the index
      // from the verified source/ledger immediately after initialization.
      status: serviceReady ? 'ready' : 'unhealthy',
      serviceReachable: serviceReady,
      denseRetrievalAvailable: serviceReady && runtime.denseReady === true,
      ...(runtime.indexVersion ? { indexVersion: runtime.indexVersion } : {}),
    },
  };
}

function instructionAffectedScope(scope: OverrideScope | undefined): {
  affectedTaskIds: string[];
  affectedChapterIds: string[];
  affectedEntities: string[];
  global: boolean;
  reason: string;
} {
  if (scope === undefined || scope.kind === 'project') {
    return {
      affectedTaskIds: [],
      affectedChapterIds: [],
      affectedEntities: [],
      global: true,
      reason: 'User correction applies to the project unless deterministic dependency analysis narrows it.',
    };
  }
  if (scope.kind === 'chapter') {
    return {
      affectedTaskIds: [],
      affectedChapterIds: [scope.chapterId],
      affectedEntities: [],
      global: false,
      reason: 'User selected a chapter-scoped correction.',
    };
  }
  return {
    affectedTaskIds: [],
    affectedChapterIds: [scope.chapterId],
    affectedEntities: scope.paragraphIds,
    global: false,
    reason: 'User selected stable paragraph IDs within one chapter.',
  };
}

function clientReceiptId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${random}`;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function withProjectStatus(
  project: TranslationProject,
  status: TranslationProject['status'],
): TranslationProject {
  if (project.status === status) return project;
  return {
    ...project,
    status,
    revision: project.revision + 1,
    updatedAt: now(),
  };
}

function withProjectModel(project: TranslationProject, model: string): TranslationProject {
  if (project.model === model) return project;
  return {
    ...project,
    model,
    revision: project.revision + 1,
    updatedAt: now(),
  };
}

function createCoordinatorLaunch(
  project: TranslationProject,
  attachments: readonly PromptAttachment[] = project.coordinatorLaunch?.attachments ?? [],
): TranslationCoordinatorLaunch {
  const stamp = now();
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return {
    launchId: `batch_translation_${random}`,
    attempt: (project.coordinatorLaunch?.attempt ?? 0) + 1,
    status: 'prepared',
    preparedAt: stamp,
    updatedAt: stamp,
    // sha256 is project/ledger provenance, not prompt attachment semantics.
    // Persist it on project.source below and keep the paid prompt shape stable.
    attachments: attachments.map((attachment): TranslationCoordinatorAttachment => ({
      fileId: attachment.fileId,
      kind: attachment.kind,
      ...(attachment.name !== undefined ? { name: attachment.name } : {}),
      ...(attachment.mediaType !== undefined ? { mediaType: attachment.mediaType } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    })),
  };
}

function withCoordinatorLaunch(
  project: TranslationProject,
  launch: TranslationCoordinatorLaunch,
  status: TranslationProject['status'] = project.status,
): TranslationProject {
  return {
    ...project,
    coordinatorLaunch: launch,
    status,
    revision: project.revision + 1,
    updatedAt: now(),
  };
}

function transitionCoordinatorLaunch(
  project: TranslationProject,
  status: TranslationCoordinatorLaunch['status'],
  projectStatus: TranslationProject['status'],
  patch: Partial<Pick<TranslationCoordinatorLaunch, 'promptId' | 'goalId'>> = {},
): TranslationProject {
  const current = project.coordinatorLaunch;
  if (current === undefined) throw new Error('Translation Coordinator launch is not prepared');
  return withCoordinatorLaunch(project, {
    ...current,
    ...patch,
    status,
    updatedAt: now(),
  }, projectStatus);
}

function hasPassedCompletionReceipt(project: TranslationProject): boolean {
  const verification = project.completionVerification;
  return verification?.status === 'passed'
    && verification.verified === true
    && verification.complete === true
    && verification.integrity.ok === true
    && verification.blockers.length === 0
    && verification.failures.length === 0
    && verification.finalOutput !== undefined;
}

function nativeOutputMilestone(
  project: TranslationProject,
  runtime: TranslationRuntimeStatus,
): TranslationProject['latestOutput'] {
  const output = runtime.finalOutput;
  if (output === undefined) return undefined;
  const byteLength = output.byteLength ?? output.byte_length;
  const validation = output.structuralValidation ?? output.structural_validation;
  if (
    output.path !== project.paths.finalOutputPath
    || typeof output.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(output.sha256)
    || typeof byteLength !== 'number'
    || !Number.isSafeInteger(byteLength)
    || byteLength <= 0
    || typeof validation !== 'object'
    || validation === null
    || (validation as Record<string, unknown>).valid !== true
  ) return undefined;
  return {
    round: project.revisionRound,
    path: output.path,
    sha256: output.sha256,
    byteLength,
    structuralValidationPassed: true,
    recordedAt: now(),
  };
}

function withNativeOutput(
  project: TranslationProject,
  output: NonNullable<TranslationProject['latestOutput']>,
): TranslationProject {
  const history = project.outputHistory.filter((entry) => entry.round !== output.round);
  history.push(output);
  return {
    ...project,
    latestOutput: output,
    outputHistory: history.sort((left, right) => left.round - right.round),
    status: 'completed',
    activeStageId: undefined,
    runtimeError: undefined,
    revision: project.revision + 1,
    updatedAt: output.recordedAt,
  };
}

export function buildTranslationCoordinatorGoal(
  project: TranslationProject,
  model?: string,
): string {
  return buildTranslationCoordinatorPrompt(project, model);
}

export function buildTranslationCoordinatorPrompt(
  project: TranslationProject,
  _model?: string,
): string {
  const root = project.paths.projectRoot.replace(/[\\/]+$/, '');
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const taskBookPath = `${root}${separator}translation-task.txt`;
  const targetLanguage = project.languages.target === 'zh-CN' ? '简体中文' : '英文';
  return `请完成任务："${taskBookPath}"。所有工作语言使用${targetLanguage}。`;
}

/**
 * Native-session translation coordinator.
 *
 * Unlike the deprecated fixed runner, this composable never treats a turn end
 * as authority to advance a paid stage. The engine's goal/session loop owns
 * scheduling; this layer only creates/imports project sessions, sends the
 * initial goal, forwards ordinary user messages, and handles explicit Stop.
 */
export function useTranslationCoordinator(host: TranslationCoordinatorHost) {
  const loadingBySession = reactive<Record<string, boolean>>({});
  const errorBySession = reactive<Record<string, string>>({});
  const creating = ref(false);
  const startingSessions = new Set<string>();
  const stoppingSessions = new Set<string>();
  const transitionQueues = new Map<string, Promise<void>>();

  async function serializeTransition<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = transitionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    transitionQueues.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (transitionQueues.get(sessionId) === tail) transitionQueues.delete(sessionId);
    }
  }

  const translationProjectSessions = computed<TranslationProjectSession[]>(() =>
    host.sessions.value.flatMap((session) => {
      const project = metadataProject(session);
      return project === null ? [] : [{ sessionId: session.id, session, project }];
    }),
  );
  const translationProjects = computed(() =>
    translationProjectSessions.value.map(({ project }) => project),
  );
  const activeTranslationProjectSession = computed(() =>
    translationProjectSessions.value.find(({ sessionId }) => sessionId === host.activeSessionId.value) ?? null,
  );
  const activeTranslationProject = computed(() =>
    activeTranslationProjectSession.value?.project ?? null,
  );

  function findProjectSession(sessionId: string): TranslationProjectSession {
    const found = translationProjectSessions.value.find((entry) => entry.sessionId === sessionId);
    if (found === undefined) throw new Error(`Unknown translation project session: ${sessionId}`);
    return found;
  }

  function setError(sessionId: string, error: unknown): void {
    errorBySession[sessionId] = error instanceof Error ? error.message : String(error);
    host.pushOperationFailure('translationCoordinator', error, { sessionId });
  }

  async function updateTranslationProjectMetadata(
    sessionId: string,
    project: TranslationProject,
  ): Promise<TranslationProject> {
    const session = await host.updateSessionMetadata(sessionId, project);
    return metadataProject(session) ?? project;
  }

  async function setProjectStatus(
    sessionId: string,
    status: TranslationProject['status'],
  ): Promise<TranslationProject> {
    const current = findProjectSession(sessionId).project;
    const next = withProjectStatus(current, status);
    return next === current ? current : updateTranslationProjectMetadata(sessionId, next);
  }

  async function ensureProjectModel(
    sessionId: string,
    sourceProject?: TranslationProject,
    preferredModel?: string,
  ): Promise<{ project: TranslationProject; model: string }> {
    const entry = findProjectSession(sessionId);
    let project = sourceProject ?? entry.project;
    const storedModel = project.model?.trim();
    let candidate: string | undefined = (
      storedModel || preferredModel?.trim() || entry.session.model?.trim()
    );
    if (!candidate) candidate = (await host.loadSessionModel(sessionId))?.trim();
    const pinnedModel = requireAllowedTranslationModel(candidate);

    // The project ledger wins over a stale/empty session projection. Always
    // re-apply it server-side before a control action or paid prompt so a cold
    // reload can never fall through to the application's global default model.
    await host.ensureSessionModel(sessionId, pinnedModel);
    const withModel = withProjectModel(project, pinnedModel);
    if (withModel !== project) {
      project = await updateTranslationProjectMetadata(sessionId, withModel);
    }
    return { project, model: pinnedModel };
  }

  async function applyGoalSnapshot(
    sessionId: string,
    goal: AppGoal,
  ): Promise<{ project: TranslationProject; completionRejected: boolean }> {
    const current = findProjectSession(sessionId);
    const launch = current.project.coordinatorLaunch;
    // Once a project uses the durable launch protocol, an event is authoritative
    // only after that launch has recorded the exact native goal it owns. This
    // rejects late active/complete snapshots from a cancelled predecessor and
    // also keeps an unacknowledged goal-creation window recoverable via GET.
    if (launch !== undefined && launch.goalId !== goal.goalId) {
      return { project: current.project, completionRejected: false };
    }
    if (
      goal.status === 'active'
      && launch?.status !== 'accepted'
    ) return { project: current.project, completionRejected: false };
    if (goal.status === 'complete') {
      if (hasVerifiedTranslationCompletion(current.project)) {
        return {
          project: await setProjectStatus(sessionId, 'completed'),
          completionRejected: false,
        };
      }
      try {
        const runtime = await host.getTranslationProjectStatus({
          projectId: current.project.projectId,
          projectRoot: current.project.paths.projectRoot,
        });
        const nativeOutput = nativeOutputMilestone(current.project, runtime);
        if (nativeOutput !== undefined) {
          return {
            project: await updateTranslationProjectMetadata(
              sessionId,
              withNativeOutput(current.project, nativeOutput),
            ),
            completionRejected: false,
          };
        }
        const verification = await host.verifyTranslationCompletion({
          projectId: current.project.projectId,
          projectRoot: current.project.paths.projectRoot,
        });
        let merged = mergeTranslationCompletionVerification(current.project, verification);
        const completionPassed = hasPassedCompletionReceipt(merged);
        if (completionPassed) {
          try {
            const report = await host.generateTranslationReport({
              projectId: merged.projectId,
              projectRoot: merged.paths.projectRoot,
              outputPath: merged.paths.finalReportPath,
            });
            merged = mergeTranslationReportReceipt(merged, report);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            merged = {
              ...withProjectStatus(merged, 'failed'),
              runtimeError: {
                phase: 'export',
                code: 'FINAL_REPORT_GENERATION_FAILED',
                message: `Final output passed verification, but the deterministic technical report was not recorded: ${reason}`,
                retryable: true,
                occurredAt: now(),
              },
            };
          }
        }
        const verified = hasVerifiedTranslationCompletion(merged);
        const persisted = await updateTranslationProjectMetadata(
          sessionId,
          withProjectStatus(merged, verified ? 'completed' : 'failed'),
        );
        return { project: persisted, completionRejected: !verified };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failed: TranslationProject = {
          ...withProjectStatus(current.project, 'failed'),
          runtimeError: {
            phase: 'completion',
            code: 'COMPLETION_VERIFICATION_UNAVAILABLE',
            message: `Completion verification failed: ${reason}`,
            retryable: true,
            occurredAt: now(),
          },
        };
        try {
          return {
            project: await updateTranslationProjectMetadata(sessionId, failed),
            completionRejected: true,
          };
        } catch (persistError) {
          host.pushOperationFailure('translationCompletionVerificationPersist', persistError, { sessionId });
          return { project: failed, completionRejected: true };
        }
      }
    }
    const status: TranslationProject['status'] = goal.status === 'active' ? 'running' : 'paused';
    const completionRejected = false;
    if (current.project.status === 'failed' || current.project.status === 'completed') {
      return { project: current.project, completionRejected };
    }
    return {
      project: await setProjectStatus(sessionId, status),
      completionRejected,
    };
  }

  function reportRejectedCompletion(sessionId: string): void {
    setError(
      sessionId,
      new Error('Coordinator reported completion before the required stages and hashed final artifact were verified'),
    );
  }

  async function startCoordinatorGoal(
    sessionId: string,
    sourceProject?: TranslationProject,
    attachments?: PromptAttachment[],
    model?: string,
  ): Promise<TranslationProject> {
    if (startingSessions.has(sessionId)) throw new Error('This translation Coordinator is already starting');
    startingSessions.add(sessionId);
    try {
      await host.selectSession(sessionId);
      // The create-session wire currently accepts permission_mode but does not
      // apply it. Persist through the session profile before any goal action so
      // a new start and a resumed continuation both truly run as `/auto`.
      await host.ensureSessionPermission(sessionId, 'auto');
      const resolved = await ensureProjectModel(sessionId, sourceProject, model);
      let project = resolved.project;
      const pinnedModel = resolved.model;
      if (!hasVerifiedTranslationInitialization(project)) {
        const runtime = await host.getTranslationProjectStatus({
          projectId: project.projectId,
          projectRoot: project.paths.projectRoot,
        });
        project = mergeTranslationRuntimeStatus(project, runtime);
        project = await updateTranslationProjectMetadata(sessionId, project);
      }
      if (!hasVerifiedTranslationInitialization(project)) {
        throw new Error(
          'Translation project initialization is not verified; no goal or paid model request was started',
        );
      }
      // Native `/goal <objective>` semantics: the durable goal and the first
      // visible user turn carry the exact same text. There is no second starter
      // instruction that can drift from the goal the engine is continuing.
      const objective = buildTranslationCoordinatorGoal(project, pinnedModel);

      let goal: AppGoal | null;
      try {
        goal = await host.getSessionGoal(sessionId);
      } catch (error) {
        host.pushOperationFailure('translationCoordinatorGoalRecovery', error, { sessionId });
        return project;
      }

      if (goal?.status === 'complete') {
        if (project.status === 'failed' && !hasVerifiedTranslationCompletion(project)) {
          // An explicit retry after a rejected completion retires the terminal
          // receipt and allocates a fresh launch below.
          await host.controlSessionGoal(sessionId, 'cancel');
          goal = null;
        } else {
          const result = await applyGoalSnapshot(sessionId, goal);
          if (result.completionRejected) reportRejectedCompletion(sessionId);
          return result.project;
        }
      }

      const hadLaunch = project.coordinatorLaunch !== undefined;
      const mustCreateLaunch = (
        project.coordinatorLaunch === undefined
        || project.coordinatorLaunch.status === 'rejected'
        || project.status === 'failed'
      );

      // A pre-state-machine build may have created the native goal before it
      // crashed. Never guess by submitting another paid starter prompt: adopt
      // the existing goal and use its continuation mechanism to resume it.
      if (!hadLaunch && goal !== null) {
        if (goal.objective !== objective) {
          throw new Error('The existing session goal does not belong to this translation project');
        }
        const adopted = createCoordinatorLaunch(project, attachments);
        project = await updateTranslationProjectMetadata(
          sessionId,
          withCoordinatorLaunch(project, {
            ...adopted,
            status: 'accepted',
            goalId: goal.goalId,
            updatedAt: now(),
          }, goal.status === 'active' ? 'running' : 'paused'),
        );
        if (goal.status === 'paused' || goal.status === 'blocked') {
          await host.controlSessionGoal(sessionId, 'resume');
          project = await setProjectStatus(sessionId, 'running');
        } else {
          const live = findProjectSession(sessionId).session;
          if (!live.mainTurnActive && !live.busy) {
            // Active goal + idle session means the starter turn was lost in the
            // crash window. Pause/resume launches one native continuation.
            await host.controlSessionGoal(sessionId, 'pause');
            await host.controlSessionGoal(sessionId, 'resume');
          }
        }
        return project;
      }

      if (mustCreateLaunch) {
        if (goal !== null) {
          // A failed/rejected attempt owns this goal. Clear the durable receipt
          // before allocating a fresh launch id and objective.
          await host.controlSessionGoal(sessionId, 'cancel');
          goal = null;
        }
        project = await updateTranslationProjectMetadata(
          sessionId,
          withCoordinatorLaunch(project, createCoordinatorLaunch(project, attachments), 'ready'),
        );
      } else if (
        attachments !== undefined
        && attachments.length > 0
        && project.coordinatorLaunch!.attachments.length === 0
      ) {
        project = await updateTranslationProjectMetadata(sessionId, withCoordinatorLaunch(project, {
          ...project.coordinatorLaunch!,
          attachments: attachments.map((attachment) => ({ ...attachment })),
          updatedAt: now(),
        }));
      }

      let launch = project.coordinatorLaunch!;
      if (goal === null && launch.status === 'accepted') {
        const failed = withProjectStatus(project, 'failed');
        try {
          project = await updateTranslationProjectMetadata(sessionId, failed);
        } catch (statusError) {
          host.pushOperationFailure('translationCoordinatorStatus', statusError, { sessionId });
        }
        throw new Error('The accepted translation launch has no recoverable native goal');
      }
      if (goal === null) {
        try {
          await host.setSessionGoal(sessionId, objective);
          goal = await host.getSessionGoal(sessionId);
        } catch (error) {
          // Goal creation is not itself idempotent. Re-read before deciding:
          // if the response alone was lost, the matching goal is authoritative.
          try {
            goal = await host.getSessionGoal(sessionId);
          } catch {
            goal = null;
          }
          if (goal === null) {
            host.pushOperationFailure('translationCoordinatorGoalCreateUncertain', error, { sessionId });
            return project;
          }
        }
      }
      if (goal === null) return project;
      const submittedGoalId = goal.goalId;
      if (
        goal.objective !== objective
        && launch.goalId !== goal.goalId
      ) {
        throw new Error('The existing session goal does not belong to this translation launch');
      }
      if (goal.status === 'complete') {
        const result = await applyGoalSnapshot(sessionId, goal);
        if (result.completionRejected) reportRejectedCompletion(sessionId);
        return result.project;
      }
      if (launch.goalId !== goal.goalId) {
        project = await updateTranslationProjectMetadata(sessionId, withCoordinatorLaunch(project, {
          ...launch,
          goalId: goal.goalId,
          updatedAt: now(),
        }));
        launch = project.coordinatorLaunch!;
      }

      if (launch.status === 'accepted') {
        if (goal.status === 'paused' || goal.status === 'blocked') {
          await host.controlSessionGoal(sessionId, 'resume');
        }
        return project.status === 'running' ? project : setProjectStatus(sessionId, 'running');
      }

      let outcome: SubmitOutcome;
      try {
        outcome = await host.submitPromptToSession(
          sessionId,
          objective,
          launch.attachments,
          {
            profile: TRANSLATION_COORDINATOR_PROFILE,
            disabledTools: [],
            permissionMode: 'auto',
            idempotencyKey: launch.launchId,
          },
        );
      } catch (error) {
        host.pushOperationFailure('translationCoordinatorSubmitUncertain', error, { sessionId });
        const uncertain = transitionCoordinatorLaunch(project, 'uncertain', 'paused', {
          goalId: goal.goalId,
        });
        try {
          return await updateTranslationProjectMetadata(sessionId, uncertain);
        } catch (statusError) {
          host.pushOperationFailure('translationCoordinatorStatus', statusError, { sessionId });
          return uncertain;
        }
      }

      if (outcome === 'uncertain') {
        const uncertainError = new Error(
          'Coordinator submission response was lost; the stable launch id will recover it without duplicate billing',
        );
        host.pushOperationFailure('translationCoordinatorSubmitUncertain', uncertainError, { sessionId });
        const uncertain = transitionCoordinatorLaunch(project, 'uncertain', 'paused', {
          goalId: goal.goalId,
        });
        try {
          return await updateTranslationProjectMetadata(sessionId, uncertain);
        } catch (statusError) {
          host.pushOperationFailure('translationCoordinatorStatus', statusError, { sessionId });
          return uncertain;
        }
      }

      if (outcome === 'rejected') {
        const rejected = transitionCoordinatorLaunch(project, 'rejected', 'failed', {
          goalId: goal.goalId,
        });
        project = await updateTranslationProjectMetadata(sessionId, rejected);
        try {
          await host.controlSessionGoal(sessionId, 'cancel');
        } catch (cleanupError) {
          host.pushOperationFailure('translationCoordinatorGoalCleanup', cleanupError, { sessionId });
        }
        throw new Error('Translation Coordinator goal prompt was rejected');
      }

      let recoveredGoal: AppGoal | null = goal;
      if (outcome === 'terminal') {
        try {
          recoveredGoal = await host.getSessionGoal(sessionId);
        } catch (recoveryError) {
          host.pushOperationFailure('translationCoordinatorGoalRecovery', recoveryError, { sessionId });
        }
      }
      if (recoveredGoal === null) {
        const lost = transitionCoordinatorLaunch(project, 'accepted', 'failed', {
          goalId: submittedGoalId,
          promptId: launch.launchId,
        });
        try {
          await updateTranslationProjectMetadata(sessionId, lost);
        } catch (statusError) {
          host.pushOperationFailure('translationCoordinatorStatus', statusError, { sessionId });
        }
        throw new Error('The accepted Coordinator prompt has no recoverable native goal');
      }
      if (recoveredGoal.status === 'paused' || recoveredGoal.status === 'blocked') {
        await host.controlSessionGoal(sessionId, 'resume');
      } else if (outcome === 'terminal' && recoveredGoal.status === 'active') {
        const live = findProjectSession(sessionId).session;
        if (!live.mainTurnActive && !live.busy) {
          await host.controlSessionGoal(sessionId, 'pause');
          await host.controlSessionGoal(sessionId, 'resume');
        }
      }
      const accepted = transitionCoordinatorLaunch(project, 'accepted', 'running', {
        goalId: recoveredGoal.goalId,
        promptId: launch.launchId,
      });
      try {
        project = await updateTranslationProjectMetadata(sessionId, accepted);
      } catch (statusError) {
        // The paid prompt is already accepted. Never cancel it because the
        // metadata acknowledgement failed; recovery replays the same launch id.
        host.pushOperationFailure('translationCoordinatorStatus', statusError, { sessionId });
        return accepted;
      }
      if (recoveredGoal.status === 'complete') {
        const result = await applyGoalSnapshot(sessionId, recoveredGoal);
        if (result.completionRejected) reportRejectedCompletion(sessionId);
        return result.project;
      }
      return project;
    } finally {
      startingSessions.delete(sessionId);
    }
  }

  async function createTranslationProject(
    input: CreateTranslationProjectRequest,
  ): Promise<TranslationProject> {
    if (creating.value) throw new Error('A translation project is already being created');
    creating.value = true;
    let createdSession: AppSession | undefined;
    try {
      if (!input.sourceFile && !input.sourcePath?.trim()) {
        throw new Error('Select an EPUB or TXT file before creating the project');
      }
      const availableModelIds = host.availableModelIds?.value ?? (input.model ? [input.model] : []);
      let ragRuntime: TranslationRagRuntimeCapability | undefined;
      try {
        ragRuntime = await host.getTranslationRagCapability();
      } catch (error) {
        // Capability discovery fails closed. Creation may continue with the
        // mandatory adjacent-chapter + second-review policy, never fake RAG.
        host.pushOperationFailure('translationRagCapability', error);
      }
      const qualityPolicy = createTranslationQualityPolicy({
        capabilityProbe: qualityProbeFromRuntime(ragRuntime),
        requestedWorkflow: input.workflow,
        availableModelIds,
        selectedModelId: input.model,
      });
      const pinnedModel = requireAllowedTranslationModel(qualityPolicy.model.selectedModelId);
      const sourceName = input.sourceFile?.name ?? input.sourcePath!.split(/[\\/]/).at(-1)!;
      const uploaded = input.sourceFile
        ? await host.uploadFile(input.sourceFile, sourceName)
        : undefined;
      if (
        uploaded === undefined
        || uploaded.sha256 === undefined
        || !/^[0-9a-f]{64}$/.test(uploaded.sha256)
        || uploaded.size === undefined
        || !Number.isSafeInteger(uploaded.size)
        || uploaded.size < 0
      ) {
        throw new Error(
          'New translation projects require an uploaded source with a verified SHA-256; select the EPUB or TXT file instead of entering a local path',
        );
      }
      const sourceReference = input.sourcePath?.trim() || `attachments/${sourceName}`;
      const project = createProjectMetadata({
        name: input.name,
        languages: input.languages,
        model: pinnedModel,
        sourcePath: sourceReference,
        sourceSha256: uploaded.sha256,
        sourceSizeBytes: uploaded.size,
        chapterPattern: input.chapterPattern,
        projectRoot: input.projectRoot,
        workflow: qualityPolicy.effectiveWorkflow,
        qualityPolicy: createTranslationQualityPolicyReceipt({
          recordedAt: now(),
          capabilityEvidence: qualityProbeFromRuntime(ragRuntime),
          policy: qualityPolicy,
        }),
        maxAgents: input.maxAgents,
        executionPolicy: input.executionPolicy ?? {
          softBudgetMicros: 20_000_000,
          hardBudgetMicros: 30_000_000,
          maxRetries: 2,
          maxConcurrency: Math.min(input.maxAgents, 16),
        },
      });
      const initialization = await host.initializeTranslationProject({
        project,
        sourceFileId: uploaded.fileId,
      });
      const initializedProject = mergeTranslationInitialization(project, initialization);
      if (!hasVerifiedTranslationInitialization(initializedProject)) {
        throw new Error(
          'The source copy, hash, manifest, chapters, or SQLite ledger could not be verified; no paid model request was started',
        );
      }
      const preparedProject = withCoordinatorLaunch(
        initializedProject,
        createCoordinatorLaunch(initializedProject, []),
        'ready',
      );
      createdSession = await host.createSession({
        title: input.name,
        cwd: input.projectRoot,
        model: pinnedModel,
        workspaceId: input.workspaceId,
        agentProfile: TRANSLATION_COORDINATOR_PROFILE,
        metadata: { [TRANSLATION_METADATA_KEY]: preparedProject },
      });
      return await serializeTransition(createdSession.id, () => startCoordinatorGoal(
        createdSession!.id,
        preparedProject,
        undefined,
        pinnedModel,
      ));
    } catch (error) {
      if (createdSession) setError(createdSession.id, error);
      else host.pushOperationFailure('createTranslationProject', error);
      throw error;
    } finally {
      creating.value = false;
    }
  }

  async function startTranslationRun(sessionId: string): Promise<void> {
    return serializeTransition(sessionId, async () => {
      loadingBySession[sessionId] = true;
      delete errorBySession[sessionId];
      try {
        const { project, session } = findProjectSession(sessionId);
        await startCoordinatorGoal(sessionId, project, undefined, session.model);
      } catch (error) {
        setError(sessionId, error);
        throw error;
      } finally {
        loadingBySession[sessionId] = false;
      }
    });
  }

  async function resumeTranslationRun(sessionId: string): Promise<void> {
    return serializeTransition(sessionId, async () => {
      loadingBySession[sessionId] = true;
      delete errorBySession[sessionId];
      try {
        const entry = findProjectSession(sessionId);
        await startCoordinatorGoal(sessionId, entry.project, undefined, entry.session.model);
      } catch (error) {
        setError(sessionId, error);
        throw error;
      } finally {
        loadingBySession[sessionId] = false;
      }
    });
  }

  async function pauseTranslationRun(sessionId: string): Promise<void> {
    return serializeTransition(sessionId, async () => {
      stoppingSessions.add(sessionId);
      loadingBySession[sessionId] = true;
      delete errorBySession[sessionId];
      try {
        await host.selectSession(sessionId);
        try {
          await host.controlSessionGoal(sessionId, 'pause');
        } catch (error) {
          // A legacy imported session may not have a native goal yet. Stop still
          // has to cancel its active work, while surfacing the missing goal.
          host.pushOperationFailure('pauseTranslationGoal', error, { sessionId });
        }
        const { session } = findProjectSession(sessionId);
        if (session.mainTurnActive || session.busy) await host.abortSession(sessionId);
        await setProjectStatus(sessionId, 'paused');
      } catch (error) {
        setError(sessionId, error);
        throw error;
      } finally {
        stoppingSessions.delete(sessionId);
        loadingBySession[sessionId] = false;
      }
    });
  }

  async function deleteTranslationProject(sessionId: string): Promise<void> {
    return serializeTransition(sessionId, async () => {
      loadingBySession[sessionId] = true;
      try {
        await host.deleteSession(sessionId);
        host.forgetSession(sessionId);
      } catch (error) {
        setError(sessionId, error);
        throw error;
      } finally {
        delete loadingBySession[sessionId];
      }
    });
  }

  async function selectTranslationProject(sessionId: string): Promise<void> {
    await host.selectSession(sessionId);
  }

  async function refreshTranslationProjectRuntime(sessionId: string): Promise<TranslationProject> {
    return serializeTransition(sessionId, async () => {
      const current = findProjectSession(sessionId).project;
      const runtime = await host.getTranslationProjectStatus({
        projectId: current.projectId,
        projectRoot: current.paths.projectRoot,
      });
      let merged = mergeTranslationRuntimeStatus(current, runtime);
      if (hasVerifiedTranslationCompletion(merged)) {
        merged = withProjectStatus(merged, 'completed');
      }
      return updateTranslationProjectMetadata(sessionId, merged);
    });
  }

  async function refreshAllTranslationProjectRuntimes(): Promise<void> {
    const sessions = [...translationProjectSessions.value];
    await Promise.all(sessions.map(async ({ sessionId }) => {
      try {
        await refreshTranslationProjectRuntime(sessionId);
      } catch (error) {
        setError(sessionId, error);
      }
    }));
  }

  async function persistInstructionReceipt(
    sessionId: string,
    sessionMessageId: string,
    text: string,
    scope: OverrideScope | undefined,
  ): Promise<void> {
    try {
      const entry = findProjectSession(sessionId);
      const acknowledgement = await host.recordTranslationInstruction({
        projectId: entry.project.projectId,
        projectRoot: entry.project.paths.projectRoot,
        sessionMessageId,
        message: text,
        affectedScope: instructionAffectedScope(scope),
        interruptMode: 'SOFT',
      });
      const live = findProjectSession(sessionId).project;
      const cost = acknowledgement.costImpact ?? {};
      const receipt = createTranslationInstructionReceipt({
        eventId: `${live.projectId}:instruction:${acknowledgement.instructionVersion}`,
        sessionMessageId,
        instructionVersion: acknowledgement.instructionVersion,
        message: text,
        affectedScope: acknowledgement.affectedScope,
        interruptMode: 'SOFT',
        appliedAt: acknowledgement.acceptedAt,
        continuedTaskIds: acknowledgement.continuedTaskIds,
        cancelledTaskIds: acknowledgement.cancelledTaskIds,
        interruptedTaskIds: acknowledgement.interruptedTaskIds ?? [],
        staleTaskIds: acknowledgement.staleTaskIds,
        replacementTaskIds: acknowledgement.replacementTaskIds ?? [],
        costImpact: {
          actualCostMicrosDelta: nonNegativeInteger(
            cost.actualCostMicrosDelta ?? cost.actual_cost_micros_delta,
          ),
          discardedCostMicros: nonNegativeInteger(
            cost.discardedCostMicros ?? cost.discarded_cost_micros,
          ),
          estimatedAdditionalCostMicros: nonNegativeInteger(
            cost.estimatedAdditionalCostMicros ?? cost.estimated_additional_cost_micros,
          ),
          additionalPaidTaskCount: nonNegativeInteger(
            cost.additionalPaidTaskCount ?? cost.additional_paid_task_count,
          ),
          ...(typeof cost.reason === 'string' && cost.reason.trim()
            ? { reason: cost.reason.trim() }
            : {}),
        },
      });
      const merged = mergeTranslationInstructionReceipt(live, receipt);
      await updateTranslationProjectMetadata(sessionId, { ...merged, runtimeError: undefined });
    } catch (error) {
      // Conversation delivery is authoritative. Ledger bookkeeping is useful
      // project evidence, but it must never hide or block a user's normal chat.
      host.pushOperationFailure('translationInstructionRecord', error, { sessionId });
    }
  }

  async function applyUserOverride(
    sessionId: string,
    input: ApplyTranslationOverrideRequest,
  ): Promise<void> {
    const text = input.text.trim();
    if (!text) return;
    return serializeTransition(sessionId, async () => {
      let entry = findProjectSession(sessionId);
      await ensureProjectModel(sessionId, entry.project, entry.session.model);
      await host.selectSession(sessionId);
      if (entry.project.status === 'paused') {
        if (entry.project.coordinatorLaunch?.status !== 'accepted') {
          await startCoordinatorGoal(sessionId, entry.project, undefined, entry.session.model);
          entry = findProjectSession(sessionId);
          if (entry.project.coordinatorLaunch?.status !== 'accepted') return;
        } else {
          await host.controlSessionGoal(sessionId, 'resume');
          await setProjectStatus(sessionId, 'running');
        }
      }
      if (entry.project.status === 'completed') {
        try {
          await host.controlSessionGoal(sessionId, 'cancel');
        } catch (error) {
          host.pushOperationFailure('translationRevisionGoalCleanup', error, { sessionId });
        }
        const nextRound = entry.project.revisionRound + 1;
        let revisionGoal: AppGoal | null = null;
        try {
          await host.setSessionGoal(
            sessionId,
            `Apply revision round ${nextRound} to ${entry.project.name} in this same session. Preserve earlier output versions and produce a validated updated book.`,
          );
          revisionGoal = await host.getSessionGoal(sessionId);
        } catch (error) {
          // Goal creation is not idempotent. A lost response may still have
          // created it, so recover by reading before deciding that it failed.
          try {
            revisionGoal = await host.getSessionGoal(sessionId);
          } catch {
            revisionGoal = null;
          }
          if (revisionGoal === null) throw error;
        }
        if (revisionGoal === null) {
          throw new Error('The revision goal could not be recovered');
        }
        const revisionProject: TranslationProject = {
          ...entry.project,
          revisionRound: nextRound,
          status: 'running',
          runtimeError: undefined,
          revision: entry.project.revision + 1,
          updatedAt: now(),
        };
        await updateTranslationProjectMetadata(
          sessionId,
          revisionProject.coordinatorLaunch === undefined
            ? revisionProject
            : withCoordinatorLaunch(
                revisionProject,
                {
                  ...revisionProject.coordinatorLaunch,
                  status: 'accepted',
                  goalId: revisionGoal.goalId,
                  updatedAt: now(),
                },
                'running',
              ),
        );
      }
      // Match Kimi Code ctrl+s: while a native goal is active, submit+steer even
      // during the idle-looking continuation boundary. This injects the user's
      // text without aborting the assistant stream or an active tool call.
      const sessionMessageId = clientReceiptId('translation_instruction');
      await host.steerPrompt(
        sessionId,
        text,
        undefined,
        { permissionMode: 'auto', throwOnFailure: true, goalActive: true },
      );
      void serializeTransition(
        sessionId,
        () => persistInstructionReceipt(sessionId, sessionMessageId, text, input.scope),
      );
    });
  }

  async function onMainTurnCompleted(_sessionId: string): Promise<void> {
    // Deliberately no stage advancement. Native goal continuation and, from
    // Phase 2 onward, the durable task ledger are the only scheduling owners.
  }

  async function onGoalUpdated(sessionId: string, goal: AppGoal | null): Promise<void> {
    if (goal === null) {
      let missingAcceptedGoal = false;
      let completionRejected = false;
      try {
        await serializeTransition(sessionId, async () => {
          const current = translationProjectSessions.value.find(
            (entry) => entry.sessionId === sessionId,
          );
          if (!current || current.project.status !== 'running') return;
          // A cancel acknowledgement for goal A can arrive after the same
          // serialized session transition has already created goal B. Treat a
          // null event as a hint and confirm the current server snapshot before
          // changing durable project state.
          let confirmedGoal: AppGoal | null;
          try {
            confirmedGoal = await host.getSessionGoal(sessionId);
          } catch (error) {
            host.pushOperationFailure('translationCoordinatorGoalRecovery', error, { sessionId });
            return;
          }
          if (confirmedGoal !== null) {
            completionRejected = (await applyGoalSnapshot(sessionId, confirmedGoal)).completionRejected;
            return;
          }
          missingAcceptedGoal = current.project.coordinatorLaunch?.status === 'accepted';
          await setProjectStatus(sessionId, missingAcceptedGoal ? 'failed' : 'paused');
        });
        if (completionRejected) reportRejectedCompletion(sessionId);
        if (missingAcceptedGoal) {
          setError(sessionId, new Error('Running translation session lost its durable native goal'));
        }
      } catch (error) {
        setError(sessionId, error);
      }
      return;
    }
    let completionRejected = false;
    try {
      await serializeTransition(sessionId, async () => {
        if (!translationProjectSessions.value.some((entry) => entry.sessionId === sessionId)) return;
        completionRejected = (await applyGoalSnapshot(sessionId, goal)).completionRejected;
      });
      if (completionRejected) reportRejectedCompletion(sessionId);
    } catch (error) {
      setError(sessionId, error);
    }
  }

  async function onMainTurnStopped(
    sessionId: string,
    _reason: 'cancelled' | 'failed' | 'blocked',
  ): Promise<void> {
    if (stoppingSessions.has(sessionId)) return;
    const entry = translationProjectSessions.value.find((candidate) => candidate.sessionId === sessionId);
    if (!entry || entry.project.status !== 'running') return;
    // A durable accepted launch is governed only by its exact native goal.
    // A turn-stop event carries no goal/prompt identity and may belong to a
    // cancelled predecessor, so using it as a fallback would pause a new run.
    if (entry.project.coordinatorLaunch?.status === 'accepted') return;
    try {
      // Turn endings do not own Coordinator completion. Native goal.updated is
      // authoritative; this is only a quiet fallback for legacy/no-goal stops.
      await serializeTransition(sessionId, async () => {
        const current = translationProjectSessions.value.find(
          (candidate) => candidate.sessionId === sessionId,
        );
        if (current?.project.status !== 'running') return;
        await setProjectStatus(sessionId, 'paused');
      });
    } catch (error) {
      setError(sessionId, error);
    }
  }

  return {
    translationProjectSessions,
    translationProjects,
    activeTranslationProjectSession,
    activeTranslationProject,
    creating,
    loadingBySession,
    errorBySession,
    createTranslationProject,
    updateTranslationProjectMetadata,
    deleteTranslationProject,
    selectTranslationProject,
    refreshTranslationProjectRuntime,
    refreshAllTranslationProjectRuntimes,
    startTranslationRun,
    resumeTranslationRun,
    pauseTranslationRun,
    applyUserOverride,
    onMainTurnCompleted,
    onMainTurnStopped,
    onGoalUpdated,
  };
}

export type UseTranslationCoordinator = ReturnType<typeof useTranslationCoordinator>;
