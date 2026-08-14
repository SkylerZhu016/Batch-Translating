import { computed, reactive, ref, type ComputedRef } from 'vue';
import type { AppSession } from '../api/types';
import type { PromptAttachment } from './useKimiWebClient';
import {
  appendUserOverride,
  buildStagePrompt,
  createTranslationProject as createProjectMetadata,
  parseProjectMetadata,
  setUserOverrideStatus,
  type OverrideScope,
  type StageRunState,
  type TranslationProject,
  type TranslationTaskDescriptor,
  type WorkflowOptions,
} from '../translation';

export const TRANSLATION_METADATA_KEY = 'batchTranslation';
export const TRANSLATION_AGENT_PROFILE = 'batch-translator';
export const TRANSLATION_TOOL_ALLOWLIST = ['Read', 'Write', 'Bash', 'AgentSwarm'] as const;

type SubmitOutcome = 'ok' | 'rejected' | 'uncertain';

interface StageExecutionResult {
  stage_id: string;
  prompt_version: string;
  plan_fingerprint: string;
  status: 'completed' | 'failed' | 'blocked';
  task_counts: { total: number; completed: number; failed: number; stale: number };
  artifacts: string[];
  checkpoint?: string | null;
  errors: string[];
}

interface StageVerification {
  ok: boolean;
  result?: StageExecutionResult;
  errors: string[];
}

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
  workflow: WorkflowOptions;
  maxAgents: number;
}

export interface ApplyTranslationOverrideRequest {
  text: string;
  scope?: OverrideScope;
}

export interface TranslationRunnerHost {
  sessions: ComputedRef<AppSession[]>;
  activeSessionId: ComputedRef<string>;
  activity: ComputedRef<string>;
  createSession(input: {
    title?: string;
    cwd?: string;
    model?: string;
    workspaceId?: string;
    metadata?: Record<string, unknown>;
    agentProfile?: string;
  }): Promise<AppSession>;
  updateSessionMetadata(sessionId: string, project: TranslationProject): Promise<AppSession>;
  deleteSession(sessionId: string): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  submitPromptToSession(
    sessionId: string,
    text: string,
    attachments?: PromptAttachment[],
    options?: { profile?: string; disabledTools?: string[]; permissionMode?: 'manual' | 'auto' | 'yolo' },
  ): Promise<SubmitOutcome>;
  steerPrompt(text: string, attachments?: PromptAttachment[]): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  uploadFile(file: Blob, name?: string): Promise<PromptAttachment>;
  readSessionFile(sessionId: string, path: string): Promise<{
    content: string;
    encoding: 'utf-8' | 'base64';
    isBinary: boolean;
    truncated: boolean;
  } | null>;
  forgetSession(sessionId: string): void;
  pushOperationFailure(operation: string, error: unknown, options?: { sessionId?: string }): void;
}

function metadataProject(session: AppSession): TranslationProject | null {
  const parsed = parseProjectMetadata(session.metadata[TRANSLATION_METADATA_KEY]);
  return parsed.ok ? parsed.value : null;
}

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function parseStageExecutionResult(value: unknown): StageExecutionResult | null {
  if (!isRecord(value) || !isRecord(value.task_counts)) return null;
  const counts = value.task_counts;
  if (
    typeof value.stage_id !== 'string'
    || typeof value.prompt_version !== 'string'
    || typeof value.plan_fingerprint !== 'string'
    || !['completed', 'failed', 'blocked'].includes(String(value.status))
    || !isNonNegativeInteger(counts.total)
    || !isNonNegativeInteger(counts.completed)
    || !isNonNegativeInteger(counts.failed)
    || !isNonNegativeInteger(counts.stale)
    || !Array.isArray(value.artifacts)
    || value.artifacts.some((path) => typeof path !== 'string' || path.length === 0)
    || !Array.isArray(value.errors)
    || value.errors.some((error) => typeof error !== 'string')
    || (value.checkpoint !== undefined && value.checkpoint !== null && typeof value.checkpoint !== 'string')
  ) return null;
  return value as unknown as StageExecutionResult;
}

function withProjectRevision(
  project: TranslationProject,
  patch: Partial<TranslationProject>,
): TranslationProject {
  return {
    ...project,
    ...patch,
    revision: project.revision + 1,
    updatedAt: now(),
  };
}

