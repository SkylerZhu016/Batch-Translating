<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onAuthRequired } from './api/daemon/serverAuth';
import type { AppConfig, AppTask, TranslationRagStatus } from './api/types';
import AddWorkspaceDialog from './components/dialogs/AddWorkspaceDialog.vue';
import ConfigureProviderDialog from './components/dialogs/ConfigureProviderDialog.vue';
import EditProviderModelsDialog from './components/dialogs/EditProviderModelsDialog.vue';
import ExitAppDialog from './components/dialogs/ExitAppDialog.vue';
import AgentConsole from './components/translation/AgentConsole.vue';
import ConfirmDialogHost from './components/dialogs/ConfirmDialogHost.vue';
import GlobalLoading from './components/GlobalLoading.vue';
import ServerAuthDialog from './components/ServerAuthDialog.vue';
import ProviderManager from './components/settings/ProviderManager.vue';
import CreateTranslationProjectDialog from './components/translation/CreateTranslationProjectDialog.vue';
import ProjectDetailsDialog from './components/translation/ProjectDetailsDialog.vue';
import TranslationIssuesView from './components/translation/TranslationIssuesView.vue';
import TranslationOutputsView from './components/translation/TranslationOutputsView.vue';
import TranslationProjectsView from './components/translation/TranslationProjectsView.vue';
import LanguageSelectionDialog from './components/translation/LanguageSelectionDialog.vue';
import TranslationRunWorkbench from './components/translation/TranslationRunWorkbench.vue';
import TranslationSettingsView from './components/translation/TranslationSettingsView.vue';
import TranslationShell from './components/translation/TranslationShell.vue';
import type {
  TranslationAgent,
  TranslationChapter,
  TranslationExecutionPolicy,
  TranslationIssue as ViewIssue,
  TranslationOutput,
  TranslationProject as ViewProject,
  TranslationProjectDraft,
  TranslationSettings,
  TranslationStage,
  TranslationStageId,
  TranslationStageStatus,
  TranslationView,
  TranslationWorkflowOptions,
} from './components/translation/types';
import type { BgeModelSetupState } from './components/translation/bgeModelSetup.types';
import Banner from './components/ui/Banner.vue';
import Button from './components/ui/Button.vue';
import EmptyState from './components/ui/EmptyState.vue';
import Field from './components/ui/Field.vue';
import Icon from './components/ui/Icon.vue';
import SegmentedControl from './components/ui/SegmentedControl.vue';
import WarningToasts from './components/WarningToasts.vue';
import { useAppearance } from './composables/client/useAppearance';
import type {
  ColorScheme,
  DayTheme,
  NightTheme,
  UiFont,
} from './composables/client/useAppearance';
import { useAuthGate } from './composables/useAuthGate';
import { useConfirmDialog } from './composables/useConfirmDialog';
import { useKimiWebClient } from './composables/useKimiWebClient';
import {
  isAllowedTranslationModel,
  TRANSLATION_MODEL_PRIORITY,
} from './composables/useTranslationCoordinator';
import { localeConfirmed } from './i18n';
import { verifiedTranslationOutputPath } from './translation/project';
import {
  BGE_M3_MODEL_ID,
  createTranslationQualityPolicy,
  type TranslationQualityCapabilityProbe,
  type TranslationQualityPolicy,
} from './translation/qualityPolicy';
import type {
  ChapterProgress,
  StageRunState,
  TranslationIssue,
  TranslationProject,
  WorkflowOptions,
} from './translation/types';

const client = useKimiWebClient();
const runner = client;
const appearance = useAppearance();
const { t } = useI18n();
const { confirm } = useConfirmDialog();

const authRequired = ref(false);
const showConfigureProvider = ref(false);
const showExitApp = ref(false);
const editProviderId = ref<string | null>(null);
const showProviders = ref(false);
const providersLoading = ref(false);
const providersUnavailable = ref(false);
const authLogoRef = ref<SVGSVGElement | null>(null);
const { showAuthGate } = useAuthGate({ client, authLogoRef });
const showLocaleGate = computed(
  () => !localeConfirmed.value,
);
const showMainUi = computed(
  () => client.initialized.value && !showAuthGate.value && !showLocaleGate.value,
);
const showServerAuth = computed(
  () => !client.dangerousBypassAuth.value && authRequired.value,
);

provide('resolveImage', client.resolveImageUrl);
provide(
  'resolveSwarmMembers',
  (toolCallId: string) => client.swarmMembersByToolCallId.value.get(toolCallId) ?? [],
);

let stopAuthRequired: (() => void) | null = null;

onMounted(() => {
  stopAuthRequired = onAuthRequired(() => {
    authRequired.value = true;
    client.clearDangerousBypassAuth();
  });
  void client.load()
    .then(async () => {
      await client.loadAllSessions();
      await Promise.allSettled([
        // Detection is read-only and never downloads a model. A real backend
        // probe is required before the UI may unlock the second-review gate.
        client.detectTranslationRag(),
        client.refreshAllTranslationProjectRuntimes(),
      ]);
    })
    .catch(() => undefined);
});

onUnmounted(() => {
  stopAuthRequired?.();
  stopAuthRequired = null;
});

const activeView = ref<TranslationView>('projects');
const selectedSessionId = ref<string | null>(null);
const showCreateProject = ref(false);
const showProjectDetails = ref(false);
const showWorkspacePicker = ref(false);
const workspacePickerError = ref<string | null>(null);
const selectedSourceFile = ref<File | null>(null);
const createSaving = ref(false);
const createError = ref<string | undefined>();
const correction = ref('');
const correctionSubmitting = ref(false);
const correctionError = ref<string | null>(null);
const settingsSaving = ref(false);
const diagnosticsExporting = ref(false);

const REQUIRED_TOOLS = ['Read', 'Write', 'Bash', 'AgentSwarm'] as const;
const SETTINGS_STORAGE_KEY = 'batch-translating.settings';
const EXIT_NO_PROMPT_KEY = 'batch-translating.exit-no-prompt';

/** Exit flow: skip the confirmation when the user checked "don't ask again",
 *  then gracefully stop the daemon (the desktop shell exits when the engine
 *  it spawned terminates; in the browser the tab is closed best-effort). */
