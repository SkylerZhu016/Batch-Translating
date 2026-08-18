import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { SourceFormat, SourceReceipt } from './types.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function sha256Bytes(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical JSON cannot encode a non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

export async function readSourceReceipt(sourcePath: string, format?: SourceFormat): Promise<SourceReceipt> {
  const absolutePath = resolve(sourcePath);
  const before = await stat(absolutePath);
  if (!before.isFile()) {
    throw new Error(`Source is not a regular file: ${absolutePath}`);
  }
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(absolutePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    byteLength += bytes.byteLength;
  }
  const after = await stat(absolutePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || byteLength !== after.size) {
    throw new Error(`Source changed while hashing: ${absolutePath}`);
  }
  const detected = format ?? detectSourceFormat(absolutePath);
  return {
    source_path: absolutePath,
    format: detected,
    sha256: hash.digest('hex'),
    byte_length: byteLength,
    modified_at_ms: after.mtimeMs,
  };
}

export function detectSourceFormat(sourcePath: string): SourceFormat {
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith('.epub')) return 'epub';
  if (lower.endsWith('.txt')) return 'txt';
  throw new Error(`Unsupported translation source: ${sourcePath}`);
}
