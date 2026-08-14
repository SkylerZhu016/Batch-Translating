import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { compileChapterPattern, decodeText, isChapterHeadingLine } from './decode';
import {
  MAX_TXT_SOURCE_BYTES,
  TXT_CHAPTERS_RELATIVE_DIR,
  TXT_MANIFEST_RELATIVE_PATH,
  TXT_MANIFEST_SCHEMA_VERSION,
  TxtSplitError,
  type SplitTxtOptions,
  type SplitTxtResult,
  type TxtChapterEntry,
  type TxtManifest,
} from './types';

export function defaultChapterPattern(): string {
  return '^(?:第[0-9０-９零〇一二三四五六七八九十百千万亿]+[章节回卷部篇]|Chapter\\s+[0-9IVXLCDM]+)';
}

interface ParagraphRange {
  readonly startLine: number;
  readonly endLine: number;
}

interface ChapterDraft {
  readonly title: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly frontMatter: boolean;
  readonly paragraphs: ParagraphRange[];
}

/**
 * Split normalized source text (already decoded, '\n' endings) into chapters.
 * A heading line is detected by the chapter pattern applied to the trimmed
 * line; the heading line itself is the first line of its chapter. Text before
 * the first heading becomes a front-matter chapter when it contains any
 * non-empty line. Paragraphs are maximal runs of consecutive non-empty lines,
 * so blank lines are the only paragraph separator.
 */
export function splitChapters(
  text: string,
  pattern: string,
): readonly ChapterDraft[] {
  const regex = compileChapterPattern(pattern);
  const lines = text.split('\n');
  const chapters: ChapterDraft[] = [];
  let current: ChapterDraft | null = null;
  let paragraphStart = -1;
  const frontMatterParagraphs: ParagraphRange[] = [];

  const closeParagraph = (endLine: number): void => {
    if (paragraphStart < 0) return;
    if (current !== null) {
      current.paragraphs.push({ startLine: paragraphStart, endLine });
    } else {
      frontMatterParagraphs.push({ startLine: paragraphStart, endLine });
    }
    paragraphStart = -1;
  };

  const pushFrontMatterChapter = (endLine: number): void => {
    closeParagraph(endLine);
    if (frontMatterParagraphs.length === 0) return;
    const first = frontMatterParagraphs[0]!;
    chapters.push({
      title: lines[first.startLine]!.trim() || '<front matter>',
      startLine: first.startLine,
      endLine,
      frontMatter: true,
      paragraphs: [...frontMatterParagraphs],
    });
    frontMatterParagraphs.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (isChapterHeadingLine(regex, trimmed)) {
      if (current === null) {
        pushFrontMatterChapter(index - 1);
      } else {
        closeParagraph(index - 1);
        chapters.push({ ...current, endLine: index - 1 });
      }
      current = {
        title: trimmed,
        startLine: index,
        endLine: index,
        frontMatter: false,
        paragraphs: [],
      };
      continue;
    }
    if (trimmed.length > 0) {
      if (paragraphStart < 0) paragraphStart = index;
    } else {
      closeParagraph(index - 1);
    }
  }
  closeParagraph(lines.length - 1);
  if (current !== null) {
    chapters.push({ ...current, endLine: lines.length - 1 });
  } else {
    pushFrontMatterChapter(lines.length - 1);
  }
  if (chapters.length === 0) {
    throw new TxtSplitError(
      'no_content',
      'The file contains no readable chapter content after decoding.',
    );
  }
  return chapters;
}

function canonicalChapterText(lines: readonly string[], chapter: ChapterDraft): string {
  const paragraphs = chapter.paragraphs.map((paragraph) => {
    const paragraphLines: string[] = [];
    for (let index = paragraph.startLine; index <= paragraph.endLine; index += 1) {
      const line = lines[index]!;
      if (line.trim().length > 0) paragraphLines.push(line.trim());
    }
    return paragraphLines.join('\n');
  });
  if (chapter.frontMatter) {
    // The front-matter title is already the first line of the first paragraph;
    // emitting it again would duplicate content.
    return `${paragraphs.join('\n\n')}\n`;
  }
  return `${[chapter.title, ...paragraphs].join('\n\n')}\n`;
}