async function requestExit(): Promise<void> {
  if (localStorage.getItem(EXIT_NO_PROMPT_KEY) === '1') {
    await doExit();
    return;
  }
  showExitApp.value = true;
}

async function onExitConfirmed(dontAskAgain: boolean): Promise<void> {
  showExitApp.value = false;
  if (dontAskAgain) localStorage.setItem(EXIT_NO_PROMPT_KEY, '1');
  await doExit();
}

async function doExit(): Promise<void> {
  // Pause every running translation job first so a restart never resumes a
  // stale "running" state; the daemon's own shutdown hook does the same for
  // exits that bypass the UI (e.g. the tray icon).
  const running = client.translationProjectSessions.value.filter(
    (entry) => entry.project.status === 'running',
  );
  for (const entry of running) {
    try {
      await client.pauseTranslationRun(entry.sessionId);
    } catch {
      // Best-effort: the daemon shutdown hook below still pauses leftovers.
    }
  }
  try {
    await client.shutdown();
  } catch {
    // The server tears down right after replying; a dropped connection here
    // means it is already going down.
  }
  window.close();
}

function defaultWorkflow(): TranslationWorkflowOptions {
  return {
    firstTranslation: true,
    firstReview: true,
    secondTranslation: false,
    secondReview: false,
    consistencyReview: false,
  };
}

function defaultModelId(): string {
  const preferred = preferredAvailableTranslationModels()[0]?.id;
  if (preferred) return preferred;
  const configured = client.defaultModel.value;
  if (configured && isAllowedTranslationModel(configured)) return configured;
  return '';
}

function translationModelPriority(modelId: string): number {
  const modelName = modelId.split('/').at(-1)?.trim();
  const priority = TRANSLATION_MODEL_PRIORITY.findIndex((candidate) => candidate === modelName);
  return priority === -1 ? TRANSLATION_MODEL_PRIORITY.length : priority;
}

function preferredAvailableTranslationModels() {
  const allowed = [...client.models.value]
    .filter((model) => isAllowedTranslationModel(model.id))
    .sort((left, right) => translationModelPriority(left.id) - translationModelPriority(right.id));
  const bestPriority = allowed[0] ? translationModelPriority(allowed[0].id) : undefined;
  return bestPriority === undefined
    ? []
    : allowed.filter((model) => translationModelPriority(model.id) === bestPriority);
}

function defaultWorkspacePath(): string {
  return client.visibleWorkspace.value?.root
    ?? client.status.value.cwd
    ?? '';
}

function defaultExecutionPolicy(agentCount = 16): TranslationExecutionPolicy {
  return {
    softBudgetMicros: 20_000_000,
    hardBudgetMicros: 30_000_000,
    maxRetries: 2,
    maxConcurrency: Math.min(agentCount, 16),
  };
}

function normalizeExecutionPolicy(
  value: Partial<TranslationExecutionPolicy> | undefined,
  agentCount: number,
): TranslationExecutionPolicy {
  const fallback = defaultExecutionPolicy(agentCount);
  const softBudgetMicros = Number.isSafeInteger(value?.softBudgetMicros)
    && (value?.softBudgetMicros ?? -1) >= 0
    ? value!.softBudgetMicros!
    : fallback.softBudgetMicros;
  const requestedHard = Number.isSafeInteger(value?.hardBudgetMicros)
    && (value?.hardBudgetMicros ?? -1) >= 0
    ? value!.hardBudgetMicros!
    : fallback.hardBudgetMicros;
  const maxRetries = Number.isSafeInteger(value?.maxRetries)
    ? Math.min(20, Math.max(0, value!.maxRetries!))
    : fallback.maxRetries;
  const maxConcurrency = Number.isSafeInteger(value?.maxConcurrency)
    ? Math.min(agentCount, Math.max(1, value!.maxConcurrency!))
    : fallback.maxConcurrency;
  return {
    softBudgetMicros,
    hardBudgetMicros: Math.max(softBudgetMicros, requestedHard),
    maxRetries,
    maxConcurrency,
  };
}

function newProjectDraft(): TranslationProjectDraft {
  const agentCount = 16;
  return {
    title: '',
    sourcePath: '',
    chapterPattern: '',
    workspacePath: defaultWorkspacePath(),
    agentCount,
    workflow: defaultWorkflow(),
    executionPolicy: defaultExecutionPolicy(agentCount),
  };
}

function loadSettings(): TranslationSettings {
  const fallback: TranslationSettings = {
    defaultModel: defaultModelId(),
    defaultAgentCount: 16,
    defaultWorkflow: defaultWorkflow(),
    executionPolicy: defaultExecutionPolicy(),
    bge: {
      source: 'mirror',
      cpuFallback: true,
    },
  };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<TranslationSettings>;
    const workflow = parsed.defaultWorkflow;
    const defaultAgentCount = typeof parsed.defaultAgentCount === 'number'
      ? Math.min(128, Math.max(2, Math.round(parsed.defaultAgentCount)))
      : fallback.defaultAgentCount;
    return {
      defaultModel: typeof parsed.defaultModel === 'string'
        ? parsed.defaultModel
        : fallback.defaultModel,
      defaultAgentCount,
      defaultWorkflow: {
        firstTranslation: true,
        firstReview: true,
        secondTranslation: workflow?.secondTranslation === true,
        secondReview: workflow?.secondReview === true,
        consistencyReview: workflow?.consistencyReview === true,
      },
      bge: {
        source: parsed.bge?.source === 'official' ? 'official' : 'mirror',
        cpuFallback: parsed.bge?.cpuFallback !== false,
      },
      executionPolicy: normalizeExecutionPolicy(parsed.executionPolicy, defaultAgentCount),
    };
  } catch {
    return fallback;
  }
}

const createDraft = ref<TranslationProjectDraft>(newProjectDraft());
const settingsDraft = ref<TranslationSettings>(loadSettings());

const modelOptions = computed(() => preferredAvailableTranslationModels()
  .map((model) => ({
    value: model.id,
    label: model.displayName ?? model.model ?? model.id,
  })));

