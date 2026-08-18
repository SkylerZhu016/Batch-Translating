import type { WorkflowOptions } from './types';

/**
 * This module is deliberately declarative. It gives the native Translation
 * Coordinator hard quality bounds and safe context references, but does not
 * prescribe a fixed stage runner or pretend that a capability exists.
 */
export const TRANSLATION_QUALITY_POLICY_VERSION = 'quality-policy-v1' as const;
export const BGE_M3_MODEL_ID = 'BAAI/bge-m3' as const;
export const PRIMARY_TRANSLATION_MODEL = 'DeepSeek V4 Flash: Go' as const;
export const FALLBACK_TRANSLATION_MODEL = 'Qwen 3.7 Plus: Go' as const;

export type TranslationQualityPolicyVersion = typeof TRANSLATION_QUALITY_POLICY_VERSION;
export type TranslationQualityMode = 'bge-rag' | 'adjacent-chapter-fallback';
export type CapabilityStatus = 'ready' | 'missing' | 'unhealthy' | 'unknown';
export type BgeM3DiscoverySource = 'environment' | 'local-cache' | 'managed-download' | 'unknown';

export interface LocalizedPolicyText {
  zhCN: string;
  en: string;
}

/** A verified runtime probe. UI configuration alone must never set status=ready. */
export interface BgeM3CapabilityProbe {
  status: CapabilityStatus;
  modelId?: string;
  fingerprint?: string;
  source?: BgeM3DiscoverySource;
  /** BGE-M3 dense vectors are the mandatory baseline; sparse-only is insufficient. */
  denseAvailable?: boolean;
}

/** Service health is separate from model discovery so a present model is not mistaken for RAG. */
export interface RagCapabilityProbe {
  status: CapabilityStatus;
  serviceReachable?: boolean;
  denseRetrievalAvailable?: boolean;
  indexVersion?: string;
}

export interface TranslationQualityCapabilityProbe {
  bgeM3?: BgeM3CapabilityProbe;
  rag?: RagCapabilityProbe;
}

export type TranslationQualityCapabilityReason =
  | 'bge_probe_missing'
  | 'bge_not_ready'
  | 'bge_model_mismatch'
  | 'bge_dense_unavailable'
  | 'bge_fingerprint_missing'
  | 'rag_probe_missing'
  | 'rag_not_ready'
  | 'rag_unreachable'
  | 'rag_dense_unavailable';

export interface TranslationQualityCapability {
  mode: TranslationQualityMode;
  bgeM3Ready: boolean;
  ragReady: boolean;
  retrievalUsable: boolean;
  reasons: TranslationQualityCapabilityReason[];
  modelId?: string;
  fingerprint?: string;
  indexVersion?: string;
  source?: BgeM3DiscoverySource;
}

export interface TranslationModelResolution {
  selectedModelId: string;
  selectedModelName: typeof PRIMARY_TRANSLATION_MODEL | typeof FALLBACK_TRANSLATION_MODEL;
  fallbackUsed: boolean;
  invariant: LocalizedPolicyText;
}

export interface QualityGateMinimums {
  translationPasses: 1;
  independentReviewPasses: 1 | 2;
  repairAfterEveryReview: true;
  secondReviewRequired: boolean;
}

export interface SecondReviewControlPolicy {
  effectiveValue: boolean;
  disabled: boolean;
  userCanDisable: boolean;
  disabledReason?: LocalizedPolicyText;
}

export interface TranslationQualityNotices {
  qualityBenefit: LocalizedPolicyText;
  hardware: LocalizedPolicyText;
  cost: LocalizedPolicyText;
}

export interface TranslationQualityPolicy {
  version: TranslationQualityPolicyVersion;
  capability: TranslationQualityCapability;
  model: TranslationModelResolution;
  requestedWorkflow: WorkflowOptions;
  effectiveWorkflow: WorkflowOptions;
  minimums: QualityGateMinimums;
  secondReviewControl: SecondReviewControlPolicy;
  notices: TranslationQualityNotices;
  futureRevealFirewall: {
    enabled: true;
    nextChapterAccess: 'first-reviewer-private-only';
    downstreamPayload: 'ambiguity-constraints-only';
  };
}

