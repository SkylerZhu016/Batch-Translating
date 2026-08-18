import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  TranslationProjectLedger,
  type CreateProjectInput,
  type ProjectRecord,
} from '@batch-translating/translation-domain';
import {
  canonicalJson,
  parseTranslationSource,
  readSourceReceipt,
  sha256Bytes,
  writeBookManifest,
  type BookManifest,
} from '@batch-translating/translation-tools';
import type { Command } from 'commander';

import { resolveTranslationIo, runTranslationJsonCommand, type TranslationJsonCommandIo } from '../io';
import { readJsonInput } from '../json-input';

interface BootstrapProjectInput
  extends Omit<CreateProjectInput, 'projectId' | 'sourceRootPath' | 'sourceHash'> {
  readonly projectId?: string;
  readonly sourceRootPath?: string;
  readonly sourceHash?: string;
}

interface ProjectBootstrapInput {
  readonly sourcePath: string;
  readonly expectedSourceHash?: string;
  readonly manifestOutputPath?: string;
  readonly project: BootstrapProjectInput;
}

export function registerTranslationProjectCommand(
  parent: Command,
  io?: Partial<TranslationJsonCommandIo>,
): void {
  const output = resolveTranslationIo(io);
  const project = parent
    .command('project')
    .description('翻译项目恢复与初始化 / Translation project recovery and initialization.');

  project
    .command('bootstrap')
    .description(
      '只读解析源文件，幂等创建账本并注册章节/段落 / Read-only parse and idempotent ledger bootstrap.',
    )
    .requiredOption('--database <ledger.sqlite>', 'SQLite 账本路径 / SQLite ledger path.')
    .requiredOption('--input <json|->', '项目 JSON；- 从 stdin 读取 / Project JSON; - reads stdin.')
    .addHelpText(
      'after',
      '\n输入结构 / Input shape:\n' +
        '  {"sourcePath":"book.epub","expectedSourceHash":"<sha256>","manifestOutputPath":"book_manifest.json",\n' +
        '   "project":{"projectId":"optional","name":"...","artifactRootPath":"...",\n' +
        '   "providerId":"...","modelId":"..."}}\n' +
        'projectId 省略时使用源哈希派生的稳定 book_id；重复执行会核对现有记录，不会覆盖源文件。\n',
    )
    .action(async (options: { database: string; input: string }) => {
      await runTranslationJsonCommand(
        output,
        async () => bootstrapProject(options.database, await readJsonInput<ProjectBootstrapInput>(options.input)),
        { errorCode: 'translation_project_bootstrap_failed' },
      );
    });
}

