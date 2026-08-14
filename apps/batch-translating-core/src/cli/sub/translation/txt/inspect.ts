import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { decodeText } from './decode';
import { defaultChapterPattern, splitChapters } from './split';
import {
  MAX_TXT_SOURCE_BYTES,
  TxtSplitError,
  type TxtIssue,
  type ValidateTxtResult,
} from './types';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface InspectTxtChapter {
  readonly chapterId: string;
  readonly title: string;
  readonly spineIndex: number;
  readonly paragraphCount: number;
  readonly frontMatter: boolean;
  readonly startLine: number;
  readonly endLine: number;
}

export interface InspectTxtResult extends ValidateTxtResult {
  readonly encoding: ValidateTxtResult['encoding'];
  readonly chapterPattern: string;
  readonly chapters: readonly InspectTxtChapter[];
}

/**
 * Read, decode and split a TXT in memory without writing anything. Used by the
 * `inspect` and `validate` commands; `valid` is false when no readable chapter
 * content exists.
 */
export async function inspectTxt(sourcePath: string): Promise<InspectTxtResult> {
  const source = resolve(sourcePath);
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
  const buffer = await readFile(source);
  const decoded = decodeText(buffer);
  const pattern = defaultChapterPattern();
  const drafts = splitChapters(decoded.text, pattern);
  const issues: TxtIssue[] = [];
  if (decoded.encoding !== 'utf-8') {
    issues.push({
      severity: 'warning',
      code: 'legacy_encoding',
      message: `Source decoded as ${decoded.encoding}; re-encoded chapters are UTF-8.`,
    });
  }
  if (decoded.newline === 'mixed') {
    issues.push({
      severity: 'warning',
      code: 'mixed_newlines',
      message: 'Source mixes CRLF and LF line endings; chapters are normalized to LF.',
    });
  }
  const firstChapter = drafts[0];
  if (drafts.length === 1 && firstChapter?.frontMatter === true) {
    issues.push({
      severity: 'warning',
      code: 'no_chapter_headings',
      message: 'No chapter heading matched; the whole file is treated as one front-matter chapter.',
    });
  }
  drafts.forEach((draft, index) => {
    if (draft.paragraphs.length === 0) {
      issues.push({
        severity: 'warning',
        code: 'empty_chapter',
        message: `Chapter "${draft.title}" contains no paragraphs.`,
        line: draft.startLine + 1,
      });
    }
  });
  const width = String(drafts.length).length;
  const chapters: InspectTxtChapter[] = drafts.map((draft, index) => ({
    chapterId: draft.frontMatter ? 'ch000' : `ch${String(index).padStart(Math.max(3, width), '0')}`,
    title: draft.title,
    spineIndex: index,
    paragraphCount: draft.paragraphs.length,
    frontMatter: draft.frontMatter,
    startLine: draft.startLine + 1,
    endLine: draft.endLine + 1,
  }));
  return {
    valid: chapters.length > 0,
    path: source,
    sha256: await sha256File(source),
    encoding: decoded.encoding,
    chapterCount: chapters.length,
    paragraphCount: chapters.reduce((sum, chapter) => sum + chapter.paragraphCount, 0),
    issues,
    chapterPattern: pattern,
    chapters,
  };
}
