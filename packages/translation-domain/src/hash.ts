import { createHash } from 'node:crypto';

import type { TaskIdentityInput } from './types.ts';

function encodeCanonical(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot encode a non-finite number');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'));
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
  }
  if (stack.has(value)) throw new TypeError('Canonical JSON cannot encode cyclic values');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => encodeCanonical(entry, stack)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON only accepts plain objects');
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key], stack)}`);
    return `{${entries.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, new Set<object>());
}

export function sha256Text(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function computeTaskIdempotencyKey(input: TaskIdentityInput): string {
  return hashCanonical({
    project_id: input.projectId,
    task_type: input.taskType,
    scope_hash: input.scopeHash,
    prompt_version: input.promptVersion,
    instruction_version: input.instructionVersion,
    context_hash: input.contextHash,
    model_id: input.modelId,
    decoding_config_hash: input.decodingConfigHash,
  });
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