function stageTasks(project: TranslationProject, stage: StageRunState): TranslationTaskDescriptor[] {
  if (stage.definition.execution !== 'agent_swarm') return [];
  return project.chapters.map((chapter) => ({
    taskId: `${stage.definition.id}:${chapter.chapterId}`,
    chapterId: chapter.chapterId,
    paragraphIds: [],
    sourcePath: chapter.sourcePath,
    outputPath: project.paths.translationDir,
    sourceHash: 'pending-preflight',
    snapshotId: project.planFingerprint,
    attemptNumber: stage.attempt + 1,
  }));
}

function stageResultPath(project: TranslationProject, stageId: string): string {
  const separator = project.paths.stateDir.includes('\\') && !project.paths.stateDir.includes('/')
    ? '\\'
    : '/';
  return `${project.paths.stateDir.replace(/[\\/]+$/, '')}${separator}stage-results${separator}${stageId}.json`;
}

export function nextRunnableStage(project: TranslationProject): StageRunState | undefined {
  const active = project.activeStageId
    ? project.stages.find((stage) => stage.definition.id === project.activeStageId)
    : undefined;
  if (active?.status === 'running') return active;
  return project.stages.find((stage) => stage.status === 'pending' || stage.status === 'stale');
}

/**
 * The translation runner owns every stage transition. Model output is never
 * consulted to add, remove, repeat, skip, or reorder stages.
 */
