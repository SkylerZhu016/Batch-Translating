export const TXT_MANIFEST_SCHEMA_VERSION = 1;
export const TXT_MANIFEST_RELATIVE_PATH = '.batch-translating/txt-manifest.json';
export const TXT_CHAPTERS_RELATIVE_DIR = 'chapters';

/**
 * Default chapter-heading pattern. A heading is a line whose trimmed content
 * starts with either `第X章` (X = arabic, full-width arabic or Chinese
 * numerals; unit may be 章/节/回/卷/部/篇) or `Chapter N` (N = arabic or
 * roman numerals, case-insensitive). Everything after the matched prefix on
 * the same line becomes part of the chapter title.
 */
export const DEFAULT_TXT_CHAPTER_PATTERN =
  '^(?:第[0-9０-９零〇一二三四五六七八九十百千万亿]+[章节回卷部篇]|Chapter\\s+[0-9IVXLCDM]+)';

export const MAX_TXT_SOURCE_BYTES = 512 * 1024 * 1024;

export type TxtEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export type TxtNewline = 'lf' | 'crlf' | 'cr' | 'mixed';

export interface TxtSourceIdentity {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly encoding: TxtEncoding;
  readonly newline: TxtNewline;
}

export interface TxtChapterEntry {
  readonly chapterId: string;
  readonly title: string;
  readonly spineIndex: number;
  /** Relative path of the canonical per-chapter text inside the output directory. */
  readonly relativePath: string;
  readonly paragraphCount: number;
  readonly charCount: number;
  /** 1-based line range in the normalized source text. */
  readonly startLine: number;
  readonly endLine: number;
  /** True for the text before the first detected chapter heading. */
  readonly frontMatter: boolean;
}

export interface TxtManifest {
  readonly schemaVersion: typeof TXT_MANIFEST_SCHEMA_VERSION;
  readonly source: TxtSourceIdentity;
  /** The effective chapter-heading pattern (the one actually applied). */
  readonly chapterPattern: string;
  readonly chapters: readonly TxtChapterEntry[];
}

export interface SplitTxtOptions {
  readonly pattern?: string;
  readonly manifestPath?: string;
}

export interface SplitTxtResult {
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly chapterCount: number;
  readonly paragraphCount: number;
  readonly sourceSha256: string;
}

export interface AssembleTxtOptions {
  readonly manifestPath?: string;
}

export interface AssembleTxtResult {
  readonly outputPath: string;
  readonly chapterCount: number;
  readonly paragraphCount: number;
  readonly sha256: string;
}

export interface TxtIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly line?: number;
}

export interface ValidateTxtResult {
  readonly valid: boolean;
  readonly path: string;
  readonly sha256: string;
  readonly encoding: TxtEncoding;
  readonly chapterCount: number;
  readonly paragraphCount: number;
  readonly issues: readonly TxtIssue[];
}

export class TxtSplitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TxtSplitError';
  }
}
