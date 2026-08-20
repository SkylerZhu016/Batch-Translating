import type { BgeModelDownloadSource } from './bgeModelSetup.types';

export type TranslationView = 'projects' | 'run' | 'issues' | 'outputs' | 'agent-console' | 'settings';

export type TranslationProjectStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed';

export type TranslationStageId =
  | 'parse'
  | 'preAnalysis'
  | 'smokeTest'
  | 'firstTranslation'
  | 'firstReview'
  | 'secondTranslation'
  | 'secondReview'
  | 'consistencyReview'
  | 'fullAudit'
  | 'epubExport';

export type TranslationStageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface TranslationWorkflowOptions {
  firstTranslation: true;
  firstReview: true;
  secondTranslation: boolean;
  secondReview: boolean;
  consistencyReview: boolean;
}

export interface TranslationExecutionPolicy {
  softBudgetMicros: number;
  hardBudgetMicros: number;
  maxRetries: number;
  maxConcurrency: number;
}

export interface TranslationProjectDraft {
  title: string;
  sourcePath: string;
  sourceLanguage: string;
  targetLanguage: 'zh-CN' | 'en';
  /** TXT only: custom chapter-heading regex; empty means the default. */
  chapterPattern: string;
  workspacePath: string;
  agentCount: number;
  workflow: TranslationWorkflowOptions;
  executionPolicy: TranslationExecutionPolicy;
}

export interface TranslationProject extends TranslationProjectDraft {
  id: string;
  revisionRound: number;
  status: TranslationProjectStatus;
  completedChapters: number;
  totalChapters: number;
  updatedAt: string;
  createdAt?: string;
  outputPath?: string;
  issueCount?: number;
}

export interface TranslationStage {
  id: TranslationStageId;
  status: TranslationStageStatus;
  detail?: string;
}

export type TranslationAgentStatus = 'idle' | 'working' | 'completed' | 'failed';

export interface TranslationAgent {
  id: string;
  name: string;
  status: TranslationAgentStatus;
  stageId?: TranslationStageId;
  chapterName?: string;
  progress?: number;
}

export type TranslationChapterStatus =
  | 'pending'
  | 'translating'
  | 'reviewing'
  | 'completed'
  | 'failed';

export interface TranslationChapter {
  id: string;
  title: string;
  status: TranslationChapterStatus;
  progress: number;
  agentName?: string;
  issueCount?: number;
}

export type TranslationIssueSeverity = 'info' | 'warning' | 'error';

export interface TranslationIssue {
  id: string;
  projectId: string;
  projectTitle: string;
  severity: TranslationIssueSeverity;
  message: string;
  chapterName?: string;
  stageId?: TranslationStageId;
  createdAt: string;
}

export interface TranslationOutput {
  id: string;
  projectId: string;
  projectTitle: string;
  sourcePath: string;
  outputPath: string;
  exportedAt: string;
}

export interface TranslationSettings {
  defaultModel: string;
  defaultAgentCount: number;
  defaultWorkflow: TranslationWorkflowOptions;
  executionPolicy: TranslationExecutionPolicy;
  bge: {
    source: BgeModelDownloadSource;
    cpuFallback: boolean;
  };
}
