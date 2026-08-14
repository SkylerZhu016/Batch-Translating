import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Command } from 'commander';
import { ZipFile } from 'yazl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EPUB_MANIFEST_RELATIVE_PATH,
  inspectEpub,
  repackEpub,
  unpackEpub,
  validateEpub,
} from '#/cli/sub/translation/epub/archive';
import { registerTranslationCommand } from '#/cli/sub/translation/epub/command';
import { EpubArchiveError } from '#/cli/sub/translation/epub/types';

const MIMETYPE = Buffer.from('application/epub+zip', 'ascii');
const CONTAINER = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
);
const OPF = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:test-book</dc:identifier>
    <dc:title>Test Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="chapter-1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="styles/main.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="chapter-2"/>
    <itemref idref="chapter-1" linear="no"/>
  </spine>
</package>`,
);

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'kimi-epub-'));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('deterministic EPUB archive commands', () => {
  it('inspects container, OPF manifest, and spine in publication order', async () => {
    const source = join(temporaryDirectory, 'source.epub');
    process.stderr.write('fixture:start\n');
    await createEpub(source);
    process.stderr.write('fixture:done\n');

    process.stderr.write('inspect:start\n');
    const inspection = await inspectEpub(source, { verifyCrc: true });
    process.stderr.write('inspect:done\n');

    expect(inspection.valid).toBe(true);
    expect(inspection.mimetype).toEqual({
      firstEntry: true,
      stored: true,
      noExtraField: true,
      contentValid: true,
    });
    expect(inspection.container.selectedRootfile).toBe('OEBPS/content.opf');
    expect(inspection.package?.metadata).toMatchObject({
      title: 'Test Book',
      language: 'en',
      identifier: 'urn:uuid:test-book',
    });
    expect(inspection.package?.chapterMap.map((chapter) => chapter.path)).toEqual([
      'OEBPS/text/ch2.xhtml',
      'OEBPS/text/ch1.xhtml',
    ]);
    expect(inspection.package?.chapterMap.map((chapter) => chapter.linear)).toEqual([true, false]);
  });

  it('unpacks safely, preserves resources, repacks in order, and never mutates the source', async () => {
    const source = join(temporaryDirectory, 'source.epub');
    const unpacked = join(temporaryDirectory, 'unpacked');
    const output = join(temporaryDirectory, 'translated.epub');
    await createEpub(source);
    const sourceHashBefore = await sha256(source);

    const unpackResult = await unpackEpub(source, unpacked);
    expect(unpackResult.manifestPath).toBe(
      join(unpacked, ...EPUB_MANIFEST_RELATIVE_PATH.split('/')),
    );
    expect(await readFile(join(unpacked, 'OEBPS/styles/main.css'), 'utf8')).toContain('font-family');

    await writeFile(
      join(unpacked, 'OEBPS/text/ch1.xhtml'),
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>译文一</p></body></html>',
    );
    const repackResult = await repackEpub(unpacked, output);
    const validation = await validateEpub(output);
    const outputInspection = await inspectEpub(output);

    expect(repackResult.outputPath).toBe(output);
    expect(validation.valid).toBe(true);
    expect(outputInspection.entries.map((entry) => entry.path)).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/text/ch1.xhtml',
      'OEBPS/text/ch2.xhtml',
      'OEBPS/styles/main.css',
    ]);
    expect(await sha256(source)).toBe(sourceHashBefore);
  });

  it('rejects physical path traversal before extraction', async () => {
    const safeZip = join(temporaryDirectory, 'safe.epub');
    const unsafeZip = join(temporaryDirectory, 'unsafe.epub');
    await createEpub(safeZip, [{ path: 'safe/file', data: Buffer.from('unsafe placeholder') }]);
    const bytes = await readFile(safeZip);
    replaceAllAscii(bytes, 'safe/file', '../x/file');
    await writeFile(unsafeZip, bytes);

    const error = await inspectEpub(unsafeZip).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EpubArchiveError);
    expect(['unsafe_entry_path', 'invalid_zip']).toContain((error as EpubArchiveError).code);
    expect(await pathExists(join(temporaryDirectory, 'x/file'))).toBe(false);
  });

  it('reports a compressed mimetype entry as invalid', async () => {
    const source = join(temporaryDirectory, 'compressed-mimetype.epub');
    await createEpub(source, [], true);

    const inspection = await inspectEpub(source);

    expect(inspection.valid).toBe(false);
    expect(inspection.issues.map((issue) => issue.code)).toContain('mimetype_compressed');
  });

  it('refuses unexpected files, existing destinations, and source overwrite', async () => {
    const source = join(temporaryDirectory, 'source.epub');
    const unpacked = join(temporaryDirectory, 'unpacked');
    await createEpub(source);
    await unpackEpub(source, unpacked);

    await writeFile(join(unpacked, 'unexpected.txt'), 'must not silently disappear');
    await expect(repackEpub(unpacked, join(temporaryDirectory, 'output.epub'))).rejects.toMatchObject({
      code: 'unexpected_repack_resource',
    });
    await rm(join(unpacked, 'unexpected.txt'));

    await expect(repackEpub(unpacked, source)).rejects.toMatchObject({
      code: 'source_overwrite_refused',
    });
    const existing = join(temporaryDirectory, 'existing.epub');
    await writeFile(existing, 'existing');
    await expect(repackEpub(unpacked, existing)).rejects.toMatchObject({
      code: 'destination_exists',
    });
  });

  it('registers a hidden translation EPUB CLI and emits JSON', async () => {
    const source = join(temporaryDirectory, 'source.epub');
    await createEpub(source);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command('kimi');
    registerTranslationCommand(program, {
      stdout: { write: (chunk) => (stdout.push(chunk), true) },
      stderr: { write: (chunk) => (stderr.push(chunk), true) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'kimi', 'translation', 'epub', 'validate', source]);

    expect(stderr).toEqual([]);
    expect(exitCodes).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ valid: true, chapterCount: 2 });
    expect(program.helpInformation()).not.toContain('translation');
  });
});

async function createEpub(
  path: string,
  extraEntries: readonly { path: string; data: Buffer }[] = [],
  compressMimetype = false,
): Promise<void> {
  const zip = new ZipFile();
  const mtime = new Date('2020-01-02T03:04:06.000Z');
  zip.addBuffer(MIMETYPE, 'mimetype', { compress: compressMimetype, mtime });
  zip.addBuffer(CONTAINER, 'META-INF/container.xml', { mtime });
  zip.addBuffer(OPF, 'OEBPS/content.opf', { mtime });
  zip.addBuffer(Buffer.from('<html><body><p>One</p></body></html>'), 'OEBPS/text/ch1.xhtml', {
    mtime,
  });
  zip.addBuffer(Buffer.from('<html><body><p>Two</p></body></html>'), 'OEBPS/text/ch2.xhtml', {
    mtime,
  });
  zip.addBuffer(Buffer.from('body { font-family: serif; }'), 'OEBPS/styles/main.css', { mtime });
  for (const entry of extraEntries) zip.addBuffer(entry.data, entry.path, { mtime });
  const writing = pipeline(
    zip.outputStream as unknown as Readable,
    createWriteStream(path, { flags: 'wx' }),
  );
  zip.end();
  await writing;
}

function replaceAllAscii(buffer: Buffer, from: string, to: string): void {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const needle = Buffer.from(from, 'ascii');
  const replacement = Buffer.from(to, 'ascii');
  let offset = 0;
  let replacements = 0;
  while ((offset = buffer.indexOf(needle, offset)) !== -1) {
    replacement.copy(buffer, offset);
    offset += replacement.length;
    replacements += 1;
  }
  expect(replacements).toBeGreaterThanOrEqual(2);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
