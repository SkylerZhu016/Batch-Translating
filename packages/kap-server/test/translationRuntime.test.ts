import type { IFileService } from '@moonshot-ai/agent-core-v2';
import type { BookManifest } from '@batch-translating/translation-tools';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ServerLogger } from '../src/services/pinoLoggerService';
import {
  calculateUsageCost,
  TranslationRuntime,
} from '../src/services/translation/translationRuntime';
import {
  buildLegacyTranslationTaskBook,
  buildTranslationTaskBook,
  buildTranslationTaskBookV3,
} from '../src/services/translation/taskBook';

describe('TranslationRuntime usage pricing', () => {
  it('converts native token counters into micro-USD and records cache fallbacks', () => {
    const result = calculateUsageCost(
      {
        inputOther: 1_000,
        output: 200,
        inputCacheRead: 300,
        inputCacheCreation: 400,
      },
      {
        currency: 'USD',
        inputUsdPerMillion: 2,
        outputUsdPerMillion: 10,
        cacheReadUsdPerMillion: 0.5,
        cacheCreationUsdPerMillion: 3,
      },
      { providerId: 'provider-test', modelId: 'provider-test/model' },
    );

    expect(result.actualCostMicros).toBe(5_350);
    expect(result.priceSnapshot).toMatchObject({
      availability: 'configured',
      currency: 'USD',
      cache_read_fallback_to_input: false,
      cache_creation_fallback_to_input: false,
    });

    const fallback = calculateUsageCost(
      { inputOther: 0, output: 0, inputCacheRead: 100, inputCacheCreation: 50 },
      { currency: 'USD', inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
      { providerId: 'provider-test', modelId: 'provider-test/model' },
    );
    expect(fallback.actualCostMicros).toBe(300);
    expect(fallback.priceSnapshot).toMatchObject({
      cache_read_usd_per_million: 2,
      cache_creation_usd_per_million: 2,
      cache_read_fallback_to_input: true,
      cache_creation_fallback_to_input: true,
    });
  });
});

describe('TranslationRuntime task book', () => {
  it('creates the durable full-book contract, preserves edits, and restores a missing copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'batch-translation-runtime-'));
    const homeDir = join(root, 'home');
    const projectRoot = join(root, 'project');
    const sourceBytes = Buffer.from('# Chapter 1\n\nHello world.\n', 'utf8');
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const sourceFileId = 'f_translation_source';
    const fileService = {
      get: vi.fn(async () => ({
        meta: {
          sha256: sourceSha256,
          size: sourceBytes.byteLength,
          created_at: '2026-08-20T00:00:00.000Z',
        },
        stream: async function* stream() {
          yield sourceBytes;
        },
      })),
    } as unknown as IFileService;
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ServerLogger;
    const createRuntime = () => new TranslationRuntime({
      homeDir,
      fileService,
      logger,
      resolveModelPricing: () => ({
        currency: 'USD',
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
      }),
    });
    let runtime = createRuntime();
    const paths = {
      projectRoot,
      sourcePath: 'attachments/source.txt',
      sourceCopy: join(projectRoot, 'source', 'source.txt'),
      unpackedDir: join(projectRoot, 'source', 'unpacked'),
      manifestPath: join(projectRoot, 'state', 'book_manifest.json'),
      memoryDir: join(projectRoot, 'memory'),
      translationDir: join(projectRoot, 'translation'),
      reviewsDir: join(projectRoot, 'reviews'),
      repairsDir: join(projectRoot, 'repairs'),
      finalDir: join(projectRoot, 'final'),
      logsDir: join(projectRoot, 'logs'),
      stateDir: join(projectRoot, 'state'),
      taskManifestPath: join(projectRoot, 'state', 'tasks.jsonl'),
      issuesPath: join(projectRoot, 'reviews', 'issues.jsonl'),
      checkpointPath: join(projectRoot, 'state', 'checkpoints.jsonl'),
      finalOutputPath: join(projectRoot, 'final', 'book.en.txt'),
      finalReportPath: join(projectRoot, 'final', 'report.md'),
    };
    const project = {
      schemaVersion: 2,
      projectId: 'translation_task_book_test',
      name: 'Task book test',
      languages: { source: 'auto', target: 'en' },
      model: 'kimi/test-model',
      revision: 0,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
      source: {
        kind: 'txt',
        sourcePath: paths.sourcePath,
        immutable: true,
        sha256: sourceSha256,
        sizeBytes: sourceBytes.byteLength,
      },
      paths,
      workflow: {
        secondTranslation: false,
        secondReview: false,
        consistencyReview: false,
      },
      executionPolicy: {
        softBudgetMicros: 100,
        hardBudgetMicros: 300,
        maxRetries: 2,
        maxConcurrency: 4,
      },
      maxAgents: 8,
      status: 'draft',
      planFingerprint: 'test-plan',
      promptVersion: 'test-prompt',
      overrideRevision: 0,
      stages: [],
      chapters: [],
      issues: [],
      artifacts: [],
      checkpoints: [],
      overrides: [],
    } as const;
    const taskBookPath = join(projectRoot, 'translation-task.txt');

    try {
      await runtime.initialize({ project, sourceFileId });
      const sessionCustom = {
        batchTranslation: {
          projectId: project.projectId,
          paths: { projectRoot },
        },
      };
      await expect(runtime.assertPaidWorkAllowed(sessionCustom)).resolves.toBeUndefined();
      const soft = await runtime.recordAgentUsage({
        sessionId: 'session-budget-test',
        agentId: 'main',
        sessionCustom,
        requestId: 'request-soft-budget',
        sourceType: 'turn',
        turnId: 1,
        step: 1,
        modelId: 'test-model',
        providerId: 'kimi',
        usage: {
          inputOther: 120,
          output: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      });
      expect(soft?.notification?.code).toBe('translation-soft-budget-reached');
      await expect(runtime.assertPaidWorkAllowed(sessionCustom)).resolves.toBeUndefined();
      const operation = await runtime.recordAgentUsage({
        sessionId: 'session-budget-test',
        agentId: 'main',
        sessionCustom,
        requestId: 'request-compaction',
        sourceType: 'operation',
        requestKind: 'full_compaction',
        modelId: 'test-model',
        providerId: 'kimi',
        usage: {
          inputOther: 0,
          output: 100,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      });
      expect(operation?.notification).toBeUndefined();
      expect(operation?.budget.actualCostMicros).toBe(220);
      await expect(runtime.assertPaidWorkAllowed(sessionCustom)).resolves.toBeUndefined();
      const hard = await runtime.recordAgentUsage({
        sessionId: 'session-budget-test',
        agentId: 'main',
        sessionCustom,
        requestId: 'request-hard-budget',
        sourceType: 'turn',
        turnId: 1,
        step: 2,
        modelId: 'test-model',
        providerId: 'kimi',
        usage: {
          inputOther: 0,
          output: 100,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      });
      expect(hard?.notification?.code).toBe('translation-hard-budget-reached');
      await expect(runtime.assertPaidWorkAllowed(sessionCustom)).rejects.toMatchObject({
        kind: 'conflict',
      });
      const replayed = await runtime.recordAgentUsage({
        sessionId: 'session-budget-test',
        agentId: 'main',
        sessionCustom,
        requestId: 'request-hard-budget',
        sourceType: 'turn',
        turnId: 1,
        step: 2,
        modelId: 'test-model',
        providerId: 'kimi',
        usage: {
          inputOther: 0,
          output: 100,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      });
      expect(replayed?.notification).toBeUndefined();
      expect(replayed?.budget.actualCostMicros).toBe(320);
      const created = await readFile(taskBookPath, 'utf8');
      expect(created).toContain('# TXT 小说全书 AI 翻译——自主执行任务书');
      expect(created).toContain('**所有工作语言使用英文。**');
      expect(created).toContain('自动检测 → 英文');
      expect(created).toContain(paths.finalOutputPath);
      expect(created).toContain('BGE-M3 + Qdrant 强制验证');
      expect(created).toContain('BATCH_TRANSLATING_RAG_RUNTIME');
      expect(created).toContain('"$BT" translation rag health');
      expect(created).toContain('不得在 PATH 中查找 BGE-M3 命令');
      expect(created).toContain('Story Memory');
      expect(created).toContain('三路审校、Repair 与仲裁');
      expect(created).toContain('Read、Write、Bash、Agent、AgentSwarm');
      expect(created).toContain('使用 UpdateGoal 收口');
      expect(created).toContain('任务书版本：native-taskbook-v4');
      expect(created).toContain('出版格式一致');
      expect(created).toContain('项目台账只能通过项目随附的 `translation ledger` 命令');
      expect(created).not.toContain('translation.sqlite3');
      expect(created).not.toContain('第二轮翻译');
      expect(created).not.toContain('第二轮完整审校');
      expect(created).not.toContain('全书一致性审计');
      expect(created).toContain('第一版完成后保留全部中间成果');
      expect(created).not.toContain('不是');

      const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as BookManifest;
      const enabledTaskBook = buildTranslationTaskBook({
        ...project,
        workflow: {
          secondTranslation: true,
          secondReview: true,
          consistencyReview: true,
        },
      }, manifest);
      expect(enabledTaskBook).toContain('| 第二轮翻译 | 启用 |');
      expect(enabledTaskBook).toContain('| 第二轮完整审校 | 启用 |');
      expect(enabledTaskBook).toContain('| 全书一致性审计 | 启用 |');
      expect(enabledTaskBook.indexOf('### 第二轮翻译')).toBeLessThan(
        enabledTaskBook.indexOf('### 第二轮完整审校'),
      );
      expect(enabledTaskBook.indexOf('### 第二轮完整审校')).toBeLessThan(
        enabledTaskBook.indexOf('### 全书一致性审计'),
      );

      const fallbackTaskBook = buildTranslationTaskBook({
        ...project,
        qualityPolicy: {
          policy: {
            capability: { mode: 'adjacent-chapter-fallback' },
          },
        },
      }, manifest);
      expect(fallbackTaskBook).toContain('相邻两章内的必要上下文');
      expect(fallbackTaskBook).not.toContain('BGE-M3');
      expect(fallbackTaskBook).not.toContain('BATCH_TRANSLATING_RAG_RUNTIME');
      expect(fallbackTaskBook).not.toContain('Qdrant');
      expect(fallbackTaskBook).not.toContain('Story RAG');
      expect(fallbackTaskBook).not.toContain('Story Memory');

      await writeFile(taskBookPath, buildLegacyTranslationTaskBook(project, manifest), 'utf8');
      await runtime.projectStatus({ projectId: project.projectId, projectRoot });
      expect(await readFile(taskBookPath, 'utf8')).toContain('任务书版本：native-taskbook-v4');

      await writeFile(taskBookPath, buildTranslationTaskBookV3(project, manifest), 'utf8');
      await runtime.projectStatus({ projectId: project.projectId, projectRoot });
      expect(await readFile(taskBookPath, 'utf8')).toContain('任务书版本：native-taskbook-v4');

      await writeFile(taskBookPath, 'user-maintained note', 'utf8');
      await runtime.projectStatus({ projectId: project.projectId, projectRoot });
      expect(await readFile(taskBookPath, 'utf8')).toBe('user-maintained note');

      await rm(taskBookPath);
      await runtime.projectStatus({ projectId: project.projectId, projectRoot });
      expect(await readFile(taskBookPath, 'utf8')).toContain('# TXT 小说全书 AI 翻译——自主执行任务书');

      const pendingEventId = 'a'.repeat(64);
      const outboxPath = join(
        homeDir,
        'translation-usage-outbox',
        project.projectId,
        `${pendingEventId}.json`,
      );
      await runtime.close();
      await mkdir(join(homeDir, 'translation-usage-outbox', project.projectId), {
        recursive: true,
      });
      await writeFile(outboxPath, JSON.stringify({
        schemaVersion: 1,
        eventId: pendingEventId,
        projectId: project.projectId,
        projectRoot,
        sessionId: 'session-budget-test',
        agentId: 'main',
        turnId: 'operation:full_compaction:request-restart-replay',
        step: 0,
        modelId: 'test-model',
        providerId: 'kimi',
        inputTokens: 10,
        outputTokens: 0,
        cachedTokens: 0,
        priceSnapshot: { availability: 'configured', currency: 'USD' },
        actualCostMicros: 10,
        stage: 'context-maintenance',
      }), 'utf8');
      runtime = createRuntime();
      await expect(runtime.assertPaidWorkAllowed(sessionCustom)).rejects.toMatchObject({
        kind: 'conflict',
      });
      const restartedStatus = await runtime.projectStatus({
        projectId: project.projectId,
        projectRoot,
      });
      expect((restartedStatus.budget as { actualCostMicros: number }).actualCostMicros).toBe(330);
      await expect(readFile(outboxPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
