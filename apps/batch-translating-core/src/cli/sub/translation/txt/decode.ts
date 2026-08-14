import { TxtSplitError, type TxtEncoding, type TxtNewline } from './types';

export interface DecodedText {
  readonly encoding: TxtEncoding;
  readonly newline: TxtNewline;
  /** Source text with BOM stripped and line endings normalized to '\n'. */
  readonly text: string;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

function detectEncoding(buffer: Buffer): { encoding: TxtEncoding; bomLength: number } {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) {
    return { encoding: 'utf-8', bomLength: 3 };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(UTF16LE_BOM)) {
    return { encoding: 'utf-16le', bomLength: 2 };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(UTF16BE_BOM)) {
    return { encoding: 'utf-16be', bomLength: 2 };
  }
  return { encoding: 'utf-8', bomLength: 0 };
}

function decodeWithFatal(encoding: string, buffer: Buffer): string {
  return new TextDecoder(encoding, { fatal: true }).decode(buffer);
}

function detectNewline(text: string): TxtNewline {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  // Count within the first 64 KiB; long preambles are irrelevant here.
  const probe = text.slice(0, 64 * 1024);
  for (let index = 0; index < probe.length; index += 1) {
    const code = probe.charCodeAt(index);
    if (code === 0x0d) {
      if (probe.charCodeAt(index + 1) === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (code === 0x0a) {
      lf += 1;
    }
  }
  const kinds = [crlf > 0 ? 1 : 0, lf > 0 ? 1 : 0, cr > 0 ? 1 : 0].reduce(
    (sum, value) => sum + value,
    0,
  );
  if (kinds > 1) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (cr > 0) return 'cr';
  return 'lf';
}

/**
 * Deterministically decode a plain-text book file. BOM wins; otherwise the
 * content must be strict UTF-8, and anything that is not strict UTF-8 is
 * decoded as GB18030 (the GBK superset that maps nearly every byte sequence,
 * so the fallback never silently produces replacement characters from valid
 * Chinese legacy encodings). Line endings are normalized to '\n'.
 */
export function decodeText(buffer: Buffer): DecodedText {
  if (buffer.length === 0) {
    return { encoding: 'utf-8', newline: 'lf', text: '' };
  }
  const { encoding, bomLength } = detectEncoding(buffer);
  const body = buffer.subarray(bomLength);
  let text: string;
  if (encoding === 'utf-16le') {
    text = decodeWithFatal('utf-16le', body);
  } else if (encoding === 'utf-16be') {
    text = decodeWithFatal('utf-16be', body);
  } else {
    try {
      text = decodeWithFatal('utf-8', body);
    } catch {
      text = new TextDecoder('gb18030').decode(body);
      return normalizeText(text, 'gb18030');
    }
  }
  return normalizeText(text, encoding);
}

function normalizeText(text: string, encoding: TxtEncoding): DecodedText {
  const newline = detectNewline(text);
  // \r\n and lone \r both become \n; \n stays as-is.
  const normalized = text.replace(/\r\n?/g, '\n');
  return { encoding, newline, text: normalized };
}

export function compileChapterPattern(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new TxtSplitError('empty_pattern', 'Chapter pattern cannot be empty.');
  }
  let source = trimmed;
  if (!source.startsWith('^')) source = `^(?:${source})`;
  try {
    return new RegExp(source, 'i');
  } catch (error) {
    throw new TxtSplitError(
      'invalid_pattern',
      `Chapter pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function isChapterHeadingLine(regex: RegExp, trimmedLine: string): boolean {
  if (!trimmedLine) return false;
  return regex.test(trimmedLine);
}