watch(
  [modelOptions, () => client.defaultModel.value],
  ([options, configured]) => {
    const available = new Set(options.map((option) => option.value));
    const current = settingsDraft.value.defaultModel;
    if (current && isAllowedTranslationModel(current) && available.has(current)) return;
    settingsDraft.value.defaultModel = configured
      && isAllowedTranslationModel(configured)
      && available.has(configured)
      ? configured
      : (options[0]?.value ?? '');
  },
  { immediate: true },
);

type ProjectSession = {
  sessionId: string;
  session: { model?: string };
  project: TranslationProject;
};

const projectSessions = computed<ProjectSession[]>(
  () => runner.translationProjectSessions.value,
);

const selectedEntry = computed<ProjectSession | null>(() => {
  if (!selectedSessionId.value) return null;
  return projectSessions.value.find((entry) => entry.sessionId === selectedSessionId.value) ?? null;
});

const selectedProject = computed(() => selectedEntry.value?.project ?? null);

function capabilityProbeFromRagStatus(
  status: TranslationRagStatus,
): TranslationQualityCapabilityProbe {
  const bgeReady = status.state === 'available'
    && status.denseReady === true
    && Boolean(status.fingerprint?.trim());
  const retrievalReady = bgeReady
    && status.serviceStatus === 'ready'
    && status.indexReady === true
    && status.degraded !== true;
  return {
    bgeM3: {
      status: bgeReady ? 'ready' : status.state === 'failed' ? 'unhealthy' : 'missing',
      modelId: BGE_M3_MODEL_ID,
      ...(status.fingerprint ? { fingerprint: status.fingerprint } : {}),
      source: status.source
        ? 'managed-download'
        : status.modelPath
          ? 'local-cache'
          : 'unknown',
      denseAvailable: bgeReady,
    },
    rag: {
      status: retrievalReady ? 'ready' : status.state === 'missing' ? 'missing' : 'unhealthy',
      serviceReachable: status.serviceStatus === 'ready',
      denseRetrievalAvailable: retrievalReady,
    },
  };
}

function qualityPolicyFor(workflow: TranslationWorkflowOptions): TranslationQualityPolicy | undefined {
  try {
    return createTranslationQualityPolicy({
      capabilityProbe: capabilityProbeFromRagStatus(client.translationRagStatus.value),
      requestedWorkflow: workflowForRunner(workflow),
      availableModelIds: modelOptions.value.map((option) => option.value),
    });
  } catch {
    // No allowed model or no trustworthy capability result: UI stays locked.
    return undefined;
  }
}

const createProjectQualityPolicy = computed(
  () => qualityPolicyFor(createDraft.value.workflow),
);
const settingsQualityPolicy = computed(
  () => qualityPolicyFor(settingsDraft.value.defaultWorkflow),
);
const bgeSetupState = computed<BgeModelSetupState>(() => {
  const status = client.translationRagStatus.value;
  const uiStatus: BgeModelSetupState['status'] = status.state;
  return {
    status: uiStatus,
    ...(status.progress !== undefined ? { progress: status.progress } : {}),
    ...(status.downloadedBytes !== undefined ? { downloadedBytes: status.downloadedBytes } : {}),
    ...(status.totalBytes !== undefined ? { totalBytes: status.totalBytes } : {}),
    ...(status.availableDiskBytes !== undefined
      ? { diskAvailableBytes: status.availableDiskBytes }
      : {}),
    ...(status.requiredDiskBytes !== undefined
      ? { diskRequiredBytes: status.requiredDiskBytes }
      : {}),
    ...(status.fingerprint ? { fingerprint: status.fingerprint } : {}),
    ...(status.modelPath ? { modelPath: status.modelPath } : {}),
    ...(status.error ? { error: status.error, errorCode: 'unknown' as const } : {}),
    disabled: client.translationRagBusy.value,
    canRebuild: Boolean(
      selectedProject.value?.initialization?.manifest.bookId
      && status.serviceStatus === 'ready'
      && status.denseReady,
    ),
  };
});

const visibleCorrectionError = computed(() => correctionError.value
  ?? (selectedProject.value?.runtimeError?.phase === 'instruction'
    ? selectedProject.value.runtimeError.message
    : null));

const diagnosticSessionId = computed(() =>
  selectedEntry.value?.sessionId
  || client.activeSessionId.value
  || projectSessions.value[0]?.sessionId
  || '',
);

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function toViewWorkflow(workflow: WorkflowOptions): TranslationWorkflowOptions {
  return {
    firstTranslation: true,
    firstReview: true,
    secondTranslation: workflow.secondTranslation,
    secondReview: workflow.secondReview,
    consistencyReview: workflow.consistencyReview,
  };
}

function readyOutputPath(project: TranslationProject): string | undefined {
  return verifiedTranslationOutputPath(project);
}

function toViewProject(entry: ProjectSession): ViewProject {
  const { project } = entry;
  return {
    id: entry.sessionId,
    title: project.name,
    sourcePath: project.source.sourcePath,
    chapterPattern: project.source.chapterPattern ?? '',
    workspacePath: project.paths.projectRoot,
    agentCount: project.maxAgents,
    workflow: toViewWorkflow(project.workflow),
    executionPolicy: normalizeExecutionPolicy({
      softBudgetMicros: project.executionPolicy.softBudgetMicros ?? 20_000_000,
      hardBudgetMicros: project.executionPolicy.hardBudgetMicros ?? 30_000_000,
      maxRetries: project.executionPolicy.maxRetries,
      maxConcurrency: project.executionPolicy.maxConcurrency,
    }, project.maxAgents),
    status: project.status === 'ready' ? 'draft' : project.status,
    completedChapters: project.chapters.filter((chapter) => chapter.status === 'completed').length,
    totalChapters: project.chapters.length,
    updatedAt: formatDate(project.updatedAt),
    createdAt: formatDate(project.createdAt),
    outputPath: readyOutputPath(project),
    issueCount: project.issues.filter((issue) => issue.status === 'open' || issue.status === 'repair_pending').length,
  };
}

