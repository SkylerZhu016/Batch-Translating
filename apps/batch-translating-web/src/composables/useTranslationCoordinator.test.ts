import { describe, expect, it } from 'vitest';
import { createTranslationProject } from '../translation';
import {
  buildTranslationCoordinatorGoal,
  buildTranslationCoordinatorPrompt,
  TRANSLATION_COORDINATOR_PROFILE,
} from './useTranslationCoordinator';

const project = createTranslationProject({
  projectId: 'translation_prompt_audit',
  name: 'Prompt audit',
  languages: { source: 'auto', target: 'zh-CN' },
  sourcePath: 'D:\\Books\\source.epub',
  projectRoot: 'D:\\Translations\\prompt-audit',
  workflow: {
    secondTranslation: false,
    secondReview: false,
    consistencyReview: false,
  },
  maxAgents: 8,
  now: '2026-08-20T00:00:00.000Z',
});

describe('native translation session prompt audit', () => {
  it('uses the native Kimi prompt through the translation five-tool profile', () => {
    expect(TRANSLATION_COORDINATOR_PROFILE).toBe('translation-coordinator');
  });

  it('uses one identical native goal objective and first visible user message', () => {
    expect(buildTranslationCoordinatorPrompt(project, 'kimi/model')).toBe(
      '请完成任务："D:\\Translations\\prompt-audit\\translation-task.txt"。所有工作语言使用简体中文。',
    );
    expect(buildTranslationCoordinatorGoal(project, 'kimi/model')).toBe(
      buildTranslationCoordinatorPrompt(project, 'kimi/model'),
    );
  });

  it('keeps the native goal compact and delegates operational detail to the task book', () => {
    const goal = buildTranslationCoordinatorGoal(project, 'kimi/model');
    expect(goal).toContain('translation-task.txt');
    expect(goal).not.toContain(project.projectId);
    expect(goal).not.toContain(project.paths.finalOutputPath);
    expect(goal.length).toBeLessThan(100);
  });

  it('uses the configured target language in the native goal', () => {
    expect(buildTranslationCoordinatorPrompt({
      ...project,
      languages: { source: 'auto', target: 'en' },
    })).toContain('所有工作语言使用英文');
  });
});