export interface CreateTranslationQualityPolicyInput {
  capabilityProbe: TranslationQualityCapabilityProbe;
  requestedWorkflow: WorkflowOptions;
  /** IDs may be provider-qualified; matching is performed on their final path segment. */
  availableModelIds: readonly string[];
}

export interface QualityChapterReference {
  chapterId: string;
  spineIndex: number;
}

export type QualityContextInputKind =
  | 'current_chapter_source'
  | 'current_translation'
  | 'next_chapter_source'
  | 'previous_chapter_safe_summary'
  | 'previous_chapter_ambiguity_constraints'
  | 'first_review_ambiguity_constraints'
  | 'first_review_ledger'
  | 'first_repair_result'
  | 'retrieved_story_memory'
  | 'retrieved_translation_memory';

export interface QualityContextInput {
  kind: QualityContextInputKind;
  chapterId: string;
  required: boolean;
  exposure: 'reviewer' | 'reviewer-private' | 'safe-downstream';
  /** References are resolved by the Coordinator/ledger; this module never embeds book text. */
  contentPolicy: 'full' | 'non-spoiler-summary' | 'ambiguity-constraints-only' | 'retrieved-records';
}

export interface ChapterReviewContextPlan {
  policyVersion: TranslationQualityPolicyVersion;
  mode: TranslationQualityMode;
  reviewPass: 1 | 2;
  chapterId: string;
  chapterPosition: 'only' | 'first' | 'middle' | 'last';
  inputs: QualityContextInput[];
  outputRules: readonly string[];
  requiredRepairAfterReview: true;
}

export interface BuildChapterReviewContextPlanInput {
  policy: TranslationQualityPolicy;
  chapters: readonly QualityChapterReference[];
  chapterId: string;
  reviewPass: 1 | 2;
}

export interface CoordinatorQualityPolicyEnvelope {
  policy_version: TranslationQualityPolicyVersion;
  capability_mode: TranslationQualityMode;
  capability_evidence: {
    bge_m3_ready: boolean;
    rag_ready: boolean;
    retrieval_usable: boolean;
    reason_codes: readonly TranslationQualityCapabilityReason[];
    model_id?: string;
    model_fingerprint?: string;
    rag_index_version?: string;
  };
  model_policy: {
    selected_model_id: string;
    selected_model_name: typeof PRIMARY_TRANSLATION_MODEL | typeof FALLBACK_TRANSLATION_MODEL;
    fallback_used: boolean;
    primary: typeof PRIMARY_TRANSLATION_MODEL;
    fallback_only_if_primary_unavailable: typeof FALLBACK_TRANSLATION_MODEL;
  };
  minimum_quality_gates: {
    translation_passes: 1;
    independent_review_passes: 1 | 2;
    repair_after_every_review: true;
    second_review_may_be_cancelled: boolean;
  };
  context_policy: {
    first_review_without_bge: 'current-plus-next; last-current-plus-previous-safe-context';
    future_reveal_access: 'first-reviewer-private-only';
    downstream_future_context: 'ambiguity-constraints-only';
    whole_book_in_worker_context_forbidden: true;
  };
  user_notice: TranslationQualityNotices;
}

const QUALITY_BENEFIT_NOTICE: LocalizedPolicyText = Object.freeze({
  zhCN: '安装并启用 BGE-M3 可通过检索补充可靠的前文记忆，提高长篇翻译的一致性；未安装时应用会启用额外的强制审校保底。',
  en: 'Installing and enabling BGE-M3 adds retrieval-backed story memory for better long-form consistency. Without it, the app enforces extra review safeguards.',
});

const BGE_HARDWARE_NOTICE: LocalizedPolicyText = Object.freeze({
  zhCN: 'BGE-M3 支持 CPU 回退；如使用 GPU 加速，建议预留约 4 GB 显存。',
  en: 'BGE-M3 supports a CPU fallback. For GPU acceleration, allow approximately 4 GB of VRAM.',
});