const projects = computed<ViewProject[]>(() => projectSessions.value.map(toViewProject));
const selectedViewProject = computed<ViewProject | undefined>(() => {
  const entry = selectedEntry.value;
  return entry ? toViewProject(entry) : undefined;
});

function stageIdFor(state: StageRunState): TranslationStageId {
  const { kind, pass } = state.definition;
  switch (kind) {
    case 'parse_epub':
    case 'parse_txt': return 'parse';
    case 'analyze_book': return 'preAnalysis';
    case 'smoke_test': return 'smokeTest';
    case 'translate': return pass === 2 ? 'secondTranslation' : 'firstTranslation';
    case 'review': return pass === 2 ? 'secondReview' : 'firstReview';
    case 'consistency_review':
    case 'consistency_repair': return 'consistencyReview';
    case 'final_audit': return 'fullAudit';
    case 'export_epub':
    case 'export_txt': return 'epubExport';
    case 'repair': return pass === 2 ? 'secondReview' : 'firstReview';
  }
}

function stageStatusFor(state: StageRunState): TranslationStageStatus {
  switch (state.status) {
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'failed':
    case 'blocked': return 'failed';
    case 'stale':
    case 'pending': return 'pending';
  }
}

const STAGE_STATUS_PRIORITY: Record<TranslationStageStatus, number> = {
  skipped: 0,
  pending: 1,
  completed: 2,
  running: 3,
  failed: 4,
};

function toViewStages(project: TranslationProject | null): TranslationStage[] {
  if (!project) return [];
  const stages = new Map<TranslationStageId, TranslationStage>();
  for (const state of project.stages) {
    const id = stageIdFor(state);
    const next: TranslationStage = {
      id,
      status: stageStatusFor(state),
      detail: state.lastError,
    };
    const current = stages.get(id);
    if (!current || STAGE_STATUS_PRIORITY[next.status] >= STAGE_STATUS_PRIORITY[current.status]) {
      stages.set(id, next);
    }
  }
  return [...stages.values()];
}

function chapterStatus(chapter: ChapterProgress): TranslationChapter['status'] {
  switch (chapter.status) {
    case 'analyzing':
    case 'translating': return 'translating';
    case 'reviewing':
    case 'repairing': return 'reviewing';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'pending': return 'pending';
  }
}

function toViewChapter(chapter: ChapterProgress): TranslationChapter {
  const denominator = Math.max(1, chapter.paragraphCount);
  return {
    id: chapter.chapterId,
    title: chapter.title,
    status: chapterStatus(chapter),
    progress: Math.min(100, Math.round(chapter.completedParagraphs / denominator * 100)),
    issueCount: chapter.openIssueCount,
  };
}

function agentStatus(task: AppTask): TranslationAgent['status'] {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'failed' || task.status === 'cancelled') return 'failed';
  if (task.subagentPhase === 'queued') return 'idle';
  return 'working';
}

const activeStageId = computed<TranslationStageId | undefined>(() => {
  const project = selectedProject.value;
  if (!project?.activeStageId) return undefined;
  const state = project.stages.find((stage) => stage.definition.id === project.activeStageId);
  return state ? stageIdFor(state) : undefined;
});

const agents = computed<TranslationAgent[]>(() => client.activeAppTasks.value
  .filter((task) => task.kind === 'subagent')
  .toSorted((a, b) => (a.swarmIndex ?? Number.MAX_SAFE_INTEGER) - (b.swarmIndex ?? Number.MAX_SAFE_INTEGER))
  .map((task, index) => ({
    id: task.id,
    name: task.subagentType || task.description || t('translation.run.agentName', { number: index + 1 }),
    status: agentStatus(task),
    stageId: activeStageId.value,
    chapterName: task.description,
    progress: task.status === 'completed' ? 100 : undefined,
  })));

const stages = computed(() => toViewStages(selectedProject.value));
const chapters = computed(() => selectedProject.value?.chapters.map(toViewChapter) ?? []);

function severityFor(issue: TranslationIssue): ViewIssue['severity'] {
  if (issue.severity === 'critical' || issue.severity === 'high') return 'error';
  if (issue.severity === 'major') return 'warning';
  return 'info';
}

const issues = computed<ViewIssue[]>(() => projectSessions.value.flatMap((entry) => {
  const titleByChapter = new Map(
    entry.project.chapters.map((chapter) => [chapter.chapterId, chapter.title]),
  );
  const ledgerIssues = entry.project.issues
    .filter((issue) => issue.status === 'open' || issue.status === 'repair_pending')
    .map((issue) => {
      const state = entry.project.stages.find((stage) => stage.definition.id === issue.stageId);
      return {
        id: issue.issueId,
        projectId: entry.sessionId,
        projectTitle: entry.project.name,
        severity: severityFor(issue),
        message: issue.explanation,
        chapterName: issue.chapterId ? titleByChapter.get(issue.chapterId) : undefined,
        stageId: state ? stageIdFor(state) : undefined,
        createdAt: formatDate(issue.createdAt),
      };
    });
  const stageIssues: ViewIssue[] = entry.project.stages
    .filter((state) => (
      state.status === 'failed'
      || (state.status === 'blocked' && entry.project.status !== 'paused')
    ))
    .map((state) => {
      const stageId = stageIdFor(state);
      return {
        id: `${entry.sessionId}:${state.definition.id}:${state.attempt}`,
        projectId: entry.sessionId,
        projectTitle: entry.project.name,
        severity: state.status === 'failed' ? 'error' : 'warning',
        message: `${t(`translation.stages.${stageId}`)}: ${state.lastError ?? t('translation.stageStatus.failed')}`,
        stageId,
        createdAt: formatDate(state.completedAt ?? state.startedAt ?? entry.project.updatedAt),
      };
    });
  return [...ledgerIssues, ...stageIssues];
}));