async function bootstrapProject(
  databasePath: string,
  input: ProjectBootstrapInput,
): Promise<Record<string, unknown>> {
  validateBootstrapInput(input);
  const sourcePath = resolve(input.sourcePath);
  await access(sourcePath);
  const before = await readSourceReceipt(sourcePath);
  const expectedHash = input.expectedSourceHash ?? input.project.sourceHash;
  if (expectedHash && expectedHash !== before.sha256) {
    throw new Error(`Source hash mismatch: expected ${expectedHash}, got ${before.sha256}`);
  }

  const parsed = await parseTranslationSource(sourcePath);
  if (parsed.manifest.source.sha256 !== before.sha256) {
    throw new Error('Parsed manifest does not belong to the verified source bytes');
  }
  const projectId = input.project.projectId ?? parsed.manifest.book_id;
  const projectInput: CreateProjectInput & { projectId: string } = {
    ...input.project,
    projectId,
    sourceRootPath: input.project.sourceRootPath ?? sourcePath,
    sourceHash: before.sha256,
  };

  if (input.manifestOutputPath) {
    await ensureManifest(input.manifestOutputPath, parsed.manifest);
  }

  const ledger = new TranslationProjectLedger({ databasePath: resolve(databasePath) });
  try {
    const reusedProject = ledger.getProject(projectId) !== undefined;
    const project = ensureProject(ledger, projectInput);
    let sourceItemCount = 0;
    let paragraphCount = 0;
    const paragraphIds: Array<{ manifestParagraphId: string; ledgerParagraphId: string }> = [];

    for (const chapter of parsed.manifest.chapters) {
      const sourceItemId = scopedLedgerId(projectId, chapter.chapter_id);
      ledger.registerSourceItem({
        sourceItemId,
        projectId,
        href: chapter.source_path,
        mediaType: chapter.media_type,
        kind: 'body',
        spineIndex: chapter.ordinal,
        linear: chapter.linear,
        // The immutable path is the original archive/text. The chapter hashes remain
        // in metadata because an EPUB entry is not a standalone filesystem file.
        sourceHash: before.sha256,
        immutablePath: sourcePath,
        metadata: {
          bookId: parsed.manifest.book_id,
          chapterId: chapter.chapter_id,
          chapterOrdinal: chapter.ordinal,
          manifestId: chapter.manifest_id ?? null,
          sourcePath: chapter.source_path,
          paragraphSourceHashes: Object.fromEntries(
            chapter.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph.source_hash]),
          ),
        },
      });
      sourceItemCount += 1;

      for (const paragraph of chapter.paragraphs) {
        // paragraph_id is globally unique in the ledger. Preserve the tool manifest ID
        // in the returned mapping so deterministic render inputs continue to use it.
        const ledgerParagraphId = scopedLedgerId(projectId, paragraph.paragraph_id);
        ledger.registerParagraph({
          paragraphId: ledgerParagraphId,
          projectId,
          sourceItemId,
          ordinal: paragraph.ordinal,
          sourceText: paragraph.source_text,
          sourceHash: paragraph.source_hash,
        });
        paragraphIds.push({
          manifestParagraphId: paragraph.paragraph_id,
          ledgerParagraphId,
        });
        paragraphCount += 1;
      }
    }

    const after = await readSourceReceipt(sourcePath);
    if (after.sha256 !== before.sha256 || after.byte_length !== before.byte_length) {
      throw new Error('Source changed while the project was being bootstrapped');
    }
    ledger.checkpoint();
    return {
      ok: true,
      reusedProject,
      project,
      source: {
        path: sourcePath,
        sha256: before.sha256,
        byteLength: before.byte_length,
        immutable: true,
      },
      manifest: parsed.manifest,
      manifestOutputPath: input.manifestOutputPath ? resolve(input.manifestOutputPath) : undefined,
      registration: {
        sourceItemCount,
        paragraphCount,
        paragraphIds,
      },
    };
  } finally {
    ledger.close();
  }
}

function scopedLedgerId(projectId: string, localId: string): string {
  const candidate = `${projectId}:${localId}`;
  return candidate.length <= 200
    ? candidate
    : `project_${sha256Bytes(projectId).slice(0, 32)}:${localId}`;
}

function ensureProject(
  ledger: TranslationProjectLedger,
  input: CreateProjectInput & { projectId: string },
): ProjectRecord {
  const existing = ledger.getProject(input.projectId);
  if (!existing) return ledger.createProject(input);
  const expected = {
    name: input.name,
    sourceRootPath: resolve(input.sourceRootPath),
    artifactRootPath: resolve(input.artifactRootPath),
    sourceHash: input.sourceHash,
    providerId: input.providerId,
    modelId: input.modelId,
  };
  const actual = {
    name: existing.name,
    sourceRootPath: existing.sourceRootPath,
    artifactRootPath: existing.artifactRootPath,
    sourceHash: existing.sourceHash,
    providerId: existing.providerId,
    modelId: existing.modelId,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('Existing project identity does not match the requested immutable source/model metadata');
  }
  return existing;
}

async function ensureManifest(outputPath: string, manifest: BookManifest): Promise<void> {
  const absolutePath = resolve(outputPath);
  try {
    const existing = JSON.parse(await readFile(absolutePath, 'utf8')) as BookManifest;
    if (canonicalJson(stableManifest(existing)) !== canonicalJson(stableManifest(manifest))) {
      throw new Error('Existing book manifest differs from the verified source');
    }
  } catch (error) {
    if (isMissingFile(error)) {
      await writeBookManifest(absolutePath, manifest);
      return;
    }
    throw error;
  }
}

function stableManifest(manifest: BookManifest): unknown {
  return {
    ...manifest,
    created_at: undefined,
    source: {
      ...manifest.source,
      modified_at_ms: undefined,
    },
  };
}

function validateBootstrapInput(input: ProjectBootstrapInput): void {
  if (!input || typeof input !== 'object') throw new Error('Bootstrap input must be a JSON object');
  if (typeof input.sourcePath !== 'string' || !input.sourcePath.trim()) {
    throw new Error('sourcePath is required');
  }
  if (!input.project || typeof input.project !== 'object') {
    throw new Error('project metadata is required');
  }
  for (const key of ['name', 'artifactRootPath', 'providerId', 'modelId'] as const) {
    if (typeof input.project[key] !== 'string' || !input.project[key].trim()) {
      throw new Error(`project.${key} is required`);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
