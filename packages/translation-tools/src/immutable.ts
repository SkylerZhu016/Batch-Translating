import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { canonicalJson, hashCanonicalJson } from './hash.js';
import type { MergeArtifact } from './types.js';

export async function assertDestinationAbsent(destinationPath: string): Promise<void> {
  try {
    await access(resolve(destinationPath), constants.F_OK);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`Immutable destination already exists: ${resolve(destinationPath)}`);
}

export async function writeImmutableBytes(destinationPath: string, bytes: Uint8Array): Promise<void> {
  const destination = resolve(destinationPath);
  await mkdir(dirname(destination), { recursive: true });
  await assertDestinationAbsent(destination);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Hard-link publication is atomic and, unlike POSIX rename, cannot replace
    // a destination created by another process after the initial check.
    await link(temporary, destination);
    await rm(temporary, { force: true }).catch(() => undefined);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeImmutableJson(destinationPath: string, value: unknown): Promise<string> {
  const serialized = `${canonicalJson(value)}\n`;
  await writeImmutableBytes(destinationPath, Buffer.from(serialized, 'utf8'));
  return hashCanonicalJson(value);
}

export async function writeImmutableArtifact(destinationPath: string, artifact: MergeArtifact): Promise<void> {
  const actualPayloadHash = hashCanonicalJson(artifact.payload);
  if (artifact.payload_hash !== actualPayloadHash) {
    throw new Error(
      `Artifact ${artifact.artifact_id} payload hash mismatch: expected ${artifact.payload_hash}, got ${actualPayloadHash}`,
    );
  }
  await writeImmutableJson(destinationPath, artifact);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
