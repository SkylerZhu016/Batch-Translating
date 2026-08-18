import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { readSourceReceipt, sha256Bytes } from './hash.js';
import type { BookManifest, ParsedSource, TranslationRecord } from './types.js';

export async function parseTxtSource(sourcePath: string): Promise<ParsedSource> {
  const absolutePath = resolve(sourcePath);
  const [bytes, source] = await Promise.all([
    readFile(absolutePath),
    readSourceReceipt(absolutePath, 'txt'),
  ]);
  if (sha256Bytes(bytes) !== source.sha256) throw new Error('Source TXT changed while it was being parsed');
  const { text } = decodeUtf8Text(bytes);
  const paragraphMatches = locateTextParagraphs(text);
  const chapterId = 'ch001';
  const paragraphs = paragraphMatches.map((match, index) => {
    const paragraphId = `${chapterId}-p${String(index + 1).padStart(4, '0')}`;
    return {
      paragraph_id: paragraphId,
      chapter_id: chapterId,
      ordinal: index + 1,
      source_start: match.start,
      source_end: match.end,
      source_text: match.text,
      source_hash: sha256Bytes(match.text),
      segments: [
        {
          segment_id: `${paragraphId}-s001`,
          node_path: [],
          source_text: match.text,
          source_hash: sha256Bytes(match.text),
          protected_markup: false,
        },
      ],
    };
  });
  const manifest: BookManifest = {
    schema_version: 1,
    format: 'txt',
    source,
    book_id: `book_${source.sha256.slice(0, 32)}`,
    created_at: new Date(source.modified_at_ms).toISOString(),
    metadata: {},
    resources: [],
    reading_order: ['source.txt'],
    chapters: [
      {
        chapter_id: chapterId,
        ordinal: 1,
        source_path: 'source.txt',
        linear: true,
        media_type: 'text/plain',
        paragraphs,
      },
    ],
    paragraph_count: paragraphs.length,
    source_word_count: countWords(paragraphs.map((paragraph) => paragraph.source_text).join('\n')),
  };
  return { manifest };
}

export function renderTxtContents(
  sourceBytes: Uint8Array,
  manifest: BookManifest,
  translations: readonly TranslationRecord[],
): Uint8Array {
  if (manifest.format !== 'txt') throw new Error('TXT renderer received a non-TXT manifest');
  const decoded = decodeUtf8Text(sourceBytes);
  const translationsById = new Map(translations.map((record) => [record.paragraph_id, record]));
  const paragraphs = manifest.chapters.flatMap((chapter) => chapter.paragraphs);
  let cursor = 0;
  let rendered = '';
  for (const paragraph of paragraphs) {
    if (paragraph.source_start === undefined || paragraph.source_end === undefined) {
      throw new Error(`TXT paragraph ${paragraph.paragraph_id} has no source range`);
    }
    if (paragraph.source_start < cursor || paragraph.source_end < paragraph.source_start) {
      throw new Error(`TXT paragraph ${paragraph.paragraph_id} has an invalid source range`);
    }
    const currentSource = decoded.text.slice(paragraph.source_start, paragraph.source_end);
    if (sha256Bytes(currentSource) !== paragraph.source_hash) {
      throw new Error(`TXT paragraph ${paragraph.paragraph_id} source hash changed`);
    }
    rendered += decoded.text.slice(cursor, paragraph.source_start);
    rendered += translationsById.get(paragraph.paragraph_id)?.translation ?? currentSource;
    cursor = paragraph.source_end;
  }
  rendered += decoded.text.slice(cursor);
  const encoded = Buffer.from(rendered, 'utf8');
  return decoded.hadBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]) : encoded;
}

function decodeUtf8Text(bytes: Uint8Array): { text: string; hadBom: boolean } {
  const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hadBom ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), hadBom };
  } catch {
    throw new Error('TXT source must be valid UTF-8');
  }
}

function locateTextParagraphs(text: string): Array<{ start: number; end: number; text: string }> {
  const result: Array<{ start: number; end: number; text: string }> = [];
  const addRegion = (start: number, end: number): void => {
    let trimmedStart = start;
    let trimmedEnd = end;
    while (trimmedStart < trimmedEnd && /\s/u.test(text[trimmedStart] ?? '')) trimmedStart += 1;
    while (trimmedEnd > trimmedStart && /\s/u.test(text[trimmedEnd - 1] ?? '')) trimmedEnd -= 1;
    if (trimmedStart < trimmedEnd) {
      result.push({ start: trimmedStart, end: trimmedEnd, text: text.slice(trimmedStart, trimmedEnd) });
    }
  };
  let regionStart = 0;
  const separators = /(?:\r?\n[\t ]*){2,}|\f/gu;
  for (const match of text.matchAll(separators)) {
    if (match.index === undefined) continue;
    addRegion(regionStart, match.index);
    regionStart = match.index + match[0].length;
  }
  addRegion(regionStart, text.length);
  return result;
}

function countWords(value: string): number {
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
  return Array.from(segmenter.segment(value)).filter((segment) => segment.isWordLike).length;
}
