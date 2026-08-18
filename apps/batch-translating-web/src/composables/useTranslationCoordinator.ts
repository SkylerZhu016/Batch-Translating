import { computed, reactive, ref, type ComputedRef } from 'vue';
import type { AppGoal, AppSession } from '../api/types';
import {
  createTranslationProject as createProjectMetadata,
  parseProjectMetadata,
  type OverrideScope,
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
export const TRANSLATION_MODEL_PRIORITY = [
  'DeepSeek V4 Flash: Go',
  'Qwen 3.7 Plus: Go',
] as const;

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
  /** TXT only: custom chapter-heading regular expression override. */
  chapterPattern?: string;
  projectRoot: string;
  workspaceId?: string;
  /** The session model is pinned when the Coordinator session is created. */
  model?: string;
  workflow: WorkflowOptions;
  maxAgents: number;
}

export interface ApplyTranslationOverrideRequest {
  text: string;
  /** Reserved for the Phase 3 affected-scope ledger. Never encoded into a side-channel prompt. */
  scope?: OverrideScope;
}

export interface TranslationCoordinatorHost {
  sessions: ComputedRef<AppSession[]>;
  activeSessionId: ComputedRef<string>;
  /** Configured model catalog, used only to enforce DeepSeek-before-Qwen on new projects. */
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
    options?: { permissionMode?: 'manual' | 'auto' | 'yolo' },
  ): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  uploadFile(file: Blob, name?: string): Promise<PromptAttachment>;
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
  const normalized = model?.split('/').at(-1)?.trim();
  return TRANSLATION_MODEL_PRIORITY.some((candidate) => candidate === normalized);
}

function requireAllowedTranslationModel(model: string | undefined): string {
  const pinned = model?.trim();
  if (pinned && isAllowedTranslationModel(pinned)) return pinned;
  throw new Error(
    `Translation requires ${TRANSLATION_MODEL_PRIORITY[0]} or, when unavailable, ${TRANSLATION_MODEL_PRIORITY[1]}`,
  );
}

function translationModelPriority(model: string): number {
  const normalized = model.split('/').at(-1)?.trim();
  const priority = TRANSLATION_MODEL_PRIORITY.findIndex((candidate) => candidate === normalized);
  return priority === -1 ? TRANSLATION_MODEL_PRIORITY.length : priority;
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
    attachments: attachments.map((attachment): TranslationCoordinatorAttachment => ({
      ...attachment,
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

function hasVerifiedTranslationCompletion(_project: TranslationProject): boolean {
  // Phase 1 deliberately has no completion fast-path. Paths, hashes and stage
  // flags written by an Agent are claims, not byte-level evidence. Phase 2's
  // deterministic SQLite ledger/merger must stat the artifact, recompute its
  // hash, and bind source/instruction/plan revisions before this may return
  // true. Until then every native `goal complete` is rejected fail-closed.
  return false;
}

export function buildTranslationCoordinatorGoal(
  project: TranslationProject,
  model?: string,
): string {
  const enabledQualityGates = [
    'one translation pass and one review pass are mandatory',
    project.workflow.secondTranslation ? 'a second translation pass is enabled' : null,
    project.workflow.secondReview ? 'a second review pass is enabled' : null,
    project.workflow.consistencyReview ? 'the consistency review is enabled' : null,
  ].filter((entry): entry is string => entry !== null);
  const modelPolicy = model?.trim()
    ? `Use only the session model pinned as "${model.trim()}". Do not switch models or providers.`
    : 'Use only the model pinned to this session. Do not switch models or providers.';

  return [
    `Translate the complete source book for project "${project.name}" (${project.projectId}) into a publication-ready Chinese edition.`,
    `The immutable source reference is "${project.source.sourcePath}". The final output belongs at "${project.paths.finalOutputPath}".`,
    `Selected quality gates: ${enabledQualityGates.join('; ')}. Maximum concurrent agents: ${project.maxAgents}.`,
    modelPolicy,
    'Act as the long-running translation Coordinator in this same session. Plan and delegate autonomously, preserve source and artifact provenance, and never overwrite an accepted immutable artifact in place.',
    'Treat the project ledger as authoritative. If a required ledger, artifact, quality gate, or validation capability is unavailable, report the project as blocked instead of inventing success.',
    'Ordinary user messages are live steering for this same session: acknowledge them, explain the affected scope and cost impact, keep unrelated work running, and continue the long-term goal without asking the user to type "continue".',
    'A normal message is not Stop. Only an explicit Stop/Cancel action may hard-cancel work; otherwise prefer a safe atomic boundary and preserve valid completed work.',
    'Do not use a fixed application-owned stage queue. Choose the next valid work from the goal, current session state, selected quality gates, budget, and project ledger.',
  ].join('\n\n');
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
    let candidate = storedModel || preferredModel?.trim() || entry.session.model?.trim();
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
    const status: TranslationProject['status'] = goal.status === 'complete'
      ? hasVerifiedTranslationCompletion(current.project)
        ? 'completed'
        : 'failed'
      : goal.status === 'active'
        ? 'running'
        : 'paused';
    const completionRejected = (
      goal.status === 'complete'
      && status === 'failed'
      && current.project.status !== 'failed'
    );
    if (
      status !== 'completed'
      && (current.project.status === 'failed' || current.project.status === 'completed')
    ) return { project: current.project, completionRejected };
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
      const resolved = await ensureProjectModel(sessionId, sourceProject, model);
      let project = resolved.project;
      const pinnedModel = resolved.model;
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
      if (goal.objective !== objective) {
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

      let recoveredGoal = goal;
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
      const pinnedModel = requireAllowedTranslationModel(input.model);
      const selectedPriority = translationModelPriority(pinnedModel);
      const higherPriorityAvailable = host.availableModelIds?.value.some(
        (candidate) => (
          isAllowedTranslationModel(candidate)
          && translationModelPriority(candidate) < selectedPriority
        ),
      ) === true;
      if (higherPriorityAvailable) {
        throw new Error(
          `${TRANSLATION_MODEL_PRIORITY[1]} is only available as a fallback when ${TRANSLATION_MODEL_PRIORITY[0]} is unavailable`,
        );
      }
      const sourceName = input.sourceFile?.name ?? input.sourcePath!.split(/[\\/]/).at(-1)!;
      const uploaded = input.sourceFile
        ? await host.uploadFile(input.sourceFile, sourceName)
        : undefined;
      const sourceReference = input.sourcePath?.trim() || `attachments/${sourceName}`;
      const project = createProjectMetadata({
        name: input.name,
        model: pinnedModel,
        sourcePath: sourceReference,
        chapterPattern: input.chapterPattern,
        projectRoot: input.projectRoot,
        workflow: input.workflow,
        maxAgents: input.maxAgents,
      });
      const preparedProject = withCoordinatorLaunch(
        project,
        createCoordinatorLaunch(project, uploaded ? [uploaded] : []),
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
      // useWorkspaceState.steerPrompt is the native conversation path: it sends
      // a normal turn while idle, or submits+steers into the active turn without
      // aborting it. The user's text is kept verbatim; there is no phase queue or
      // hidden wrapper that delays Coordinator visibility.
      await host.steerPrompt(sessionId, text, undefined, { permissionMode: 'auto' });
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