const NORMAL_COST_NOTICE: LocalizedPolicyText = Object.freeze({
  zhCN: 'BGE-M3/RAG 可用：第二轮独立审校由用户选择，模型调用次数和成本取决于所选质量选项。',
  en: 'BGE-M3/RAG is available: the second independent review is optional, so model calls and cost depend on the selected quality options.',
});

const FALLBACK_COST_NOTICE: LocalizedPolicyText = Object.freeze({
  zhCN: '未检测到可用的 BGE-M3/RAG。为保障翻译质量，应用将强制执行第二轮独立审校和随后修复，因此会增加模型调用、耗时和成本。建议下载并启用 BGE-M3。',
  en: 'BGE-M3/RAG is unavailable. To protect translation quality, a second independent review and its repair are mandatory, increasing model calls, time, and cost. Installing BGE-M3 is recommended.',
});

const SECOND_REVIEW_LOCK_REASON: LocalizedPolicyText = Object.freeze({
  zhCN: '未检测到可用的 BGE-M3/RAG；第二轮审校是当前的强制质量保底，不能取消。请下载并启用 BGE-M3 后重新检测。',
  en: 'BGE-M3/RAG is unavailable, so the second review is a mandatory quality safeguard and cannot be disabled. Install BGE-M3 and re-check capabilities to unlock this option.',
});

function modelLeaf(modelId: string): string {
  return modelId.trim().split(/[\\/]/).at(-1)?.trim() ?? '';
}

function isBgeM3(modelId: string | undefined): boolean {
  if (modelId === undefined) return false;
  const normalized = modelId.trim().toLowerCase().replaceAll('\\', '/');
  return normalized === BGE_M3_MODEL_ID.toLowerCase()
    || normalized.endsWith('/bge-m3')
    || normalized.includes('models--baai--bge-m3');
}

/**
 * Fails closed: an unknown/unreachable probe selects the non-RAG quality
 * fallback instead of advertising retrieval that has not been demonstrated.
 */
export function detectTranslationQualityCapability(
  probe: TranslationQualityCapabilityProbe,
): TranslationQualityCapability {
  const reasons: TranslationQualityCapabilityReason[] = [];
  const bge = probe.bgeM3;
  const rag = probe.rag;

  if (bge === undefined) reasons.push('bge_probe_missing');
  else {
    if (bge.status !== 'ready') reasons.push('bge_not_ready');
    if (!isBgeM3(bge.modelId)) reasons.push('bge_model_mismatch');
    if (bge.denseAvailable !== true) reasons.push('bge_dense_unavailable');
    if (!bge.fingerprint?.trim()) reasons.push('bge_fingerprint_missing');
  }

  if (rag === undefined) reasons.push('rag_probe_missing');
  else {
    if (rag.status !== 'ready') reasons.push('rag_not_ready');
    if (rag.serviceReachable !== true) reasons.push('rag_unreachable');
    if (rag.denseRetrievalAvailable !== true) reasons.push('rag_dense_unavailable');
  }

  const bgeM3Ready = bge !== undefined
    && bge.status === 'ready'
    && isBgeM3(bge.modelId)
    && bge.denseAvailable === true
    && Boolean(bge.fingerprint?.trim());
  const ragReady = rag !== undefined
    && rag.status === 'ready'
    && rag.serviceReachable === true
    && rag.denseRetrievalAvailable === true;
  const retrievalUsable = bgeM3Ready && ragReady;

  return {
    mode: retrievalUsable ? 'bge-rag' : 'adjacent-chapter-fallback',
    bgeM3Ready,
    ragReady,
    retrievalUsable,
    reasons,
    ...(bge?.modelId ? { modelId: bge.modelId } : {}),
    ...(bge?.fingerprint ? { fingerprint: bge.fingerprint } : {}),
    ...(rag?.indexVersion ? { indexVersion: rag.indexVersion } : {}),
    ...(bge?.source ? { source: bge.source } : {}),
  };
}

