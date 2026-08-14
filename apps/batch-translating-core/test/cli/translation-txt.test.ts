import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleTxt } from '#/cli/sub/translation/txt/assemble';
import { registerTranslationCommand } from '#/cli/sub/translation/index';
import { decodeText } from '#/cli/sub/translation/txt/decode';
import { inspectTxt } from '#/cli/sub/translation/txt/inspect';
import { splitTxt } from '#/cli/sub/translation/txt/split';
import { TxtSplitError } from '#/cli/sub/translation/txt/types';

const BOOK = [
  'The Example Novel',
  'by Test Author',
  '',
  'Chapter 1',
  'It was a dark and stormy night.',
  '',
  'The rain fell without end.',
  '',
  'Chapter 2',
  'Morning came at last.',
  '',
  '第3章 转折',
  '此刻，风暴已经过去。',
  '',
  '他推开门，看见阳光。',
  '',
  'CHAPTER IV',
  'The sun burned through the clouds.',
].join('\n');

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'kimi-txt-'));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('TXT decoding', () => {
  it('detects UTF-8 BOM, UTF-16LE BOM, and GB18030 without BOM', () => {
    const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好\n', 'utf8')]);
    expect(decodeText(utf8Bom)).toMatchObject({ encoding: 'utf-8', text: '你好\n' });

    const utf16le = Buffer.from('你好\r\n世界', 'utf16le');
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]);
    expect(decodeText(withBom)).toMatchObject({ encoding: 'utf-16le', text: '你好\n世界' });

    // '你好\n世界' as GB18030 bytes (Buffer has no gb18030 encoder).
    const gb18030 = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xca, 0xc0, 0xbd, 0xe7]);
    expect(decodeText(gb18030)).toMatchObject({ encoding: 'gb18030', text: '你好\n世界' });
  });

  it('normalizes CRLF and lone CR to LF and reports the newline style', () => {
    expect(decodeText(Buffer.from('a\r\nb\r\nc', 'utf8'))).toMatchObject({
      encoding: 'utf-8',
      newline: 'crlf',
      text: 'a\nb\nc',
    });
    expect(decodeText(Buffer.from('a\rb\rc', 'utf8'))).toMatchObject({
      encoding: 'utf-8',
      newline: 'cr',
      text: 'a\nb\nc',
    });
  });
});

