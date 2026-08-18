import type {
  AffectedScopeAnalysis,
  AnalyzeAffectedScopeInput,
  TaskRecord,
} from './types.ts';

const GLOBAL_STYLE_PATTERNS = [
  /全书/u,
  /所有(?:未完成)?(?:章节|译文|翻译|审校)/u,
  /统一(?:全书|整体)(?:风格|语气|文风)/u,
  /(?:整体|全局)(?:风格|语气|文风|标点|人称)/u,
  /whole\s+(?:book|novel|project)/iu,
  /(?:global|overall|consistent)\s+(?:style|tone|voice|punctuation)/iu,
  /all\s+(?:chapters|translations|reviews)/iu,
];

const EXPLICIT_PROJECT_PATTERNS = [/整个项目/u, /全部任务/u, /everything\s+in\s+the\s+project/iu];
const PARAGRAPH_PATTERN = /\b(?:ch\d{1,5}-p\d{1,7}|paragraph[-_: ]?[A-Za-z0-9._:-]+)\b/giu;
const CHAPTER_PATTERN = /\b(?:chapter|ch)[-_: ]?(\d{1,5})\b/giu;
const CHINESE_CHAPTER_PATTERN = /第\s*(\d{1,5})\s*章/gu;

function taskSelectors(task: TaskRecord): {
  chapters: Set<string>;
  entities: Set<string>;
  paragraphs: Set<string>;
} {
  const chapters = new Set<string>();
  const entities = new Set<string>();
  const paragraphs = new Set<string>();
  const visit = (value: unknown, parentKey = ''): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, parentKey);
      return;
    }
    if (typeof value === 'string') {
      const key = parentKey.toLowerCase();
      if (key.includes('chapter')) chapters.add(value);
      if (key.includes('entity') || key.includes('character')) entities.add(value);
      if (key.includes('paragraph')) paragraphs.add(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) visit(entry, key);
  };
  visit(task.scope);
  return { chapters, entities, paragraphs };
}

function isTranslationOrReview(task: TaskRecord): boolean {
  const identity = `${task.taskType} ${task.stage}`.toLowerCase();
  return identity.includes('translat') || identity.includes('review') || identity.includes('audit');
}

function normalizedCandidates(entityKey: string, aliases: readonly string[]): string[] {
  return [entityKey, ...aliases]
    .map((value) => value.trim())
    .filter((value) => value.length >= 2)
    .sort((left, right) => right.length - left.length);
}

export function analyzeAffectedScope(input: AnalyzeAffectedScopeInput): AffectedScopeAnalysis {
  const message = input.message.trim();
  if (!message) throw new Error('Affected-scope analysis requires a non-empty user message');
  const explicitTaskIds = new Set(input.explicitScope?.affectedTaskIds ?? []);
  const chapters = new Set(input.explicitScope?.affectedChapterIds ?? []);
  const entities = new Set(input.explicitScope?.affectedEntities ?? []);
  const paragraphs = new Set<string>();
  const reasons: string[] = [];

  for (const match of message.matchAll(PARAGRAPH_PATTERN)) {
    if (match[0]) paragraphs.add(match[0]);
  }
  for (const match of message.matchAll(CHAPTER_PATTERN)) {
    const number = match[1];
    if (number) {
      chapters.add(number);
      chapters.add(`ch${number.padStart(3, '0')}`);
      chapters.add(`chapter-${number}`);
    }
  }
  for (const match of message.matchAll(CHINESE_CHAPTER_PATTERN)) {
    const number = match[1];
    if (number) {
      chapters.add(number);
      chapters.add(`ch${number.padStart(3, '0')}`);
      chapters.add(`chapter-${number}`);
    }
  }
  if (paragraphs.size > 0) reasons.push('explicit paragraph identifier');
  if (chapters.size > (input.explicitScope?.affectedChapterIds?.length ?? 0)) {
    reasons.push('explicit chapter identifier');
  }

  const lowerMessage = message.toLocaleLowerCase();
  for (const entity of input.canonicalEntities) {
    const candidates = normalizedCandidates(entity.entityKey, entity.aliases ?? []);
    if (candidates.some((candidate) => lowerMessage.includes(candidate.toLocaleLowerCase()))) {
      entities.add(entity.entityKey);
    }
  }
  if (entities.size > 0) reasons.push('canonical entity or alias mentioned');

  for (const paragraph of input.paragraphs) {
    if (paragraphs.has(paragraph.paragraphId)) chapters.add(paragraph.chapterId);
    if (paragraph.entities.some((entity) => entities.has(entity))) {
      paragraphs.add(paragraph.paragraphId);
      chapters.add(paragraph.chapterId);
    }
  }

  const explicitProject =
    input.explicitScope?.global === true || EXPLICIT_PROJECT_PATTERNS.some((pattern) => pattern.test(message));
  const globalStyle = GLOBAL_STYLE_PATTERNS.some((pattern) => pattern.test(message));
  const reliableNarrowScope = paragraphs.size > 0 || chapters.size > 0 || entities.size > 0 || explicitTaskIds.size > 0;
  const failSafeGlobal = !explicitProject && !globalStyle && !reliableNarrowScope;
  const global = explicitProject || globalStyle || failSafeGlobal;
  if (explicitProject) reasons.push('explicit whole-project scope');
  if (globalStyle) reasons.push('global style/tone instruction');
  if (failSafeGlobal) reasons.push('scope could not be narrowed deterministically; fail-safe global scope');

  for (const task of input.tasks) {
    if (!['PENDING', 'LEASED', 'RUNNING', 'SUCCEEDED', 'BLOCKED'].includes(task.state)) continue;
    if (global) {
      if (explicitProject || isTranslationOrReview(task)) explicitTaskIds.add(task.taskId);
      continue;
    }
    const selectors = taskSelectors(task);
    const chapterHit = [...chapters].some((value) => selectors.chapters.has(value));
    const entityHit = [...entities].some((value) => selectors.entities.has(value));
    const paragraphHit = [...paragraphs].some((value) => selectors.paragraphs.has(value));
    if (chapterHit || entityHit || paragraphHit) explicitTaskIds.add(task.taskId);
  }

  const confidence: AffectedScopeAnalysis['confidence'] = failSafeGlobal
    ? 'LOW'
    : input.explicitScope?.global !== undefined ||
        (input.explicitScope?.affectedTaskIds?.length ?? 0) > 0 ||
        paragraphs.size > 0 ||
        chapters.size > 0
      ? 'HIGH'
      : entities.size > 0 || globalStyle
        ? 'MEDIUM'
        : 'LOW';
  return {
    affectedTaskIds: [...explicitTaskIds].sort(),
    affectedChapterIds: [...chapters].sort(),
    affectedEntities: [...entities].sort(),
    global,
    reason: reasons.join('; '),
    confidence,
    matchedParagraphIds: [...paragraphs].sort(),
  };
}
