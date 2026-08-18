import { resolve } from 'node:path';

import { compareStrings, sha256Bytes } from './hash.js';
import { writeImmutableBytes } from './immutable.js';
import type { DeterministicReportInput, ReportReceipt } from './types.js';

export function createDeterministicReport(input: DeterministicReportInput): string {
  validateReportInput(input);
  const taskCounts = countBy(input.tasks, (row) => row.state);
  const attemptCounts = countBy(input.attempts, (row) => row.state);
  const memoryCounts = countBy(input.memory_records, (row) => row.type);
  const categoryCounts = countBy(input.issues, (row) => row.category);
  const severityCounts = countBy(input.issues, (row) => row.severity);
  const unresolved = input.issues.filter((issue) => !issue.resolved && !issue.accepted_exception);
  const retryCount = input.attempts.filter((attempt) => Boolean(attempt.retry_reason)).length;
  const failedAttemptCount = input.attempts.filter((attempt) => /fail|error/iu.test(attempt.state)).length;
  const tokenTotals = input.costs.reduce(
    (totals, row) => ({
      input: totals.input + row.input_tokens,
      output: totals.output + row.output_tokens,
      reasoning: totals.reasoning + row.reasoning_tokens,
      cached: totals.cached + row.cached_tokens,
      cost: totals.cost + row.actual_cost,
    }),
    { input: 0, output: 0, reasoning: 0, cached: 0, cost: 0 },
  );
  const currencies = [...new Set(input.costs.map((row) => row.currency))].sort();
  const chineseCharacters = input.translations.reduce(
    (total, record) => total + (record.translation.match(/\p{Script=Han}/gu)?.length ?? 0),
    0,
  );
  const bodyItemCount = input.manifest.resources.filter((resource) => resource.kind === 'body').length;
  const conflictResolved = input.conflicts.filter((conflict) => conflict.resolved).length;

  const lines = [
    '# Batch Translating 最终技术报告',
    '',
    `- 数据快照时间：${input.snapshot_as_of}`,
    `- 项目/书籍 ID：${input.manifest.book_id}`,
    `- 源文件：${input.manifest.source.source_path}`,
    `- 源文件 SHA-256：${input.manifest.source.sha256}`,
    '',
    '## 源书与译文统计',
    '',
    `- 格式：${input.manifest.format.toUpperCase()}`,
    `- 正文资源数：${bodyItemCount}`,
    `- 线性章节数：${input.manifest.chapters.length}`,
    `- 段落数：${input.manifest.paragraph_count}`,
    `- 英文词数：${input.manifest.source_word_count}`,
    `- 中文字符数：${chineseCharacters}`,
    `- 已翻译段落：${input.translations.length}`,
    '',
    '## Memory 与 RAG',
    '',
    ...renderCounts(memoryCounts),
    ...renderConfiguration(input.rag_configuration),
    '',
    '## 任务与尝试',
    '',
    `- 任务总数：${input.tasks.length}`,
    ...renderCounts(taskCounts),
    `- Attempt 总数：${input.attempts.length}`,
    ...renderCounts(attemptCounts),
    `- Retry 数：${retryCount}`,
    `- 失败 Attempt 数：${failedAttemptCount}`,
    '',
    '## 审核、修复与冲突',
    '',
    `- Issue 总数：${input.issues.length}`,
    `- 未解决 Issue：${unresolved.length}`,
    `- 未解决 High：${unresolved.filter((issue) => issue.severity === 'high').length}`,
    `- 未解决 Critical：${unresolved.filter((issue) => issue.severity === 'critical').length}`,
    ...renderCounts(categoryCounts),
    ...renderCounts(severityCounts),
    `- Repair patch 数：${input.patches.length}`,
    `- Conflict set 数：${input.conflicts.length}`,
    `- 已解决 conflict 数：${conflictResolved}`,
    '',
    '## Token 与成本',
    '',
    `- 输入 token：${tokenTotals.input}`,
    `- 输出 token：${tokenTotals.output}`,
    `- Reasoning token：${tokenTotals.reasoning}`,
    `- Cached token：${tokenTotals.cached}`,
    `- 实际成本：${formatDecimal(tokenTotals.cost)}${currencies.length === 1 ? ` ${currencies[0]}` : ''}`,
    `- 货币种类：${currencies.length === 0 ? '无成本事件' : currencies.join(', ')}`,
    '',
    '## 最终产物与完整性',
    '',
    `- EPUB/TXT 路径：${input.final_artifact.output_path}`,
    `- 最终产物 SHA-256：${input.final_artifact.artifact_sha256}`,
    `- 源文件 SHA-256：${input.final_artifact.source_sha256}`,
    `- 覆盖率：${formatDecimal(input.final_artifact.coverage * 100)}%`,
    `- 内部结构校验：${input.final_artifact.structural_validation.valid ? '通过' : '失败'}`,
    `- epubcheck：${input.final_artifact.epubcheck?.status ?? '不适用'}`,
    ...input.final_artifact.structural_validation.checks.map((check) => `- 校验：${check}`),
    ...input.final_artifact.structural_validation.warnings.map((warning) => `- 警告：${warning}`),
    ...input.final_artifact.structural_validation.errors.map((error) => `- 错误：${error}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export async function writeDeterministicReport(
  outputPath: string,
  input: DeterministicReportInput,
): Promise<ReportReceipt> {
  const absolutePath = resolve(outputPath);
  const bytes = Buffer.from(createDeterministicReport(input), 'utf8');
  await writeImmutableBytes(absolutePath, bytes);
  return {
    output_path: absolutePath,
    sha256: sha256Bytes(bytes),
    byte_length: bytes.byteLength,
    immutable: true,
  };
}

function validateReportInput(input: DeterministicReportInput): void {
  if (!Number.isFinite(Date.parse(input.snapshot_as_of))) throw new Error('Report snapshot_as_of is invalid');
  if (input.final_artifact.source_sha256 !== input.manifest.source.sha256) {
    throw new Error('Report final artifact does not belong to its source manifest');
  }
  const paragraphIds = new Set(
    input.manifest.chapters.flatMap((chapter) => chapter.paragraphs.map((paragraph) => paragraph.paragraph_id)),
  );
  if (new Set(input.translations.map((record) => record.paragraph_id)).size !== input.translations.length) {
    throw new Error('Report contains duplicate translation rows');
  }
  for (const record of input.translations) {
    if (!paragraphIds.has(record.paragraph_id)) throw new Error(`Report references unknown paragraph ${record.paragraph_id}`);
  }
  for (const cost of input.costs) {
    for (const [name, value] of Object.entries({
      input_tokens: cost.input_tokens,
      output_tokens: cost.output_tokens,
      reasoning_tokens: cost.reasoning_tokens,
      cached_tokens: cost.cached_tokens,
      actual_cost: cost.actual_cost,
    })) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`Report cost ${cost.event_id} has invalid ${name}`);
    }
  }
}

function countBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function renderCounts(counts: ReadonlyMap<string, number>): string[] {
  if (counts.size === 0) return ['- 无记录'];
  return [...counts.entries()].sort(([left], [right]) => compareStrings(left, right)).map(([key, value]) => `- ${key}：${value}`);
}

function renderConfiguration(configuration: Readonly<Record<string, string | number | boolean>>): string[] {
  const rows = Object.entries(configuration).sort(([left], [right]) => compareStrings(left, right));
  return rows.length === 0 ? ['- RAG 配置：未启用/无快照'] : rows.map(([key, value]) => `- RAG ${key}：${value}`);
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(8).replace(/0+$/u, '').replace(/\.$/u, '');
}