const outputs = computed<TranslationOutput[]>(() => projectSessions.value.flatMap((entry) => {
  const path = readyOutputPath(entry.project);
  if (!path) return [];
  const artifact = entry.project.artifacts.find(
    (item) => (item.type === 'final_epub' || item.type === 'final_txt') && item.status === 'ready',
  );
  const result: TranslationOutput[] = [{
    id: artifact?.artifactId ?? `${entry.sessionId}:final-output`,
    projectId: entry.sessionId,
    projectTitle: entry.project.name,
    sourcePath: entry.project.source.sourcePath,
    outputPath: path,
    exportedAt: formatDate(artifact?.createdAt ?? entry.project.updatedAt),
  }];
  if (entry.project.reportReceipt) {
    result.push({
      id: `${entry.sessionId}:technical-report`,
      projectId: entry.sessionId,
      projectTitle: `${entry.project.name} · ${t('translation.outputs.technicalReport')}`,
      sourcePath: entry.project.source.sourcePath,
      outputPath: entry.project.reportReceipt.path,
      exportedAt: formatDate(entry.project.reportReceipt.generatedAt),
    });
  }
  return result;
}));

const openIssueCount = computed(() => issues.value.length);
const anyProjectRunning = computed(() => projectSessions.value.some(
  ({ project }) => project.status === 'running',
));

function openCreateDialog(): void {
  const agentCount = settingsDraft.value.defaultAgentCount;
  createDraft.value = {
    ...newProjectDraft(),
    agentCount,
    workflow: { ...settingsDraft.value.defaultWorkflow },
    executionPolicy: normalizeExecutionPolicy(settingsDraft.value.executionPolicy, agentCount),
  };
  selectedSourceFile.value = null;
  createError.value = undefined;
  showCreateProject.value = true;
  void client.loadModels();
}

function onSourceFile(file: File): void {
  selectedSourceFile.value = file;
  createError.value = undefined;
}

function onSourcePath(): void {
  // The advanced path and a browser File are mutually exclusive inputs. Once
  // the user edits the path, never upload a previously selected EPUB by
  // accident just because its display name is still present in the draft.
  selectedSourceFile.value = null;
  createError.value = undefined;
}

function workflowForRunner(workflow: TranslationWorkflowOptions): WorkflowOptions {
  return {
    secondTranslation: workflow.secondTranslation,
    secondReview: workflow.secondReview,
    consistencyReview: workflow.consistencyReview,
  };
}

async function createProject(): Promise<void> {
  if (createSaving.value) return;
  createSaving.value = true;
  createError.value = undefined;
  try {
    const workspace = client.workspacesView.value.find(
      (item) => item.root === createDraft.value.workspacePath,
    );
    const selectedModel = modelOptions.value.some(
      (option) => option.value === settingsDraft.value.defaultModel,
    )
      ? settingsDraft.value.defaultModel
      : modelOptions.value[0]?.value;
    const qualityPolicy = createProjectQualityPolicy.value;
    const requestedWorkflow = workflowForRunner(createDraft.value.workflow);
    const workflow = qualityPolicy?.effectiveWorkflow ?? {
      ...requestedWorkflow,
      // Unknown/unreachable probes are never allowed to weaken the quality gate.
      secondReview: true,
    };
    if (workflow.secondReview && !createDraft.value.workflow.secondReview) {
      createDraft.value = {
        ...createDraft.value,
        workflow: { ...createDraft.value.workflow, secondReview: true },
      };
    }
    const project = await runner.createTranslationProject({
      name: createDraft.value.title.trim() || createDraft.value.sourcePath.replace(/\.(epub|txt)$/i, ''),
      sourceFile: selectedSourceFile.value ?? undefined,
      sourcePath: selectedSourceFile.value ? undefined : createDraft.value.sourcePath.trim(),
      chapterPattern: createDraft.value.chapterPattern?.trim() || undefined,
      projectRoot: createDraft.value.workspacePath,
      workspaceId: workspace?.id,
      model: selectedModel || undefined,
      workflow,
      maxAgents: createDraft.value.agentCount,
      executionPolicy: normalizeExecutionPolicy(
        createDraft.value.executionPolicy,
        createDraft.value.agentCount,
      ),
    });
    const entry = runner.translationProjectSessions.value.find(
      (candidate) => candidate.project.projectId === project.projectId,
    );
    const sessionId = entry?.sessionId ?? client.activeSessionId.value;
    showCreateProject.value = false;
    if (sessionId) {
      selectedSessionId.value = sessionId;
      await runner.selectTranslationProject(sessionId);
      activeView.value = 'run';
    } else {
      activeView.value = 'projects';
    }
  } catch (error) {
    createError.value = error instanceof Error ? error.message : t('translation.create.failed');
  } finally {
    createSaving.value = false;
  }
}

function entryForViewProject(project: ViewProject): ProjectSession | undefined {
  return projectSessions.value.find((entry) => entry.sessionId === project.id);
}

function showDetails(project: ViewProject): void {
  selectedSessionId.value = project.id;
  showProjectDetails.value = true;
}

async function continueProject(project: ViewProject): Promise<void> {
  const entry = entryForViewProject(project);
  if (!entry) return;
  showProjectDetails.value = false;
  selectedSessionId.value = entry.sessionId;
  await runner.selectTranslationProject(entry.sessionId);
  activeView.value = 'run';
  if (entry.project.status === 'draft' || entry.project.status === 'ready') {
    await runner.startTranslationRun(entry.sessionId);
  } else if (entry.project.status !== 'running' && entry.project.status !== 'completed') {
    await runner.resumeTranslationRun(entry.sessionId);
  }
}

async function deleteProject(project: ViewProject): Promise<void> {
  const entry = entryForViewProject(project);
  if (!entry) return;
  const deleted = await confirm({
    title: t('translation.projects.delete'),
    message: t('translation.projects.deleteConfirm', { title: project.title }),
    variant: 'danger',
    action: () => runner.deleteTranslationProject(entry.sessionId),
  });
  if (!deleted) return;
  showProjectDetails.value = false;
  if (selectedSessionId.value === entry.sessionId) {
    selectedSessionId.value = null;
    activeView.value = 'projects';
  }
}

async function selectProject(sessionId: string, view: TranslationView = 'run'): Promise<void> {
  const entry = projectSessions.value.find((candidate) => candidate.sessionId === sessionId);
  if (!entry) return;
  selectedSessionId.value = sessionId;
  await runner.selectTranslationProject(sessionId);
  activeView.value = view;
}

