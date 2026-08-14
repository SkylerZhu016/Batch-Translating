import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  TXT_MANIFEST_SCHEMA_VERSION,
  TxtSplitError,
  type AssembleTxtOptions,
  type AssembleTxtResult,
  type TxtChapterEntry,
  type TxtManifest,
} from './types';

const MAX_RECORD_FILE_BYTES = 64 * 1024 * 1024;

interface ParagraphRecord {
  readonly paragraph_id: string;
  readonly translation: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecordsText(text: string, filePath: string): ParagraphRecord[] {
  const records: ParagraphRecord[] = [];
  const trimmed = text.trim();
  if (!trimmed) return records;
  const push = (value: unknown): void => {
    if (!isRecord(value)) {
      throw new TxtSplitError('invalid_record', `Record entry is not an object: ${filePath}`);
    }
    const paragraphs = value['paragraphs'];
    if (!Array.isArray(paragraphs)) return;
    for (const paragraph of paragraphs) {
      if (!isRecord(paragraph)) {
        throw new TxtSplitError('invalid_record', `Paragraph entry is not an object: ${filePath}`);
      }
      const id = paragraph['paragraph_id'];
      const translation = paragraph['translation'];
      if (typeof id !== 'string' || id.length === 0 || typeof translation !== 'string') {
        throw new TxtSplitError(
          'invalid_record',
          `Paragraph record must carry paragraph_id and translation strings: ${filePath}`,
        );
      }
      records.push({ paragraph_id: id, translation });
    }
  };
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new TxtSplitError('invalid_record', `Record array expected: ${filePath}`);
    }
    for (const entry of parsed) push(entry);
    return records;
  }
  // Prefer JSONL (one object per line); fall back to a single multi-line object.
  let jsonlObjects = 0;
  const lines = trimmed.split('\n');
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (candidate.startsWith('{')) jsonlObjects += 1;
  }
  if (jsonlObjects === 1 && !trimmed.startsWith('{')) {
    push(JSON.parse(trimmed) as unknown);
    return records;
  }
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate) continue;
    push(JSON.parse(candidate) as unknown);
  }
  return records;
}

async function collectRecords(recordsDirectory: string): Promise<ParagraphRecord[]> {
  const records: ParagraphRecord[] = [];
  const seen = new Map<string, string>();
  const queue: string[] = [recordsDirectory];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      throw new TxtSplitError(
        'records_unreadable',
        `Cannot list records directory "${directory}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && /\.(json|jsonl)$/i.test(entry.name)) {
        const info = await stat(fullPath);
        if (info.size > MAX_RECORD_FILE_BYTES) {
          throw new TxtSplitError(
            'record_too_large',
            `Record file exceeds the ${String(MAX_RECORD_FILE_BYTES)} byte limit: ${fullPath}`,
          );
        }
        const text = readFileSync(fullPath, 'utf8');
        for (const record of parseRecordsText(text, fullPath)) {
          const previous = seen.get(record.paragraph_id);
          if (previous !== undefined && previous !== record.translation) {
            throw new TxtSplitError(
              'duplicate_paragraph_translation',
              `Paragraph ${record.paragraph_id} has conflicting translations in different records.`,
            );
          }
          if (previous === undefined) {
            seen.set(record.paragraph_id, record.translation);
            records.push(record);
          }
        }
      }
    }
  }
  return records;
}

function expectedParagraphIds(chapter: TxtChapterEntry): string[] {
  const width = Math.max(4, String(chapter.paragraphCount).length);
  const ids: string[] = [];
  for (let index = 1; index <= chapter.paragraphCount; index += 1) {
    ids.push(`${chapter.chapterId}-p${String(index).padStart(width, '0')}`);
  }
  return ids;
}

function assembleBookText(
  manifest: TxtManifest,
  translations: ReadonlyMap<string, string>,
): { text: string; missing: string[]; extras: string[] } {
  const missing: string[] = [];
  const known = new Set(translations.keys());
  const blocks: string[] = [];
  for (const chapter of manifest.chapters) {
    const present: string[] = [];
    for (const id of expectedParagraphIds(chapter)) {
      const translation = translations.get(id);
      if (translation === undefined) {
        if (missing.length < 20) missing.push(id);
        continue;
      }
      present.push(translation);
      known.delete(id);
    }
    blocks.push(
      chapter.frontMatter
        ? present.join('\n\n')
        : `${chapter.title}\n\n${present.join('\n\n')}`,
    );
  }
  const extras = [...known].slice(0, 20);
  return { text: `${blocks.join('\n\n')}\n`, missing, extras };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function parseManifestFile(path: string): TxtManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new TxtSplitError(
      'invalid_manifest',
      `Cannot read TXT manifest "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(raw)) throw new TxtSplitError('invalid_manifest', 'TXT manifest must be an object.');
  if (raw['schemaVersion'] !== TXT_MANIFEST_SCHEMA_VERSION) {
    throw new TxtSplitError(
      'invalid_manifest',
      `Unsupported TXT manifest schemaVersion: ${String(raw['schemaVersion'])}`,
    );
  }
  const rawSource = raw['source'];
  if (!isRecord(rawSource) || typeof rawSource['sha256'] !== 'string') {
    throw new TxtSplitError('invalid_manifest', 'TXT manifest source identity is missing.');
  }
  const rawChapters = raw['chapters'];
  if (!Array.isArray(rawChapters)) {
    throw new TxtSplitError('invalid_manifest', 'TXT manifest chapters must be an array.');
  }
  const chapterIds = new Set<string>();
  rawChapters.forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new TxtSplitError('invalid_manifest', `TXT manifest chapter ${index} is invalid.`);
    }
    const chapterId = entry['chapterId'];
    if (typeof chapterId !== 'string' || chapterIds.has(chapterId)) {
      throw new TxtSplitError(
        'invalid_manifest',
        `TXT manifest chapter ${index} has an invalid or duplicate chapterId.`,
      );
    }
    chapterIds.add(chapterId);
    if (
      typeof entry['title'] !== 'string'
      || typeof entry['relativePath'] !== 'string'
      || !Number.isInteger(entry['paragraphCount'])
      || (entry['paragraphCount'] as number) < 0
      || entry['spineIndex'] !== index
    ) {
      throw new TxtSplitError('invalid_manifest', `TXT manifest chapter ${index} is invalid.`);
    }
  });
  return raw as unknown as TxtManifest;
}

