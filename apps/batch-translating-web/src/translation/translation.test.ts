import { describe, expect, it } from 'vitest';
import {
  activeUserOverrides,
  appendUserOverride,
  assertProtectedMinimum,
  buildStagePlan,
  createTranslationProject,
  joinLocalPath,
  MAX_SWARM_AGENTS,
  MIN_SWARM_AGENTS,
  normalizeMaxAgents,
  parseProjectMetadata,
  parseProjectMetadataJson,
  planFingerprint,
  sameLocalPath,
  serializeProjectMetadata,
  setUserOverrideStatus,
  TRANSLATION_PROMPT_VERSION,
  verifiedTranslationOutputPath,
  type TranslationProject,
  type WorkflowOptions,
} from './index';

const requiredOnly: WorkflowOptions = {
  secondTranslation: false,
  secondReview: false,
  consistencyReview: false,
};

function project(overrides: Partial<TranslationProject> = {}): TranslationProject {
  return {
    ...createTranslationProject({
      projectId: 'translation_example',
      name: 'Example book',
      sourcePath: 'D:\\Books\\example.epub',
      projectRoot: 'D:\\Translations\\example',
      workflow: requiredOnly,
      maxAgents: 16,
      now: '2026-08-13T00:00:00.000Z',
    }),
    ...overrides,
  };
}