async function openProjectOutput(project: ViewProject): Promise<void> {
  await selectProject(project.id, 'outputs');
}

async function togglePause(): Promise<void> {
  const entry = selectedEntry.value;
  if (!entry) return;
  if (entry.project.status === 'running') {
    await runner.pauseTranslationRun(entry.sessionId);
  } else {
    await runner.resumeTranslationRun(entry.sessionId);
  }
}

async function sendCorrection(): Promise<void> {
  const entry = selectedEntry.value;
  const text = correction.value.trim();
  if (!entry || !text || correctionSubmitting.value) return;
  correctionSubmitting.value = true;
  correctionError.value = null;
  try {
    await runner.applyUserOverride(entry.sessionId, { text });
    correction.value = '';
  } catch (error) {
    correctionError.value = error instanceof Error
      ? error.message
      : (t('translation.create.failed') || 'Correction was not recorded.');
  } finally {
    correctionSubmitting.value = false;
  }
}

async function openOutput(output: TranslationOutput): Promise<void> {
  await selectProject(output.projectId, 'outputs');
  await client.openWorkspaceFile(projectRelativePath(output));
}

async function revealOutput(output: TranslationOutput): Promise<void> {
  await selectProject(output.projectId, 'outputs');
  await client.revealWorkspaceFile(projectRelativePath(output));
}

function projectRelativePath(output: TranslationOutput): string {
  const entry = projectSessions.value.find((candidate) => candidate.sessionId === output.projectId);
  if (!entry) return output.outputPath.replace(/\\/g, '/');
  const root = entry.project.paths.projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = output.outputPath.replace(/\\/g, '/');
  const prefix = `${root}/`;
  const windowsPath = /^[A-Za-z]:\//.test(root);
  const matchesRoot = windowsPath
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix);
  return matchesRoot ? target.slice(prefix.length) : target;
}

async function chooseWorkspace(): Promise<void> {
  workspacePickerError.value = null;
  showWorkspacePicker.value = true;
}

async function addWorkspace(root: string): Promise<void> {
  workspacePickerError.value = null;
  const added = await client.addWorkspaceByPath(root);
  if (!added) {
    workspacePickerError.value = t('workspace.addFailed');
    return;
  }
  createDraft.value = { ...createDraft.value, workspacePath: root };
  showWorkspacePicker.value = false;
}

function closeWorkspacePicker(): void {
  workspacePickerError.value = null;
  showWorkspacePicker.value = false;
}

function runBgeAction(action: () => Promise<unknown>): void {
  void action().catch(() => undefined);
}

function detectBge(): void {
  runBgeAction(() => client.detectTranslationRag());
}

function downloadBge(): void {
  runBgeAction(() => client.downloadTranslationRag(
    settingsDraft.value.bge.source,
    settingsDraft.value.bge.cpuFallback,
  ));
}

function cancelBgeDownload(): void {
  runBgeAction(() => client.cancelTranslationRagDownload());
}

function verifyBge(): void {
  runBgeAction(() => client.verifyTranslationRag(settingsDraft.value.bge.cpuFallback));
}

function rebuildBgeIndex(): void {
  runBgeAction(() => client.rebuildTranslationRagIndex());
}

function openBgeSettings(): void {
  showCreateProject.value = false;
  activeView.value = 'settings';
  detectBge();
}

async function saveSettings(): Promise<void> {
  settingsSaving.value = true;
  try {
    const defaultAgentCount = Math.min(
      128,
      Math.max(2, Math.round(settingsDraft.value.defaultAgentCount)),
    );
    const normalized: TranslationSettings = {
      ...settingsDraft.value,
      defaultModel: modelOptions.value.some(
        (option) => option.value === settingsDraft.value.defaultModel,
      )
        ? settingsDraft.value.defaultModel
        : (modelOptions.value[0]?.value ?? ''),
      defaultAgentCount,
      defaultWorkflow: {
        ...settingsDraft.value.defaultWorkflow,
        firstTranslation: true,
        firstReview: true,
        secondReview: settingsQualityPolicy.value?.effectiveWorkflow.secondReview ?? true,
      },
      bge: {
        source: settingsDraft.value.bge.source === 'official' ? 'official' : 'mirror',
        cpuFallback: settingsDraft.value.bge.cpuFallback !== false,
      },
      executionPolicy: normalizeExecutionPolicy(
        settingsDraft.value.executionPolicy,
        defaultAgentCount,
      ),
    };
    settingsDraft.value = normalized;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    const patch: Partial<AppConfig> = {
      defaultModel: normalized.defaultModel || undefined,
      tools: { enabled: [...REQUIRED_TOOLS], disabled: [] },
    };
    await client.updateConfig(patch);
  } finally {
    settingsSaving.value = false;
  }
}

async function exportDiagnostics(): Promise<void> {
  const sessionId = diagnosticSessionId.value;
  if (!sessionId || diagnosticsExporting.value) return;
  diagnosticsExporting.value = true;
  try {
    await client.exportSession(sessionId);
  } finally {
    diagnosticsExporting.value = false;
  }
}

async function openProviders(): Promise<void> {
  providersLoading.value = true;
  providersUnavailable.value = false;
  showProviders.value = true;
  try {
    await client.loadProviders();
  } catch {
    providersUnavailable.value = true;
  } finally {
    providersLoading.value = false;
  }
}

async function addProvider(input: {
  id: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models: Array<{ model: string; maxContextSize?: number }>;
}): Promise<void> {
  await client.addProvider(input);
}

/** Called when the ConfigureProviderDialog completes: persist the provider,
 *  reload providers + models, then refresh the readiness probe so the auth
 *  gate lifts once the daemon reports a configured provider. */
async function onProviderConfigured(config: {
  id: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  models: Array<{ model: string; maxContextSize?: number }>;
}): Promise<void> {
  await client.addProvider({
    id: config.id,
    type: config.type,
    apiKey: config.apiKey || undefined,
    baseUrl: config.baseUrl || undefined,
    defaultModel: config.defaultModel || undefined,
    models: config.models,
  });
  await client.checkAuth();
  await client.load();
}