function paragraphId(chapterId: string, index: number, width: number): string {
  return `${chapterId}-p${String(index).padStart(width, '0')}`;
}

function paragraphIdWidth(chapterCount: number): number {
  return Math.max(4, String(chapterCount).length);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function splitTxt(
  sourcePath: string,
  outputDirectory: string,
  options: SplitTxtOptions = {},
): Promise<SplitTxtResult> {
  const source = resolve(sourcePath);
  const output = resolve(outputDirectory);
  const sourceStat = await stat(source).catch((error: unknown) => {
    throw new TxtSplitError(
      'source_unreadable',
      `Cannot read TXT source "${source}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  if (!sourceStat.isFile()) {
    throw new TxtSplitError('source_not_file', `TXT source is not a regular file: ${source}`);
  }
  if (sourceStat.size > MAX_TXT_SOURCE_BYTES) {
    throw new TxtSplitError(
      'source_too_large',
      `TXT source exceeds the ${String(MAX_TXT_SOURCE_BYTES)} byte safety limit.`,
    );
  }
  if (output === source) {
    throw new TxtSplitError('output_is_source', 'Output directory must not equal the source file.');
  }
  const outputStat = await lstat(output).catch(() => null);
  if (outputStat !== null) {
    throw new TxtSplitError(
      'output_exists',
      `Output directory already exists: ${output}. Splitting never overwrites previous output.`,
    );
  }
  if (source.startsWith(`${output}${output.includes('\\') ? '\\' : '/'}`)) {
    throw new TxtSplitError('source_inside_output', 'Source file must not live inside the output directory.');
  }

  const buffer = await readFile(source);
  const decoded = decodeText(buffer);
  const pattern = options.pattern?.trim() || defaultChapterPattern();
  const chapters = splitChapters(decoded.text, pattern);

  const chapterDirectory = join(output, TXT_CHAPTERS_RELATIVE_DIR);
  await mkdir(chapterDirectory, { recursive: true });
  const width = String(chapters.length).length;
  const lines = decoded.text.split('\n');
  const entries: TxtChapterEntry[] = [];

  let paragraphCount = 0;
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index]!;
    const chapterId = chapter.frontMatter
      ? 'ch000'
      : `ch${String(index).padStart(Math.max(3, width), '0')}`;
    const fileName = `${chapterId}.txt`;
    const content = canonicalChapterText(lines, chapter);
    await writeFile(join(chapterDirectory, fileName), content, 'utf8');
    entries.push({
      chapterId,
      title: chapter.title,
      spineIndex: index,
      relativePath: `${TXT_CHAPTERS_RELATIVE_DIR}/${fileName}`,
      paragraphCount: chapter.paragraphs.length,
      charCount: content.length,
      startLine: chapter.startLine + 1,
      endLine: chapter.endLine + 1,
      frontMatter: chapter.frontMatter,
    });
    paragraphCount += chapter.paragraphs.length;
  }

  const manifestPath = options.manifestPath
    ? resolve(options.manifestPath)
    : join(output, TXT_MANIFEST_RELATIVE_PATH);
  const manifest: TxtManifest = {
    schemaVersion: TXT_MANIFEST_SCHEMA_VERSION,
    source: {
      path: source,
      sizeBytes: sourceStat.size,
      sha256: await sha256File(source),
      encoding: decoded.encoding,
      newline: decoded.newline,
    },
    chapterPattern: pattern,
    chapters: entries,
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    outputDirectory: output,
    manifestPath,
    chapterCount: entries.length,
    paragraphCount,
    sourceSha256: manifest.source.sha256,
  };
}

export function paragraphIdsOf(chapter: TxtChapterEntry): string[] {
  const width = paragraphIdWidth(chapter.paragraphCount);
  const ids: string[] = [];
  for (let index = 1; index <= chapter.paragraphCount; index += 1) {
    ids.push(paragraphId(chapter.chapterId, index, width));
  }
  return ids;
}

export function paragraphIdPatternOf(chapter: TxtChapterEntry): RegExp {
  return new RegExp(`^${escapeRegExp(chapter.chapterId)}-p\\d+$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