describe('deterministic translation stage plan', () => {
  it('always includes one translation, independent review, and repair in order', () => {
    const plan = buildStagePlan(requiredOnly);
    expect(plan.map((stage) => stage.id)).toEqual([
      'parse-epub',
      'analyze-book',
      'smoke-test',
      'translation-1',
      'review-1',
      'repair-1',
      'final-audit',
      'export-epub',
    ]);
    expect(assertProtectedMinimum(plan)).toBe(true);
    expect(plan.find((stage) => stage.id === 'translation-1')?.required).toBe(true);
    expect(plan.find((stage) => stage.id === 'review-1')?.required).toBe(true);
  });

  it('adds only the user-selected optional passes at fixed positions', () => {
    const plan = buildStagePlan({
      secondTranslation: true,
      secondReview: true,
      consistencyReview: true,
    });
    expect(plan.map((stage) => stage.id)).toEqual([
      'parse-epub',
      'analyze-book',
      'smoke-test',
      'translation-1',
      'review-1',
      'repair-1',
      'translation-2',
      'review-2',
      'repair-2',
      'consistency-review',
      'consistency-repair',
      'final-audit',
      'export-epub',
    ]);
    plan.forEach((stage, index) => {
      expect(stage.dependsOn).toEqual(index === 0 ? [] : [plan[index - 1]!.id]);
      expect(stage.required).toBe(true);
    });
  });

  it('keeps the second-translation and second-review checkboxes independent', () => {
    const translationOnly = buildStagePlan({
      ...requiredOnly,
      secondTranslation: true,
    }).map((stage) => stage.id);
    expect(translationOnly.slice(3)).toEqual([
      'translation-1',
      'review-1',
      'repair-1',
      'translation-2',
      'final-audit',
      'export-epub',
    ]);

    const reviewOnly = buildStagePlan({
      ...requiredOnly,
      secondReview: true,
    }).map((stage) => stage.id);
    expect(reviewOnly.slice(3)).toEqual([
      'translation-1',
      'review-1',
      'repair-1',
      'review-2',
      'repair-2',
      'final-audit',
      'export-epub',
    ]);
  });

  it('has a stable fingerprint that changes with selected passes', () => {
    const base = buildStagePlan(requiredOnly);
    expect(planFingerprint(base)).toBe(planFingerprint(buildStagePlan(requiredOnly)));
    expect(planFingerprint(base)).not.toBe(planFingerprint(buildStagePlan({
      ...requiredOnly,
      secondReview: true,
    })));
  });

  it('bounds configured swarm size to the official 2-128 range', () => {
    expect(normalizeMaxAgents(-1)).toBe(MIN_SWARM_AGENTS);
    expect(normalizeMaxAgents(17.9)).toBe(17);
    expect(normalizeMaxAgents(500)).toBe(MAX_SWARM_AGENTS);
    expect(normalizeMaxAgents(Number.NaN)).toBe(MIN_SWARM_AGENTS);
  });
});
describe('translation project metadata', () => {
  it('creates an immutable source contract and Windows-safe project paths', () => {
    const value = project();
    expect(value.source).toEqual({
      kind: 'epub',
      sourcePath: 'D:\\Books\\example.epub',
      immutable: true,
    });
    expect(value.paths.sourceCopy).toBe('D:\\Translations\\example\\source\\example.epub');
    expect(value.paths.finalOutputPath).toBe('D:\\Translations\\example\\final\\book.zh-CN.epub');
    expect(value.promptVersion).toBe(TRANSLATION_PROMPT_VERSION);
    expect(value.planFingerprint).toBe(planFingerprint(value.stages.map((stage) => stage.definition)));
  });

  it('supports a user-entered source language and limits the target to Chinese or English', () => {
    const value = createTranslationProject({
      projectId: 'translation_english',
      name: 'English edition',
      languages: { source: 'Japanese', target: 'en' },
      sourcePath: 'D:\\Books\\novel.epub',
      projectRoot: 'D:\\Translations\\english',
      workflow: requiredOnly,
      maxAgents: 8,
      now: '2026-08-20T00:00:00.000Z',
    });
    expect(value.languages).toEqual({ source: 'Japanese', target: 'en' });
    expect(value.paths.finalOutputPath).toBe('D:\\Translations\\english\\final\\book.en.epub');

    expect(() => createTranslationProject({
      name: 'Same language',
      languages: { source: 'en', target: 'en' },
      sourcePath: 'D:\\Books\\novel.epub',
      projectRoot: 'D:\\Translations\\same',
      workflow: requiredOnly,
      maxAgents: 8,
    })).toThrow('must be different');
  });

  it('accepts only structurally verified current output milestones', () => {
    const output = {
      round: 1,
      path: 'D:\\Translations\\example\\final\\book.zh-CN.epub',
      sha256: 'a'.repeat(64),
      byteLength: 4096,
      structuralValidationPassed: true as const,
      recordedAt: '2026-08-20T01:00:00.000Z',
    };
    const completed = project({
      status: 'completed',
      latestOutput: output,
      outputHistory: [output],
    });
    expect(parseProjectMetadata(completed).ok).toBe(true);
    expect(verifiedTranslationOutputPath(completed)).toBe(output.path);

    const malformed = {
      ...completed,
      outputHistory: [null],
    };
    const parsed = parseProjectMetadata(malformed);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain('outputHistory[0] must be an object');
  });

  it('creates a TXT project with a kind-specific plan, paths, and chapter pattern', () => {
    const value = createTranslationProject({
      projectId: 'translation_txt',
      name: 'Plain text book',
      sourcePath: 'D:\\Books\\novel.txt',
      chapterPattern: '^### ',
      projectRoot: 'D:\\Translations\\novel',
      workflow: requiredOnly,
      maxAgents: 8,
      now: '2026-08-13T00:00:00.000Z',
    });
    expect(value.source).toMatchObject({
      kind: 'txt',
      sourcePath: 'D:\\Books\\novel.txt',
      chapterPattern: '^###',
    });
    expect(value.stages.map((stage) => stage.definition.id)).toEqual([
      'parse-txt',
      'analyze-book',
      'smoke-test',
      'translation-1',
      'review-1',
      'repair-1',
      'final-audit',
      'export-txt',
    ]);
    expect(value.paths.finalOutputPath).toBe('D:\\Translations\\novel\\final\\book.zh-CN.txt');
    expect(value.planFingerprint).not.toBe(project().planFingerprint);
    const serialized = serializeProjectMetadata(value);
    const parsed = parseProjectMetadataJson(serialized);
    expect(parsed.ok).toBe(true);
  });

  it('rejects unsupported extensions and kind/extension mismatches', () => {
    expect(() => createTranslationProject({
      name: 'bad',
      sourcePath: 'D:\\Books\\book.pdf',
      projectRoot: 'D:\\Translations\\bad',
      workflow: requiredOnly,
      maxAgents: 4,
    })).toThrow('must have an .epub or .txt extension');
    expect(() => createTranslationProject({
      name: 'bad',
      sourcePath: 'D:\\Books\\book.txt',
      kind: 'epub',
      projectRoot: 'D:\\Translations\\bad',
      workflow: requiredOnly,
      maxAgents: 4,
    })).toThrow('does not match');
  });

  it('migrates v1 metadata (epubPath) to the v2 source contract without changing the plan', () => {
    const legacy = JSON.parse(JSON.stringify({
      ...project(),
      schemaVersion: 1,
      source: { epubPath: 'D:\\Books\\example.epub', immutable: true },
      paths: { ...project().paths, sourceEpub: 'D:\\Books\\example.epub', finalEpubPath: 'D:\\Translations\\example\\final\\book.zh-CN.epub' },
    }));
    delete legacy.source.sourcePath;
    delete legacy.paths.sourcePath;
    delete legacy.paths.finalOutputPath;

    const parsed = parseProjectMetadata(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(2);
    expect(parsed.value.source).toEqual({
      kind: 'epub',
      sourcePath: 'D:\\Books\\example.epub',
      immutable: true,
    });
    expect(parsed.value.paths.sourcePath).toBe('D:\\Books\\example.epub');
    expect(parsed.value.paths.finalOutputPath).toBe('D:\\Translations\\example\\final\\book.zh-CN.epub');
    expect(parsed.value.planFingerprint).toBe(project().planFingerprint);
    expect(parsed.value.stages.map((stage) => stage.definition.id)).toEqual(project().stages.map((stage) => stage.definition.id));
  });

  it('preserves a POSIX filesystem root while joining project paths', () => {
    expect(joinLocalPath('/', 'state', 'book_manifest.json')).toBe('/state/book_manifest.json');
  });

  it('treats Windows runtime separators as equivalent without weakening the path check', () => {
    expect(sameLocalPath(
      'D:\\Translations\\example\\source\\book.epub',
      'D:/Translations/example/source/book.epub',
    )).toBe(true);
    expect(sameLocalPath(
      'D:\\Translations\\other\\source\\book.epub',
      'D:/Translations/example/source/book.epub',
    )).toBe(false);
  });

  it('round-trips valid metadata through the strict parser', () => {
    const serialized = serializeProjectMetadata(project());
    const parsed = parseProjectMetadataJson(serialized);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.projectId).toBe('translation_example');
  });

  it('rejects unsupported versions, out-of-range agents, and a model-edited plan', () => {
    const invalidVersion = parseProjectMetadata({ ...project(), schemaVersion: 3 });
    expect(invalidVersion.ok).toBe(false);

    const invalidAgents = parseProjectMetadata({ ...project(), maxAgents: 129 });
    expect(invalidAgents.ok).toBe(false);

    const changed = project();
    changed.stages = changed.stages.filter((stage) => stage.definition.id !== 'review-1');
    const changedPlan = parseProjectMetadata(changed);
    expect(changedPlan.ok).toBe(false);
    if (!changedPlan.ok) {
      expect(changedPlan.errors.join(' ')).toContain('program-owned workflow plan');
    }
  });
});
describe('versioned user overrides', () => {
  it('appends without mutating the plan and supersedes a queued override of the same scope', () => {
    const original = project({ activeStageId: 'translation-1' });
    const first = appendUserOverride(original, {
      instruction: '角色说话要更克制。',
      overrideId: 'override_1',
      expectedProjectRevision: 0,
      now: '2026-08-13T00:01:00.000Z',
    });
    const second = appendUserOverride(first, {
      instruction: '角色说话保持克制，但不要书面化。',
      overrideId: 'override_2',
      expectedProjectRevision: 1,
      now: '2026-08-13T00:02:00.000Z',
    });

    expect(original.overrides).toHaveLength(0);
    expect(second.overrideRevision).toBe(2);
    expect(second.overrides[0]).toMatchObject({
      overrideId: 'override_1',
      status: 'superseded',
      supersededBy: 'override_2',
    });
    expect(second.overrides[1]).toMatchObject({
      version: 2,
      canModifyWorkflow: false,
      effectiveFromStageIndex: 3,
    });
    expect(second.planFingerprint).toBe(original.planFingerprint);
    expect(second.stages).toEqual(original.stages);
  });

  it('rejects stale UI writes and never applies an override retroactively', () => {
    const current = project({ revision: 4, activeStageId: 'review-1' });
    expect(() => appendUserOverride(current, {
      instruction: '保留这个双关。',
      expectedProjectRevision: 3,
    })).toThrow('Stale project revision');

    const next = appendUserOverride(current, {
      instruction: '保留这个双关。',
      effectiveFromStageIndex: 0,
      overrideId: 'override_now',
    });
    expect(next.overrides[0]?.effectiveFromStageIndex).toBe(4);
  });

  it('tracks an applied override as a new project revision', () => {
    const queued = appendUserOverride(project(), {
      instruction: '昵称统一为“小雀”。',
      overrideId: 'override_1',
      now: '2026-08-13T00:01:00.000Z',
    });
    const applied = setUserOverrideStatus(queued, 'override_1', 'applied', {
      now: '2026-08-13T00:02:00.000Z',
    });
    expect(applied.revision).toBe(2);
    expect(applied.overrides[0]).toMatchObject({
      status: 'applied',
      appliedAt: '2026-08-13T00:02:00.000Z',
    });
    expect(activeUserOverrides(applied, 3)).toHaveLength(1);
  });
});