describe('deterministic TXT chapter splitting', () => {
  it('splits on Chapter N and 第X章 headings and keeps front matter', async () => {
    const source = join(temporaryDirectory, 'book.txt');
    const output = join(temporaryDirectory, 'split');
    await writeFile(source, BOOK, 'utf8');
    const sourceHash = await sha256(source);

    const result = await splitTxt(source, output);

    expect(result.chapterCount).toBe(5);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.source.sha256).toBe(sourceHash);
    expect(manifest.source.encoding).toBe('utf-8');
    expect(manifest.chapters.map((chapter: { chapterId: string; title: string }) => [chapter.chapterId, chapter.title])).toEqual([
      ['ch000', 'The Example Novel'],
      ['ch001', 'Chapter 1'],
      ['ch002', 'Chapter 2'],
      ['ch003', '第3章 转折'],
      ['ch004', 'CHAPTER IV'],
    ]);
    expect(manifest.chapters.map((chapter: { paragraphCount: number }) => chapter.paragraphCount)).toEqual([1, 2, 1, 2, 1]);

    const chapterFiles = await readdir(join(output, 'chapters'));
    expect(chapterFiles).toEqual(['ch000.txt', 'ch001.txt', 'ch002.txt', 'ch003.txt', 'ch004.txt']);
    expect(await readFile(join(output, 'chapters/ch003.txt'), 'utf8')).toBe(
      '第3章 转折\n\n此刻，风暴已经过去。\n\n他推开门，看见阳光。\n',
    );
    expect(await sha256(source)).toBe(sourceHash);
  });

  it('is fully deterministic across runs', async () => {
    const source = join(temporaryDirectory, 'book.txt');
    await writeFile(source, BOOK, 'utf8');
    const first = await splitTxt(source, join(temporaryDirectory, 'split-1'));
    const second = await splitTxt(source, join(temporaryDirectory, 'split-2'));

    expect(JSON.parse(await readFile(first.manifestPath, 'utf8'))).toEqual(
      JSON.parse(await readFile(second.manifestPath, 'utf8')),
    );
    for (const name of ['ch000.txt', 'ch001.txt', 'ch002.txt', 'ch003.txt', 'ch004.txt']) {
      expect(await readFile(join(temporaryDirectory, 'split-1/chapters', name), 'utf8')).toBe(
        await readFile(join(temporaryDirectory, 'split-2/chapters', name), 'utf8'),
      );
    }
  });

  it('refuses existing output directories and source-overwrite shapes', async () => {
    const source = join(temporaryDirectory, 'book.txt');
    await writeFile(source, BOOK, 'utf8');
    await splitTxt(source, join(temporaryDirectory, 'split'));

    await expect(splitTxt(source, join(temporaryDirectory, 'split'))).rejects.toMatchObject({
      code: 'output_exists',
    });
    await expect(splitTxt(source, source)).rejects.toMatchObject({
      code: 'output_is_source',
    });
  });

  it('supports a custom chapter pattern override', async () => {
    const source = join(temporaryDirectory, 'custom.txt');
    const output = join(temporaryDirectory, 'custom-split');
    await writeFile(
      source,
      ['Prologue text.', '', '### Part One', 'Body one.', '', '### Part Two', 'Body two.'].join('\n'),
      'utf8',
    );

    const result = await splitTxt(source, output, { pattern: '^### ' });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.chapterPattern).toBe('^###');
    expect(manifest.chapters.map((chapter: { title: string }) => chapter.title)).toEqual([
      'Prologue text.',
      '### Part One',
      '### Part Two',
    ]);
    expect(manifest.chapters[0].frontMatter).toBe(true);
  });

  it('rejects an invalid pattern with a clear error', async () => {
    const source = join(temporaryDirectory, 'book.txt');
    await writeFile(source, BOOK, 'utf8');
    await expect(
      splitTxt(source, join(temporaryDirectory, 'bad'), { pattern: '(' }),
    ).rejects.toMatchObject({ code: 'invalid_pattern' });
  });
});

describe('TXT inspect and validate', () => {
  it('inspects without writing and warns when no heading matches', async () => {
    const plain = join(temporaryDirectory, 'plain.txt');
    await writeFile(plain, ['Only a story.', '', 'With two paragraphs.'].join('\n'), 'utf8');

    const inspection = await inspectTxt(plain);
    expect(inspection.valid).toBe(true);
    expect(inspection.chapterCount).toBe(1);
    expect(inspection.chapters[0]?.frontMatter).toBe(true);
    expect(inspection.issues.map((issue) => issue.code)).toContain('no_chapter_headings');
  });
});

