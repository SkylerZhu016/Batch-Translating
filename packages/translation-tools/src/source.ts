import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { detectSourceFormat, readSourceReceipt } from './hash.js';
import { writeImmutableJson } from './immutable.js';
import { parseEpubSource } from './epub/parse.js';
import { parseTxtSource } from './txt.js';
import type { BookManifest, CopiedSourceReceipt, ParsedSource } from './types.js';

export async function parseTranslationSource(sourcePath: string): Promise<ParsedSource> {
  return detectSourceFormat(sourcePath) === 'epub' ? parseEpubSource(sourcePath) : parseTxtSource(sourcePath);
}

export async function copySourceImmutable(
  sourcePath: string,
  destinationPath: string,
  expectedSha256?: string,
): Promise<CopiedSourceReceipt> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source.toLowerCase() === destination.toLowerCase()) {
    throw new Error('Source snapshot destination must differ from the original source');
  }
  const receipt = await readSourceReceipt(source);
  if (expectedSha256 && receipt.sha256 !== expectedSha256) {
    throw new Error(`Source hash mismatch: expected ${expectedSha256}, got ${receipt.sha256}`);
  }
  const beforeCopy = await stat(source);
  await mkdir(dirname(destination), { recursive: true });
  const copyHasher = createHash('sha256');
  let copiedBytes = 0;
  const hashTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      copyHasher.update(chunk);
      copiedBytes += chunk.byteLength;
      callback(null, chunk);
    },
  });
  let copiedHash = '';
  const destinationHandle = await open(destination, 'wx', 0o600);
  try {
    await pipeline(
      createReadStream(source),
      hashTransform,
      createWriteStream(destination, { fd: destinationHandle.fd, autoClose: false }),
    );
    await destinationHandle.sync();
    await destinationHandle.close();
    copiedHash = copyHasher.digest('hex');
    const [afterCopy, sourceAfter, destinationInfo] = await Promise.all([
      stat(source),
      readSourceReceipt(source),
      stat(destination),
    ]);
    if (
      beforeCopy.size !== afterCopy.size ||
      beforeCopy.mtimeMs !== afterCopy.mtimeMs ||
      sourceAfter.sha256 !== receipt.sha256
    ) {
      throw new Error('Source changed while creating its immutable copy');
    }
    if (
      copiedHash !== receipt.sha256 ||
      copiedBytes !== receipt.byte_length ||
      destinationInfo.size !== receipt.byte_length
    ) {
      throw new Error('Immutable source copy failed its streaming hash/size check');
    }
    await chmod(destination, 0o444);
  } catch (error) {
    await destinationHandle.close().catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    original: receipt,
    copied_path: destination,
    copied_sha256: copiedHash,
    byte_length: copiedBytes,
    immutable: true,
  };
}

export async function writeBookManifest(outputPath: string, manifest: BookManifest): Promise<string> {
  const actualParagraphs = manifest.chapters.reduce((total, chapter) => total + chapter.paragraphs.length, 0);
  if (actualParagraphs !== manifest.paragraph_count) {
    throw new Error(`Book manifest paragraph_count mismatch: ${manifest.paragraph_count} vs ${actualParagraphs}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.source.sha256)) throw new Error('Book manifest source SHA-256 is invalid');
  return await writeImmutableJson(outputPath, manifest);
}
