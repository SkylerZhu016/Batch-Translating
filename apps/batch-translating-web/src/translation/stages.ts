import type {
  StageDefinition,
  StageRunState,
  StageTaskCounts,
  TranslationSourceKind,
  TranslationStageKind,
  WorkflowOptions,
} from './types';

export const MIN_SWARM_AGENTS = 2;
export const MAX_SWARM_AGENTS = 128;

export const DEFAULT_WORKFLOW_OPTIONS: Readonly<WorkflowOptions> = Object.freeze({
  secondTranslation: false,
  secondReview: false,
  consistencyReview: false,
});

const EMPTY_TASK_COUNTS: Readonly<StageTaskCounts> = Object.freeze({
  total: 0,
  pending: 0,
  running: 0,
  failed: 0,
  completed: 0,
});

interface StageSeed {
  id: string;
  kind: TranslationStageKind;
  label: string;
  required: boolean;
  execution: StageDefinition['execution'];
  pass?: 1 | 2;
}

function seed(
  id: string,
  kind: TranslationStageKind,
  label: string,
  execution: StageDefinition['execution'],
  required: boolean,
  pass?: 1 | 2,
): StageSeed {
  return { id, kind, label, execution, required, pass };
}

/**
 * Builds the complete workflow in program-owned order. A model never receives
 * permission to add, remove, repeat, skip, or reorder these stages. The
 * deterministic parse/export bookends depend on the source kind; everything
 * between them is identical for EPUB and TXT books.
 */
export function buildStagePlan(
  options: WorkflowOptions,
  kind: TranslationSourceKind = 'epub',
): StageDefinition[] {
  const stages: StageSeed[] = [
    kind === 'txt'
      ? seed('parse-txt', 'parse_txt', '解析 TXT', 'deterministic', true)
      : seed('parse-epub', 'parse_epub', '解析 EPUB', 'deterministic', true),
    seed('analyze-book', 'analyze_book', '全书预分析', 'agent_swarm', true),
    seed('smoke-test', 'smoke_test', '冒烟测试', 'agent_swarm', true),
    seed('translation-1', 'translate', '第一轮翻译', 'agent_swarm', true, 1),
    seed('review-1', 'review', '第一轮独立审核', 'agent_swarm', true, 1),
    seed('repair-1', 'repair', '第一轮受约束修复', 'agent_swarm', true, 1),
  ];

  // Optional pass two always starts from the reviewed-and-repaired pass-one
  // baseline. The two checkboxes remain independent: review two reviews pass
  // two when it exists, otherwise it reviews the repaired pass-one baseline.
  if (options.secondTranslation) {
    stages.push(seed('translation-2', 'translate', '第二轮翻译', 'agent_swarm', true, 2));
  }

  if (options.secondReview) {
    stages.push(
      seed('review-2', 'review', '第二轮独立审核', 'agent_swarm', true, 2),
      seed('repair-2', 'repair', '第二轮受约束修复', 'agent_swarm', true, 2),
    );
  }

  if (options.consistencyReview) {
    stages.push(
      seed(
        'consistency-review',
        'consistency_review',
        '全书一致性审核',
        'agent_swarm',
        true,
      ),
      seed(
        'consistency-repair',
        'consistency_repair',
        '一致性问题修复',
        'agent_swarm',
        true,
      ),
    );
  }

  stages.push(
    seed('final-audit', 'final_audit', '全书自动验收', 'deterministic', true),
    kind === 'txt'
      ? seed('export-txt', 'export_txt', 'TXT 导出', 'deterministic', true)
      : seed('export-epub', 'export_epub', 'EPUB 导出', 'deterministic', true),
  );

  return stages.map((stage, index) => ({
    ...stage,
    dependsOn: index === 0 ? [] : [stages[index - 1]!.id],
  }));
}

export function createStageRunStates(
  options: WorkflowOptions,
  kind: TranslationSourceKind = 'epub',
): StageRunState[] {
  return buildStagePlan(options, kind).map((definition) => ({
    definition,
    status: 'pending',
    attempt: 0,
    taskCounts: { ...EMPTY_TASK_COUNTS },
  }));
}

export function normalizeMaxAgents(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_SWARM_AGENTS;
  }
  return Math.min(MAX_SWARM_AGENTS, Math.max(MIN_SWARM_AGENTS, Math.trunc(value)));
}

export function isValidMaxAgents(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_SWARM_AGENTS
    && value <= MAX_SWARM_AGENTS
  );
}

export function stageIndexOf(plan: readonly StageDefinition[], stageId: string): number {
  return plan.findIndex((stage) => stage.id === stageId);
}

export function assertProtectedMinimum(plan: readonly StageDefinition[]): boolean {
  const firstTranslation = plan.findIndex(
    (stage) => stage.kind === 'translate' && stage.pass === 1,
  );
  const firstReview = plan.findIndex(
    (stage) => stage.kind === 'review' && stage.pass === 1,
  );
  const firstRepair = plan.findIndex(
    (stage) => stage.kind === 'repair' && stage.pass === 1,
  );
  return (
    firstTranslation >= 0
    && firstReview > firstTranslation
    && firstRepair > firstReview
    && plan[firstTranslation]?.required === true
    && plan[firstReview]?.required === true
    && plan[firstRepair]?.required === true
  );
}

export function planFingerprint(plan: readonly StageDefinition[]): string {
  const canonical = plan
    .map((stage) => [
      stage.id,
      stage.kind,
      stage.pass ?? 0,
      stage.required ? 1 : 0,
      stage.execution,
      stage.dependsOn.join(','),
    ].join(':'))
    .join('|');

  // FNV-1a is used only as a stable change detector, not as a security hash.
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `plan-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