export function isAllowedTranslationQualityModel(modelId: string): boolean {
  const leaf = modelLeaf(modelId);
  return leaf === PRIMARY_TRANSLATION_MODEL || leaf === FALLBACK_TRANSLATION_MODEL;
}

/** DeepSeek is selected whenever available; Qwen is considered only after a proven miss. */
export function resolveTranslationQualityModel(
  availableModelIds: readonly string[],
): TranslationModelResolution {
  const normalized = availableModelIds
    .map((modelId) => modelId.trim())
    .filter((modelId) => modelId.length > 0);
  const primary = normalized.find((modelId) => modelLeaf(modelId) === PRIMARY_TRANSLATION_MODEL);
  const fallback = normalized.find((modelId) => modelLeaf(modelId) === FALLBACK_TRANSLATION_MODEL);
  const selectedModelId = primary ?? fallback;

  if (selectedModelId === undefined) {
    throw new Error(
      `Translation requires ${PRIMARY_TRANSLATION_MODEL}; ${FALLBACK_TRANSLATION_MODEL} is allowed only when the primary model is unavailable.`,
    );
  }

  const fallbackUsed = primary === undefined;
  return {
    selectedModelId,
    selectedModelName: fallbackUsed ? FALLBACK_TRANSLATION_MODEL : PRIMARY_TRANSLATION_MODEL,
    fallbackUsed,
    invariant: {
      zhCN: fallbackUsed
        ? `已确认 ${PRIMARY_TRANSLATION_MODEL} 不可用，因此使用唯一允许的后备模型 ${FALLBACK_TRANSLATION_MODEL}。`
        : `必须使用 ${PRIMARY_TRANSLATION_MODEL}；不得静默切换 provider 或模型。`,
      en: fallbackUsed
        ? `${PRIMARY_TRANSLATION_MODEL} is confirmed unavailable, so the only permitted fallback, ${FALLBACK_TRANSLATION_MODEL}, is selected.`
        : `Use ${PRIMARY_TRANSLATION_MODEL} and never silently switch provider or model.`,
    },
  };
}

export function createTranslationQualityPolicy(
  input: CreateTranslationQualityPolicyInput,
): TranslationQualityPolicy {
  const capability = detectTranslationQualityCapability(input.capabilityProbe);
  const model = resolveTranslationQualityModel(input.availableModelIds);
  const fallbackMode = capability.mode === 'adjacent-chapter-fallback';
  const effectiveWorkflow: WorkflowOptions = {
    ...input.requestedWorkflow,
    secondReview: fallbackMode || input.requestedWorkflow.secondReview,
  };

  return {
    version: TRANSLATION_QUALITY_POLICY_VERSION,
    capability,
    model,
    requestedWorkflow: { ...input.requestedWorkflow },
    effectiveWorkflow,
    minimums: {
      translationPasses: 1,
      independentReviewPasses: fallbackMode ? 2 : 1,
      repairAfterEveryReview: true,
      secondReviewRequired: fallbackMode,
    },
    secondReviewControl: fallbackMode
      ? {
          effectiveValue: true,
          disabled: true,
          userCanDisable: false,
          disabledReason: SECOND_REVIEW_LOCK_REASON,
        }
      : {
          effectiveValue: effectiveWorkflow.secondReview,
          disabled: false,
          userCanDisable: true,
        },
    notices: {
      qualityBenefit: QUALITY_BENEFIT_NOTICE,
      hardware: BGE_HARDWARE_NOTICE,
      cost: fallbackMode ? FALLBACK_COST_NOTICE : NORMAL_COST_NOTICE,
    },
    futureRevealFirewall: {
      enabled: true,
      nextChapterAccess: 'first-reviewer-private-only',
      downstreamPayload: 'ambiguity-constraints-only',
    },
  };
}