export function useTranslationRunner(host: TranslationRunnerHost) {
  const loadingBySession = reactive<Record<string, boolean>>({});
  const errorBySession = reactive<Record<string, string>>({});
  const creating = ref(false);
  const launchingSessions = new Set<string>();
  const advancingSessions = new Set<string>();
  const pausingSessions = new Set<string>();
  const nonStageTurnSessions = new Set<string>();
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
    host.pushOperationFailure('translationRunner', error, { sessionId });
  }

  async function updateTranslationProjectMetadata(
    sessionId: string,
    project: TranslationProject,
  ): Promise<TranslationProject> {
    const session = await host.updateSessionMetadata(sessionId, project);
    return metadataProject(session) ?? project;
  }

  async function verifyStageResult(
    sessionId: string,
    project: TranslationProject,
    stage: StageRunState,
  ): Promise<StageVerification> {
    const errors: string[] = [];
    const path = stageResultPath(project, stage.definition.id);
    const file = await host.readSessionFile(sessionId, path);
    if (file === null) return { ok: false, errors: [`Missing stage result: ${path}`] };
    if (file.isBinary || file.encoding !== 'utf-8' || file.truncated) {
      return { ok: false, errors: [`Stage result is unreadable or truncated: ${path}`] };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(file.content);
    } catch (error) {
      return { ok: false, errors: [`Invalid stage result JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const result = parseStageExecutionResult(raw);
    if (result === null) return { ok: false, errors: ['Stage result does not match the required schema'] };
    if (result.stage_id !== stage.definition.id) errors.push('stage_id does not match the running stage');
    if (result.prompt_version !== project.promptVersion) errors.push('prompt_version does not match the project');
    if (result.plan_fingerprint !== project.planFingerprint) errors.push('plan_fingerprint does not match the locked plan');
    if (result.status !== 'completed') errors.push(...(result.errors.length > 0 ? result.errors : [`Stage returned ${result.status}`]));
    if (result.task_counts.failed !== 0 || result.task_counts.stale !== 0) {
      errors.push('Stage still has failed or stale tasks');
    }
    if (result.task_counts.completed !== result.task_counts.total) {
      errors.push('Stage task coverage is incomplete');
    }
    if (stage.definition.execution !== 'deterministic' && !result.checkpoint) {
      errors.push('Semantic stage did not produce a checkpoint');
    }
    const requiredPaths = [...result.artifacts, ...(result.checkpoint ? [result.checkpoint] : [])];
    for (const artifactPath of requiredPaths) {
      const artifact = await host.readSessionFile(sessionId, artifactPath);
      if (artifact === null || artifact.truncated) errors.push(`Required artifact is missing or truncated: ${artifactPath}`);
    }
    return { ok: errors.length === 0, result, errors };
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
      const sourceName = input.sourceFile?.name ?? input.sourcePath!.split(/[\\/]/).at(-1)!;
      const uploaded = input.sourceFile
        ? await host.uploadFile(input.sourceFile, sourceName)
        : undefined;
      // Uploaded files are materialized by the daemon into the session's
      // attachments directory on the first prompt. The deterministic preflight
      // then copies it into project/source and never overwrites that source.
      const sourceReference = input.sourcePath?.trim() || `attachments/${sourceName}`;
      const project = createProjectMetadata({
        name: input.name,
        sourcePath: sourceReference,
        chapterPattern: input.chapterPattern,
        projectRoot: input.projectRoot,
        workflow: input.workflow,
        maxAgents: input.maxAgents,
      });
      createdSession = await host.createSession({
        title: input.name,
        cwd: input.projectRoot,
        workspaceId: input.workspaceId,
        agentProfile: TRANSLATION_AGENT_PROFILE,
        metadata: { [TRANSLATION_METADATA_KEY]: project },
      });
      await host.selectSession(createdSession.id);
      await startStage(createdSession.id, project, uploaded ? [uploaded] : undefined);
      return metadataProject(createdSession) ?? project;
    } catch (error) {
      if (createdSession) setError(createdSession.id, error);
      else host.pushOperationFailure('createTranslationProject', error);
      throw error;
    } finally {
      creating.value = false;
    }
  }

  async function startStage(
    sessionId: string,
    sourceProject?: TranslationProject,
    attachments?: PromptAttachment[],
  ): Promise<void> {
    if (launchingSessions.has(sessionId)) throw new Error('This translation stage is already starting');
    launchingSessions.add(sessionId);
    try {
    const project = sourceProject ?? findProjectSession(sessionId).project;
    const stage = nextRunnableStage(project);
    if (stage === undefined) return;
    const stageIndex = project.stages.findIndex((candidate) => candidate.definition.id === stage.definition.id);
    const running = withProjectRevision(project, {
      status: 'running',
      activeStageId: stage.definition.id,
      stages: project.stages.map((candidate, index): StageRunState => index === stageIndex
        ? { ...candidate, status: 'running', attempt: candidate.attempt + 1, startedAt: now(), lastError: undefined }
        : candidate),
    });
    await updateTranslationProjectMetadata(sessionId, running);
    const prompt = buildStagePrompt({
      project: running,
      stageId: stage.definition.id,
      paths: running.paths,
      tasks: stageTasks(running, stage),
      maxAgents: running.maxAgents,
    });
    const runnerBoundaryInstruction = [
      '【阶段完成边界】AgentSwarm 必须以前台方式运行（run_in_background=false）。',
      '主 Agent 必须等待本阶段全部 worker、确定性合并与验收结束后才结束当前 turn；',
      '不得留下后台任务后提前返回。应用只以这个 main turn 的正常完成推进下一个固定阶段。',
      `结束前必须把 STAGE_EXECUTION_RESULT_SCHEMA 的唯一顶层对象用 Write 写到 ${stageResultPath(running, stage.definition.id)}。`,
      '写入时先写同目录临时文件，再原子替换目标文件；最终回复同一对象。若无法写入或验收失败，status 必须为 failed/blocked，禁止伪造 completed。',
    ].join('');
    const sourceAttachmentInstruction = attachments?.length
      ? [
          '【源文件附件】本消息随后附带的服务器文件通知包含上传源文件（EPUB 或 TXT）的实际只读路径。',
          '解析阶段必须使用通知中的精确路径作为运行时源文件，先复制到 paths.sourceCopy，再只操作副本；',
          'metadata 中的 attachments/... 只是稳定逻辑引用，禁止据此猜测实际文件名。',
        ].join('')
      : '';
    const outcome = await host.submitPromptToSession(
      sessionId,
      sourceAttachmentInstruction
        ? `${prompt.fullPrompt}\n\n${runnerBoundaryInstruction}\n\n${sourceAttachmentInstruction}`
        : `${prompt.fullPrompt}\n\n${runnerBoundaryInstruction}`,
      attachments,
      {
        profile: TRANSLATION_AGENT_PROFILE,
        disabledTools: [],
        // Translation is unattended batch work: force auto so Bash/Write/Edit
        // never stall on an approval request nobody is watching (AskUserQuestion
        // is denied outright in auto mode, which is also fine for batch work).
        // Workers inherit the main agent's mode on spawn.
        permissionMode: 'auto',
      },
    );
    if (outcome !== 'ok') {
      const failed = withProjectRevision(running, {
        status: 'failed',
        stages: running.stages.map((candidate, index): StageRunState => index === stageIndex
          ? { ...candidate, status: 'failed', lastError: `Prompt submission ${outcome}` }
          : candidate),
      });
      await updateTranslationProjectMetadata(sessionId, failed);
      throw new Error(`Translation stage prompt was ${outcome}`);
    }
    } finally {
      launchingSessions.delete(sessionId);
    }
  }

  async function startTranslationRun(sessionId: string): Promise<void> {
    loadingBySession[sessionId] = true;
    delete errorBySession[sessionId];
    try {
      await host.selectSession(sessionId);
      await startStage(sessionId);
    } catch (error) {
      setError(sessionId, error);
      throw error;
    } finally {
      loadingBySession[sessionId] = false;
    }
  }

  async function resumeTranslationRun(sessionId: string): Promise<void> {
    const { project } = findProjectSession(sessionId);
    const resumable = project.status === 'paused' || project.status === 'failed'
      ? withProjectRevision(project, {
          status: 'running',
          stages: project.stages.map((stage): StageRunState =>
            stage.status === 'failed' || stage.status === 'blocked'
              ? { ...stage, status: 'pending', lastError: undefined }
              : stage),
        })
      : project;
    if (resumable !== project) await updateTranslationProjectMetadata(sessionId, resumable);
    if (project.status === 'paused') {
      // Paused mid-turn: the full stage prompt is already in the model's
      // context (wire-persisted). Just nudge the model to continue — no need
      // to resend thousands of system-prompt characters.
      await continueTranslationRun(sessionId);
    } else {
      await startTranslationRun(sessionId);
    }
  }

  async function continueTranslationRun(sessionId: string): Promise<void> {
    loadingBySession[sessionId] = true;
    delete errorBySession[sessionId];
    try {
      await host.selectSession(sessionId);
      const outcome = await host.submitPromptToSession(
        sessionId,
        '继续执行当前阶段的剩余任务；上下文已完整保留，不需要重新介绍任务。',
        undefined,
        { profile: TRANSLATION_AGENT_PROFILE, disabledTools: [], permissionMode: 'auto' },
      );
      if (outcome !== 'ok') {
        throw new Error(`Translation continue prompt was ${outcome}`);
      }
    } catch (error) {
      setError(sessionId, error);
      throw error;
    } finally {
      loadingBySession[sessionId] = false;
    }
  }

  async function pauseTranslationRun(sessionId: string): Promise<void> {
    pausingSessions.add(sessionId);
    return serializeTransition(sessionId, async () => {
    const { session } = findProjectSession(sessionId);
    try {
      if (session.mainTurnActive || session.busy) await host.abortSession(sessionId);
      // Re-read after abort: its turn-ended event may have refreshed metadata
      // while the request was in flight. Never overwrite that newer revision
      // with the snapshot captured before abort.
      const latest = findProjectSession(sessionId).project;
      const paused = withProjectRevision(latest, {
        status: 'paused',
        stages: latest.stages.map((stage): StageRunState =>
          stage.status === 'running'
            ? { ...stage, status: 'blocked', lastError: 'Paused by user' }
            : stage),
      });
      await updateTranslationProjectMetadata(sessionId, paused);
    } finally {
      pausingSessions.delete(sessionId);
    }
    });
  }

  async function deleteTranslationProject(sessionId: string): Promise<void> {
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
  }

  async function selectTranslationProject(sessionId: string): Promise<void> {
    await host.selectSession(sessionId);
  }

  async function applyUserOverride(
    sessionId: string,
    input: ApplyTranslationOverrideRequest,
  ): Promise<void> {
    const { project, session } = findProjectSession(sessionId);
    const queued = appendUserOverride(project, {
      instruction: input.text,
      scope: input.scope,
      expectedProjectRevision: project.revision,
    });
    await updateTranslationProjectMetadata(sessionId, queued);
    // Running turns receive steering immediately as directional context. The
    // versioned override remains queued and is authoritatively applied only at
    // the next stage boundary; steering never changes the locked stage plan.
    if (session.mainTurnActive || session.busy) {
      await host.selectSession(sessionId);
      await host.steerPrompt(
        `【用户纠偏 v${queued.overrideRevision}】${input.text}\n\n仅修正当前方向；不得改变固定阶段、轮次数量或工具白名单。`,
      );
    } else {
      nonStageTurnSessions.add(sessionId);
      try {
        const outcome = await host.submitPromptToSession(
          sessionId,
          `【用户纠偏 v${queued.overrideRevision}】${input.text}\n\n记录此纠偏并仅将其应用于下一阶段边界；不得提前执行阶段、改变固定轮次或扩展工具集。`,
          undefined,
          { profile: TRANSLATION_AGENT_PROFILE, disabledTools: [], permissionMode: 'auto' },
        );
        if (outcome !== 'ok') {
          nonStageTurnSessions.delete(sessionId);
          throw new Error(`Translation override prompt was ${outcome}`);
        }
      } catch (error) {
        nonStageTurnSessions.delete(sessionId);
        throw error;
      }
    }
  }

  function applyQueuedOverridesAtBoundary(
    project: TranslationProject,
  ): TranslationProject {
    let next = project;
    for (const override of project.overrides) {
      if (override.status === 'queued') {
        next = setUserOverrideStatus(next, override.overrideId, 'applied');
      }
    }
    return next;
  }

  async function onMainTurnCompleted(sessionId: string): Promise<void> {
    if (nonStageTurnSessions.delete(sessionId)) return;
    if (advancingSessions.has(sessionId) || pausingSessions.has(sessionId)) return;
    return serializeTransition(sessionId, async () => {
    const entry = translationProjectSessions.value.find((candidate) => candidate.sessionId === sessionId);
    if (!entry || entry.project.status !== 'running' || !entry.project.activeStageId) return;
    const activeIndex = entry.project.stages.findIndex(
      (stage) => stage.definition.id === entry.project.activeStageId,
    );
    if (activeIndex < 0 || entry.project.stages[activeIndex]?.status !== 'running') return;
    advancingSessions.add(sessionId);
    try {
      const verification = await verifyStageResult(
        sessionId,
        entry.project,
        entry.project.stages[activeIndex]!,
      );
      const latestAfterVerification = translationProjectSessions.value.find(
        (candidate) => candidate.sessionId === sessionId,
      )?.project;
      if (
        pausingSessions.has(sessionId)
        || latestAfterVerification === undefined
        || latestAfterVerification.status !== 'running'
        || latestAfterVerification.activeStageId !== entry.project.activeStageId
        || latestAfterVerification.revision !== entry.project.revision
      ) return;
      if (!verification.ok || verification.result === undefined) {
        const message = verification.errors.join('; ');
        const failed = withProjectRevision(entry.project, {
          status: 'failed',
          stages: entry.project.stages.map((stage, index): StageRunState => index === activeIndex
            ? { ...stage, status: 'failed', lastError: message }
            : stage),
        });
        await updateTranslationProjectMetadata(sessionId, failed);
        setError(sessionId, new Error(message));
        return;
      }
      let next = withProjectRevision(entry.project, {
        activeStageId: undefined,
        stages: entry.project.stages.map((stage, index): StageRunState => index === activeIndex
          ? {
              ...stage,
              status: 'completed',
              completedAt: now(),
              checkpointId: verification.result!.checkpoint ?? undefined,
              taskCounts: {
                total: verification.result!.task_counts.total,
                pending: 0,
                running: 0,
                failed: 0,
                completed: verification.result!.task_counts.completed,
              },
            }
          : stage),
      });
      const hasNext = next.stages.some((stage) => stage.status === 'pending' || stage.status === 'stale');
      if (!hasNext) next = withProjectRevision(next, { status: 'completed' });
      next = applyQueuedOverridesAtBoundary(next);
      await updateTranslationProjectMetadata(sessionId, next);
      if (hasNext) await startStage(sessionId, next);
    } catch (error) {
      setError(sessionId, error);
    } finally {
      advancingSessions.delete(sessionId);
    }
    });
  }

  async function onMainTurnStopped(sessionId: string, reason: 'cancelled' | 'failed' | 'blocked'): Promise<void> {
    if (nonStageTurnSessions.delete(sessionId)) return;
    if (pausingSessions.has(sessionId)) return;
    const entry = translationProjectSessions.value.find((candidate) => candidate.sessionId === sessionId);
    if (!entry || entry.project.status !== 'running') return;
    const status = reason === 'failed' ? 'failed' : 'paused';
    const next = withProjectRevision(entry.project, {
      status,
      stages: entry.project.stages.map((stage): StageRunState => stage.status === 'running'
        ? { ...stage, status: reason === 'failed' ? 'failed' : 'blocked', lastError: reason }
        : stage),
    });
    await updateTranslationProjectMetadata(sessionId, next);
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
  };
}

export type UseTranslationRunner = ReturnType<typeof useTranslationRunner>;
