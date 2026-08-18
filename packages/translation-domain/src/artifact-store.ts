import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson, sha256Text } from './hash.ts';
import type { ArtifactEnvelope } from './types.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function assertSafeId(label: string, value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} contains unsafe path characters`);
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`Artifact path escapes its configured root: ${candidate}`);
  }
}

export interface ArtifactWriteResult {
  filePath: string;
  envelopeHash: string;
  existed: boolean;
}

export class ImmutableArtifactStore {
  readonly rootPath: string;

  constructor(rootPath: string) {
    if (!rootPath.trim()) throw new Error('artifact root path is required');
    this.rootPath = resolve(rootPath);
    mkdirSync(this.rootPath, { recursive: true });
  }

  pathFor(taskId: string, attemptId: string): string {
    assertSafeId('taskId', taskId);
    assertSafeId('attemptId', attemptId);
    const filePath = resolve(this.rootPath, 'artifacts', taskId, `${attemptId}.json`);
    assertInside(this.rootPath, filePath);
    return filePath;
  }

  write<T>(envelope: ArtifactEnvelope<T>): ArtifactWriteResult {
    const filePath = this.pathFor(envelope.taskId, envelope.attemptId);
    const serialized = `${canonicalJson(envelope)}\n`;
    const envelopeHash = sha256Text(serialized);
    mkdirSync(resolve(filePath, '..'), { recursive: true });

    if (existsSync(filePath)) {
      const existingHash = sha256Text(readFileSync(filePath));
      if (existingHash !== envelopeHash) {
        throw new Error(`Immutable artifact already exists with different content: ${filePath}`);
      }
      return { filePath, envelopeHash, existed: true };
    }

    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, serialized, { encoding: 'utf8' });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporary, filePath);
      } catch (error) {
        if (!existsSync(filePath) || sha256Text(readFileSync(filePath)) !== envelopeHash) throw error;
        return { filePath, envelopeHash, existed: true };
      }
      try {
        chmodSync(filePath, 0o444);
      } catch {
        // Read-only permissions are best-effort on Windows; atomic no-overwrite is enforced by linkSync.
      }
      return { filePath, envelopeHash, existed: false };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }

  read<T = unknown>(taskId: string, attemptId: string): ArtifactEnvelope<T> {
    const filePath = this.pathFor(taskId, attemptId);
    return JSON.parse(readFileSync(filePath, 'utf8')) as ArtifactEnvelope<T>;
  }

  verify(filePath: string, expectedHash: string): boolean {
    const absolute = resolve(filePath);
    assertInside(this.rootPath, absolute);
    return existsSync(absolute) && sha256Text(readFileSync(absolute)) === expectedHash;
  }
}