function orderedChapters(chapters: readonly QualityChapterReference[]): QualityChapterReference[] {
  const seenIds = new Set<string>();
  const seenIndexes = new Set<number>();
  for (const chapter of chapters) {
    if (!chapter.chapterId.trim()) throw new Error('chapterId must not be empty');
    if (!Number.isInteger(chapter.spineIndex)) throw new Error('spineIndex must be an integer');
    if (seenIds.has(chapter.chapterId)) throw new Error(`Duplicate chapterId: ${chapter.chapterId}`);
    if (seenIndexes.has(chapter.spineIndex)) {
      throw new Error(`Duplicate spineIndex: ${chapter.spineIndex}`);
    }
    seenIds.add(chapter.chapterId);
    seenIndexes.add(chapter.spineIndex);
  }
  return [...chapters].sort((left, right) => left.spineIndex - right.spineIndex);
}

function chapterPosition(index: number, count: number): ChapterReviewContextPlan['chapterPosition'] {
  if (count === 1) return 'only';
  if (index === 0) return 'first';
  if (index === count - 1) return 'last';
  return 'middle';
}

const FUTURE_REVEAL_OUTPUT_RULES = Object.freeze([
  'The next chapter source is private evidence for the first reviewer only; never quote, summarize, or forward it to translators, repair workers, UI, logs, or reports.',
  'Convert relevant future evidence only into a minimal ambiguity constraint on the current chapter, such as preserving pronoun, identity, motive, referent, tense, or wordplay ambiguity.',
  'An ambiguity constraint must state what distinction to preserve, never the later identity, event, outcome, relationship, or reveal that motivated it.',
  'Review issues must cite the current chapter as visible source evidence; future text may justify confidence internally but must not appear in the issue payload.',
] as const);

/**
 * Returns references and safety constraints, not chapter contents. The
 * Coordinator remains free to schedule work so long as these minimums hold.
 */
export function buildChapterReviewContextPlan(
  input: BuildChapterReviewContextPlanInput,
): ChapterReviewContextPlan {
  const chapters = orderedChapters(input.chapters);
  const index = chapters.findIndex((chapter) => chapter.chapterId === input.chapterId);
  if (index < 0) throw new Error(`Unknown chapter: ${input.chapterId}`);
  if (input.reviewPass === 2 && !input.policy.effectiveWorkflow.secondReview) {
    throw new Error('A second review was not selected and is not required by the active quality policy');
  }

  const current = chapters[index]!;
  const previous = chapters[index - 1];
  const next = chapters[index + 1];
  const inputs: QualityContextInput[] = [
    {
      kind: 'current_chapter_source',
      chapterId: current.chapterId,
      required: true,
      exposure: 'reviewer',
      contentPolicy: 'full',
    },
    {
      kind: 'current_translation',
      chapterId: current.chapterId,
      required: true,
      exposure: 'reviewer',
      contentPolicy: 'full',
    },
  ];
  const outputRules: string[] = [];

  if (input.reviewPass === 2) {
    inputs.push(
      {
        kind: 'first_review_ledger',
        chapterId: current.chapterId,
        required: true,
        exposure: 'reviewer',
        contentPolicy: 'full',
      },
      {
        kind: 'first_repair_result',
        chapterId: current.chapterId,
        required: true,
        exposure: 'reviewer',
        contentPolicy: 'full',
      },
      {
        kind: 'first_review_ambiguity_constraints',
        chapterId: current.chapterId,
        required: false,
        exposure: 'safe-downstream',
        contentPolicy: 'ambiguity-constraints-only',
      },
    );
    outputRules.push(
      'Independently audit the repaired current translation; do not merely confirm or restate the first review ledger.',
      'Emit a review ledger for the current chapter, then require a constrained repair for every accepted issue.',
    );
  } else if (input.policy.capability.mode === 'bge-rag') {
    inputs.push(
      {
        kind: 'retrieved_story_memory',
        chapterId: current.chapterId,
        required: true,
        exposure: 'reviewer',
        contentPolicy: 'retrieved-records',
      },
      {
        kind: 'retrieved_translation_memory',
        chapterId: current.chapterId,
        required: true,
        exposure: 'reviewer',
        contentPolicy: 'retrieved-records',
      },
    );
    outputRules.push(
      'Consume only retrieval results with provenance and memory IDs; never inject the whole book or the complete Story Memory into one worker.',
      ...FUTURE_REVEAL_OUTPUT_RULES,
    );
  } else if (next !== undefined) {
    inputs.push({
      kind: 'next_chapter_source',
      chapterId: next.chapterId,
      required: true,
      exposure: 'reviewer-private',
      contentPolicy: 'full',
    });
    outputRules.push(
      'The first review input is the current chapter plus its next chapter in linear spine order.',
      ...FUTURE_REVEAL_OUTPUT_RULES,
    );
  } else if (previous !== undefined) {
    inputs.push(
      {
        kind: 'previous_chapter_safe_summary',
        chapterId: previous.chapterId,
        required: true,
        exposure: 'safe-downstream',
        contentPolicy: 'non-spoiler-summary',
      },
      {
        kind: 'previous_chapter_ambiguity_constraints',
        chapterId: previous.chapterId,
        required: true,
        exposure: 'safe-downstream',
        contentPolicy: 'ambiguity-constraints-only',
      },
    );
    outputRules.push(
      'For the final chapter, use the current chapter plus the preceding chapter\'s non-spoiler summary and ambiguity constraints; do not substitute the preceding full chapter.',
      ...FUTURE_REVEAL_OUTPUT_RULES,
    );
  } else {
    outputRules.push(
      'This is a one-chapter work, so audit the current source and translation without inventing adjacent context.',
      ...FUTURE_REVEAL_OUTPUT_RULES,
    );
  }

  return {
    policyVersion: TRANSLATION_QUALITY_POLICY_VERSION,
    mode: input.policy.capability.mode,
    reviewPass: input.reviewPass,
    chapterId: current.chapterId,
    chapterPosition: chapterPosition(index, chapters.length),
    inputs,
    outputRules,
    requiredRepairAfterReview: true,
  };
}