async function refreshProvider(id: string): Promise<void> {
  await client.refreshProvider(id);
}

/** The provider being edited in the model/context dialog, with its models. */
const editProvider = computed(() => {
  const id = editProviderId.value;
  if (!id) return null;
  const provider = client.providers.value.find((p) => p.id === id);
  if (!provider) return null;
  const models = client.models.value.filter((m) => m.provider === id);
  return { provider, models };
});

async function saveEditedProvider(payload: {
  newId?: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models: Array<{ model: string; maxContextSize: number }>;
}): Promise<void> {
  const id = editProviderId.value;
  if (!id) return;
  await client.replaceProvider(id, payload);
  editProviderId.value = null;
}

async function deleteProvider(id: string): Promise<void> {
  await confirm({
    title: t('providers.delete'),
    message: t('providers.confirmDelete'),
    variant: 'danger',
    action: () => client.deleteProvider(id),
  });
}

async function navigate(view: TranslationView): Promise<void> {
  if (view === 'run') {
    const selected = selectedSessionId.value
      ? projectSessions.value.find((entry) => entry.sessionId === selectedSessionId.value)
      : undefined;
    const preferred = selected
      ?? projectSessions.value.find(({ project }) => project.status === 'running')
      ?? projectSessions.value[0];
    if (preferred) await selectProject(preferred.sessionId, 'run');
    else activeView.value = 'run';
    return;
  }
  activeView.value = view;
}

const colorSchemeOptions = computed(() => [
  { value: 'light', label: t('translation.appearance.light') },
  { value: 'dark', label: t('translation.appearance.dark') },
  { value: 'system', label: t('translation.appearance.system') },
]);
const dayThemeOptions = computed(() => [
  { value: 'pure-white', label: t('translation.appearance.pureWhite') },
  { value: 'maple', label: t('translation.appearance.maple') },
]);
const nightThemeOptions = computed(() => [
  { value: 'ink-black', label: t('translation.appearance.inkBlack') },
  { value: 'ink-blue', label: t('translation.appearance.inkBlue') },
]);
const fontOptions = computed(() => [
  { value: 'wenkai', label: t('translation.appearance.wenkai') },
  { value: 'system', label: t('translation.appearance.systemFont') },
]);
function setColorScheme(value: string): void {
  appearance.setColorScheme(value as ColorScheme);
}

function setDayTheme(value: string): void {
  appearance.setDayTheme(value as DayTheme);
}

function setNightTheme(value: string): void {
  appearance.setNightTheme(value as NightTheme);
}

function setUiFont(value: string): void {
  appearance.setUiFont(value as UiFont);
}
</script>