describe('deterministic TXT assembly', () => {
  async function splitBook(): Promise<{ source: string; manifestPath: string }> {
    const source = join(temporaryDirectory, 'book.txt');
    await writeFile(source, BOOK, 'utf8');
    const result = await splitTxt(source, join(temporaryDirectory, 'split'));
    return { source, manifestPath: result.manifestPath };
  }

  async function writeRecords(directory: string, lines: string[]): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'records.jsonl'), lines.join('\n'), 'utf8');
  }

  function record(chapter: string, paragraphs: readonly { id: number; text: string }[]): string {
    return JSON.stringify({
      task_id: `task-${chapter}`,
      status: 'ok',
      paragraphs: paragraphs.map(({ id, text }) => ({
        paragraph_id: `${chapter}-p${String(id).padStart(4, '0')}`,
        source: 'source text',
        translation: text,
      })),
    });
  }

  it('assembles a complete translated TXT in source order with full coverage', async () => {
    const { manifestPath } = await splitBook();
    const recordsDir = join(temporaryDirectory, 'records');
    await writeRecords(recordsDir, [
      record('ch000', [{ id: 1, text: '示例小说' }]),
      record('ch001', [
        { id: 1, text: '那是一个漆黑而狂风暴雨的夜晚。' },
        { id: 2, text: '雨下个不停。' },
      ]),
      record('ch002', [{ id: 1, text: '黎明终于来临。' }]),
      record('ch003', [
        { id: 1, text: '此刻，风暴已经过去。' },
        { id: 2, text: '他推开门，看见阳光。' },
      ]),
      record('ch004', [{ id: 1, text: '阳光穿透了云层。' }]),
    ]);
    const output = join(temporaryDirectory, 'translated.txt');

    const result = await assembleTxt(manifestPath, recordsDir, output);

    expect(result.chapterCount).toBe(5);
    expect(result.paragraphCount).toBe(7);
    expect(await readFile(output, 'utf8')).toBe([
      '示例小说',
      '',
      'Chapter 1',
      '',
      '那是一个漆黑而狂风暴雨的夜晚。',
      '',
      '雨下个不停。',
      '',
      'Chapter 2',
      '',
      '黎明终于来临。',
      '',
      '第3章 转折',
      '',
      '此刻，风暴已经过去。',
      '',
      '他推开门，看见阳光。',
      '',
      'CHAPTER IV',
      '',
      '阳光穿透了云层。',
      '',
    ].join('\n'));
    expect(result.sha256).toBe(await sha256(output));
  });

  it('refuses to assemble with missing, extra, or conflicting translations', async () => {
    const { manifestPath } = await splitBook();
    const recordsDir = join(temporaryDirectory, 'records');
    await mkdir(recordsDir, { recursive: true });

    await writeFile(join(recordsDir, 'partial.jsonl'), record('ch000', [{ id: 1, text: '示例小说' }]), 'utf8');
    await expect(
      assembleTxt(manifestPath, recordsDir, join(temporaryDirectory, 'out-1.txt')),
    ).rejects.toMatchObject({ code: 'coverage_incomplete' });

    // Complete coverage plus a phantom chapter: the unknown paragraph is caught.
    await writeFile(
      join(recordsDir, 'rest.jsonl'),
      [
        record('ch001', [
          { id: 1, text: '那是一个漆黑而狂风暴雨的夜晚。' },
          { id: 2, text: '雨下个不停。' },
        ]),
        record('ch002', [{ id: 1, text: '黎明终于来临。' }]),
        record('ch003', [
          { id: 1, text: '此刻，风暴已经过去。' },
          { id: 2, text: '他推开门，看见阳光。' },
        ]),
        record('ch004', [{ id: 1, text: '阳光穿透了云层。' }]),
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(recordsDir, 'phantom.jsonl'),
      record('ch999', [{ id: 1, text: '幽灵段落' }]),
      'utf8',
    );
    await expect(
      assembleTxt(manifestPath, recordsDir, join(temporaryDirectory, 'out-2.txt')),
    ).rejects.toMatchObject({ code: 'unknown_paragraphs' });

    // Conflicting translations for one paragraph are detected during collection.
    await rm(join(recordsDir, 'phantom.jsonl'));
    await writeFile(
      join(recordsDir, 'conflict.jsonl'),
      record('ch004', [{ id: 1, text: '阳光穿透了云层。' }]),
      'utf8',
    );
    await writeFile(
      join(recordsDir, 'conflict-2.jsonl'),
      record('ch004', [{ id: 1, text: '阳光刺破云层。' }]),
      'utf8',
    );
    await expect(
      assembleTxt(manifestPath, recordsDir, join(temporaryDirectory, 'out-3.txt')),
    ).rejects.toMatchObject({ code: 'duplicate_paragraph_translation' });
  });

  it('never overwrites an existing output file', async () => {
    const { manifestPath } = await splitBook();
    const output = join(temporaryDirectory, 'existing.txt');
    await writeFile(output, 'existing', 'utf8');
    await expect(assembleTxt(manifestPath, temporaryDirectory, output)).rejects.toMatchObject({
      code: 'output_exists',
    });
  });
});

describe('TXT CLI registration', () => {
  it('registers hidden translation txt commands and emits JSON', async () => {
    const source = join(temporaryDirectory, 'book.txt');
    await writeFile(source, BOOK, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command('kimi');
    registerTranslationCommand(program, {
      stdout: { write: (chunk) => (stdout.push(chunk), true) },
      stderr: { write: (chunk) => (stderr.push(chunk), true) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'kimi', 'translation', 'txt', 'validate', source]);

    expect(stderr).toEqual([]);
    expect(exitCodes).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ valid: true, chapterCount: 5 });
    expect(program.helpInformation()).not.toContain('translation');
  });
});

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