/**
 * Deterministically assemble the final translated TXT from per-task
 * translation records. Coverage is a hard gate: every manifest paragraph must
 * have exactly one translation, in source order, or nothing is written.
 */
export async function assembleTxt(
  manifestPath: string,
  recordsDirectory: string,
  outputPath: string,
  options: AssembleTxtOptions = {},
): Promise<AssembleTxtResult> {
  const manifest = parseManifestFile(manifestPath);
  const output = resolve(outputPath);
  const outputStat = await stat(output).catch(() => null);
  if (outputStat !== null) {
    throw new TxtSplitError(
      'output_exists',
      `Output file already exists: ${output}. Assembly never overwrites previous output.`,
    );
  }
  const records = await collectRecords(resolve(recordsDirectory));
  const translations = new Map<string, string>();
  for (const record of records) {
    translations.set(record.paragraph_id, record.translation);
  }
  const { text, missing, extras } = assembleBookText(manifest, translations);
  if (missing.length > 0) {
    throw new TxtSplitError(
      'coverage_incomplete',
      `Assembly coverage is incomplete: ${String(missing.length)} paragraph(s) have no translation (e.g. ${missing.slice(0, 5).join(', ')}).`,
    );
  }
  if (extras.length > 0) {
    throw new TxtSplitError(
      'unknown_paragraphs',
      `Assembly found ${String(extras.length)} translation paragraph(s) not present in the manifest (e.g. ${extras.slice(0, 5).join(', ')}).`,
    );
  }
  const outputDirectory = dirname(output);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryPath = join(
    outputDirectory,
    `.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}.txt`,
  );
  try {
    await pipeline(Readable.from([text]), createWriteStream(temporaryPath, { flags: 'wx' }));
    await rename(temporaryPath, output);
  } catch (error) {
    await import('node:fs/promises').then((fs) => fs.rm(temporaryPath, { force: true })).catch(() => undefined);
    throw error;
  }
  void options;
  return {
    outputPath: output,
    chapterCount: manifest.chapters.length,
    paragraphCount: manifest.chapters.reduce((sum, chapter) => sum + chapter.paragraphCount, 0),
    sha256: await sha256File(output),
  };
}