/** JSON-safe envelope intended to be included in the Coordinator's native goal/prompt. */
export function buildCoordinatorQualityPolicyEnvelope(
  policy: TranslationQualityPolicy,
): CoordinatorQualityPolicyEnvelope {
  const evidence: CoordinatorQualityPolicyEnvelope['capability_evidence'] = {
    bge_m3_ready: policy.capability.bgeM3Ready,
    rag_ready: policy.capability.ragReady,
    retrieval_usable: policy.capability.retrievalUsable,
    reason_codes: [...policy.capability.reasons],
    ...(policy.capability.modelId ? { model_id: policy.capability.modelId } : {}),
    ...(policy.capability.fingerprint
      ? { model_fingerprint: policy.capability.fingerprint }
      : {}),
    ...(policy.capability.indexVersion
      ? { rag_index_version: policy.capability.indexVersion }
      : {}),
  };

  return {
    policy_version: policy.version,
    capability_mode: policy.capability.mode,
    capability_evidence: evidence,
    model_policy: {
      selected_model_id: policy.model.selectedModelId,
      selected_model_name: policy.model.selectedModelName,
      fallback_used: policy.model.fallbackUsed,
      primary: PRIMARY_TRANSLATION_MODEL,
      fallback_only_if_primary_unavailable: FALLBACK_TRANSLATION_MODEL,
    },
    minimum_quality_gates: {
      translation_passes: policy.minimums.translationPasses,
      independent_review_passes: policy.minimums.independentReviewPasses,
      repair_after_every_review: true,
      second_review_may_be_cancelled: policy.secondReviewControl.userCanDisable,
    },
    context_policy: {
      first_review_without_bge: 'current-plus-next; last-current-plus-previous-safe-context',
      future_reveal_access: 'first-reviewer-private-only',
      downstream_future_context: 'ambiguity-constraints-only',
      whole_book_in_worker_context_forbidden: true,
    },
    user_notice: policy.notices,
  };
}