<template>
  <div class="translation-app">
    <ServerAuthDialog v-if="showServerAuth && !showLocaleGate" />

    <LanguageSelectionDialog v-if="showLocaleGate" />

    <section v-else-if="showAuthGate" class="translation-auth">
      <span class="translation-auth__mark" aria-hidden="true">
        <Icon name="sliders" size="lg" />
      </span>
      <div class="translation-auth__copy">
        <h1>{{ t('translation.authGate.title') }}</h1>
        <p>{{ t('translation.authGate.description') }}</p>
      </div>
      <Button @click="showConfigureProvider = true">
        <Icon name="sliders" size="md" />
        {{ t('translation.authGate.action') }}
      </Button>
    </section>

    <TranslationShell
      v-else-if="showMainUi"
      :active-view="activeView"
      :project-count="projects.length"
      :issue-count="openIssueCount"
      :running="anyProjectRunning"
      @navigate="navigate"
      @create-project="openCreateDialog"
      @exit="requestExit"
    >
      <TranslationProjectsView
        v-if="activeView === 'projects'"
        :projects="projects"
        :selected-project-id="selectedSessionId ?? undefined"
        :loading="!client.initialized.value"
        @create="openCreateDialog"
        @details="showDetails"
        @delete="deleteProject"
        @continue="continueProject"
        @open-output="openProjectOutput"
      />

      <div
        v-else-if="activeView === 'run' && selectedViewProject"
        class="translation-run-surface"
      >
        <Banner
          v-if="selectedProject?.runtimeError"
          variant="danger"
          class="translation-run-surface__error"
        >
          {{ selectedProject.runtimeError.message }}
        </Banner>
        <TranslationRunWorkbench
          :project="selectedViewProject"
          :stages="stages"
          :agents="agents"
          :chapters="chapters"
          :paused="selectedProject?.status !== 'running'"
          @toggle-pause="togglePause"
          @open-issue-log="activeView = 'issues'"
          @open-output="activeView = 'outputs'"
        />
      </div>

      <EmptyState
        v-else-if="activeView === 'run'"
        class="translation-empty"
        :title="t('translation.run.emptyTitle')"
        :hint="t('translation.run.emptyHint')"
      >
        <template #icon><Icon name="play" size="lg" /></template>
        <Button size="sm" @click="activeView = 'projects'">
          {{ t('translation.run.chooseProject') }}
        </Button>
      </EmptyState>

      <TranslationIssuesView
        v-else-if="activeView === 'issues'"
        :issues="issues"
        @open-project="selectProject($event, 'run')"
      />

      <div v-else-if="activeView === 'agent-console'" class="translation-agent-console">
        <Banner v-if="visibleCorrectionError" variant="danger" class="translation-agent-console__error">
          {{ visibleCorrectionError }}
        </Banner>
        <AgentConsole
          :messages="selectedEntry ? client.messagesForSession(selectedEntry.sessionId) : []"
          :running="selectedProject?.status === 'running'"
          :command-value="correction"
          :busy="correctionSubmitting"
          @update:command-value="correction = $event; correctionError = null"
          @send="sendCorrection"
        />
      </div>

      <TranslationOutputsView
        v-else-if="activeView === 'outputs'"
        :outputs="outputs"
        @open="openOutput"
        @reveal="revealOutput"
      />

      <TranslationSettingsView
        v-else-if="activeView === 'settings'"
        v-model="settingsDraft"
        :models="modelOptions"
        :saving="settingsSaving"
        :bge-state="bgeSetupState"
        :quality-policy="settingsQualityPolicy"
        @manage-models="openProviders"
        @save="saveSettings"
        @bge-detect="detectBge"
        @bge-download="downloadBge"
        @bge-cancel="cancelBgeDownload"
        @bge-retry="downloadBge"
        @bge-verify="verifyBge"
        @bge-rebuild="rebuildBgeIndex"
      >
        <template #appearance>
          <section class="translation-appearance">
            <header>
              <h2>{{ t('translation.appearance.title') }}</h2>
              <p>{{ t('translation.appearance.hint') }}</p>
            </header>
            <div class="translation-appearance__grid">
              <Field :label="t('translation.appearance.mode')">
                <SegmentedControl
                  :model-value="appearance.colorScheme.value"
                  :options="colorSchemeOptions"
                  @update:model-value="setColorScheme"
                />
              </Field>
              <Field :label="t('translation.appearance.dayTheme')">
                <SegmentedControl
                  :model-value="appearance.dayTheme.value"
                  :options="dayThemeOptions"
                  @update:model-value="setDayTheme"
                />
              </Field>
              <Field :label="t('translation.appearance.nightTheme')">
                <SegmentedControl
                  :model-value="appearance.nightTheme.value"
                  :options="nightThemeOptions"
                  @update:model-value="setNightTheme"
                />
              </Field>
              <Field :label="t('translation.appearance.font')">
                <SegmentedControl
                  :model-value="appearance.uiFont.value"
                  :options="fontOptions"
                  @update:model-value="setUiFont"
                />
              </Field>
            </div>
          </section>
        </template>
        <template #advanced>
          <section class="translation-advanced">
            <h2>{{ t('translation.settings.promptTitle') }}</h2>
            <p>{{ t('translation.settings.promptHint') }}</p>
            <h2>{{ t('translation.settings.diagnosticsTitle') }}</h2>
            <p>{{ t('translation.settings.diagnosticsHint') }}</p>
            <Button
              variant="secondary"
              :loading="diagnosticsExporting"
              :disabled="!diagnosticSessionId"
              @click="exportDiagnostics"
            >
              {{ t('header.exportSession') }}
            </Button>
          </section>
        </template>
      </TranslationSettingsView>
    </TranslationShell>

    <CreateTranslationProjectDialog
      v-if="showMainUi"
      v-model:open="showCreateProject"
      v-model="createDraft"
      :saving="createSaving"
      :error="createError"
      :quality-policy="createProjectQualityPolicy"
      @source-file="onSourceFile"
      @source-path="onSourcePath"
      @choose-workspace="chooseWorkspace"
      @setup-bge="openBgeSettings"
      @create="createProject"
    />

    <ProjectDetailsDialog
      v-if="showMainUi"
      v-model:open="showProjectDetails"
      :project="selectedViewProject"
      @continue="continueProject"
      @open-output="openProjectOutput"
      @delete="deleteProject"
    />

    <AddWorkspaceDialog
      v-if="showMainUi && showWorkspacePicker"
      :browse-fs="client.browseFs"
      :get-fs-home="client.getFsHome"
      :default-path="createDraft.workspacePath || defaultWorkspacePath()"
      :error="workspacePickerError"
      @add="addWorkspace"
      @close="closeWorkspacePicker"
    />

    <ProviderManager
      v-if="showMainUi && showProviders"
      :providers="client.providers.value"
      :loading="providersLoading"
      :unavailable="providersUnavailable"
      @add="addProvider"
      @refresh="refreshProvider"
      @delete="deleteProvider"
      @edit-models="editProviderId = $event"
      @close="showProviders = false"
    />

    <EditProviderModelsDialog
      v-if="showMainUi && editProvider"
      :open="true"
      :provider="editProvider.provider"
      :models="editProvider.models"
      @save="saveEditedProvider"
      @close="editProviderId = null"
    />

    <ConfigureProviderDialog
      v-if="!showLocaleGate && showConfigureProvider"
      :open="showConfigureProvider"
      @update:open="showConfigureProvider = $event"
      @success="onProviderConfigured"
      @close="showConfigureProvider = false"
    />

    <ExitAppDialog
      v-if="showMainUi && showExitApp"
      :open="showExitApp"
      @confirm="onExitConfirmed"
      @close="showExitApp = false"
    />

    <Transition name="translation-loading-fade">
      <GlobalLoading
        v-if="!showLocaleGate && !client.initialized.value"
        :issue="client.connectIssue.value"
      />
    </Transition>
    <WarningToasts :warnings="client.warnings.value" @dismiss="client.dismissWarning" />
    <ConfirmDialogHost />
  </div>
</template>

<style scoped>
.translation-app {
  position: fixed;
  inset: 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-ui);
}

.translation-auth {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-6);
  text-align: center;
}

.translation-auth__mark {
  display: inline-grid;
  width: calc(var(--space-8) * 2);
  height: calc(var(--space-8) * 2);
  place-items: center;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
  color: var(--color-accent);
}

.translation-auth__copy {
  max-width: var(--p-content-max);
}

.translation-auth__copy h1,
.translation-appearance h2,
.translation-advanced h2 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-xl);
  font-weight: var(--weight-medium);
}

.translation-auth__copy p,
.translation-appearance p,
.translation-advanced p {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}

.translation-empty {
  height: 100%;
}

.translation-run-surface {
  position: relative;
  height: 100%;
  min-height: 0;
}

.translation-run-surface__error {
  position: absolute;
  z-index: 1;
  top: var(--space-3);
  right: var(--space-4);
  left: var(--space-4);
}

.translation-agent-console {
  position: relative;
  height: 100%;
  min-height: 0;
}

.translation-agent-console__error {
  position: absolute;
  z-index: 1;
  top: var(--space-3);
  right: var(--space-4);
  left: var(--space-4);
}

.translation-appearance {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-5);
  border-top: 1px solid var(--color-line);
}

.translation-appearance__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.translation-advanced {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.translation-loading-fade-leave-active {
  transition: opacity var(--duration-slow) var(--ease-out);
}

.translation-loading-fade-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .translation-appearance__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
