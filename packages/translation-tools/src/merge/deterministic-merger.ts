import { canonicalJson, compareStrings, hashCanonicalJson, sha256Bytes } from '../hash.js';
import type {
  MergeArtifact,
  MergeConflict,
  MergeGate,
  MergeInput,
  MergeResult,
  MergeTaskSnapshot,
  RepairPatch,
  TranslationRecord,
} from '../types.js';

export class MergeValidationError extends Error {
  readonly conflicts: readonly MergeConflict[];
  readonly violations: readonly string[];

  constructor(message: string, violations: readonly string[], conflicts: readonly MergeConflict[] = []) {
    super(message);
    this.name = 'MergeValidationError';
    this.violations = violations;
    this.conflicts = conflicts;
  }
}

/**
 * The sole authority that may combine immutable worker artifacts. It validates
 * the full provenance gate before constructing an in-memory result and never
 * mutates a shared document or artifact.
 */
export class DeterministicMerger {
  merge(input: MergeInput): MergeResult {
    const violations: string[] = [];
    const conflicts: MergeConflict[] = [];
    validateGate(input.gate, violations);
    const paragraphIds = new Set(input.gate.paragraph_ids);
    const tasksById = uniqueBy(input.tasks, (task) => task.task_id, 'task', violations);
    const artifactsById = uniqueBy(input.artifacts, (artifact) => artifact.artifact_id, 'artifact', violations);
    const artifacts = [...artifactsById.values()].sort((left, right) => compareStrings(left.artifact_id, right.artifact_id));

    for (const artifact of artifacts) {
      validateArtifact(artifact, tasksById.get(artifact.task_id), input.gate, violations);
    }
    if (violations.length > 0) {
      throw new MergeValidationError('Artifact provenance gate rejected the merge', violations);
    }

    const records = new Map<string, { record: TranslationRecord; artifactId: string }>();
    for (const artifact of artifacts) {
      if (artifact.payload.kind !== 'translation') continue;
      const seenInArtifact = new Set<string>();
      for (const record of artifact.payload.records) {
        if (!paragraphIds.has(record.paragraph_id)) {
          violations.push(`Artifact ${artifact.artifact_id} references unknown paragraph ${record.paragraph_id}`);
          continue;
        }
        if (seenInArtifact.has(record.paragraph_id)) {
          violations.push(`Artifact ${artifact.artifact_id} repeats paragraph ${record.paragraph_id}`);
          continue;
        }
        seenInArtifact.add(record.paragraph_id);
        validateTranslationRecord(record, artifact.artifact_id, violations);
        const existing = records.get(record.paragraph_id);
        if (!existing) {
          records.set(record.paragraph_id, { record: normalizeRecord(record), artifactId: artifact.artifact_id });
          continue;
        }
        if (canonicalJson(existing.record) !== canonicalJson(normalizeRecord(record))) {
          conflicts.push({
            paragraph_id: record.paragraph_id,
            artifact_ids: [existing.artifactId, artifact.artifact_id].sort(),
            reason: 'Multiple translation artifacts produced different values',
          });
        }
      }
    }

    const patchesByParagraph = collectPatches(artifacts, paragraphIds, violations);
    for (const [paragraphId, candidates] of [...patchesByParagraph.entries()].sort(([left], [right]) =>
      compareStrings(left, right),
    )) {
      const base = records.get(paragraphId);
      if (!base) {
        violations.push(`Repair patch targets untranslated paragraph ${paragraphId}`);
        continue;
      }
      const selected = selectPatch(paragraphId, candidates, conflicts, violations);
      if (!selected) continue;
      if (validatePatch(base.record, selected.patch, selected.artifactId, violations)) {
        records.set(paragraphId, {
          artifactId: selected.artifactId,
          record: normalizeRecord({
            paragraph_id: paragraphId,
            translation: selected.patch.new_translation,
            ...(selected.patch.segment_translations
              ? { segment_translations: selected.patch.segment_translations }
              : base.record.segment_translations
                ? { segment_translations: base.record.segment_translations }
                : {}),
          }),
        });
      }
    }

    if (input.gate.require_complete_coverage !== false) {
      for (const paragraphId of input.gate.paragraph_ids) {
        if (!records.has(paragraphId)) violations.push(`Missing translation for ${paragraphId}`);
      }
    }
    if (conflicts.length > 0 || violations.length > 0) {
      throw new MergeValidationError('Deterministic merge rejected invalid or conflicting artifacts', violations, conflicts);
    }

    const orderedRecords = input.gate.paragraph_ids
      .map((paragraphId) => records.get(paragraphId)?.record)
      .filter((record): record is TranslationRecord => record !== undefined);
    const artifactIds = artifacts.map((artifact) => artifact.artifact_id);
    const mergedAt = artifacts
      .map((artifact) => artifact.created_at)
      .sort()
      .at(-1) ?? new Date(0).toISOString();
    return {
      records: orderedRecords,
      receipt: {
        schema_version: 1,
        project_id: input.gate.project_id,
        merged_at: mergedAt,
        gate_fingerprint: hashCanonicalJson({
          ...input.gate,
          source_hashes: [...input.gate.source_hashes].sort(compareStrings),
        }),
        artifact_ids: artifactIds,
        translation_count: orderedRecords.length,
        translations_hash: hashCanonicalJson(orderedRecords),
      },
    };
  }
}

export function mergeTranslationArtifacts(input: MergeInput): MergeResult {
  return new DeterministicMerger().merge(input);
}

function validateGate(gate: MergeGate, violations: string[]): void {
  if (!gate.project_id) violations.push('Merge gate project_id is empty');
  if (!gate.prompt_version) violations.push('Merge gate prompt_version is empty');
  if (!gate.prompt_fingerprint) violations.push('Merge gate prompt_fingerprint is empty');
  if (!Number.isSafeInteger(gate.instruction_version) || gate.instruction_version < 0) {
    violations.push('Merge gate instruction_version is invalid');
  }
  if (!gate.context_hash) violations.push('Merge gate context_hash is empty');
  if (!gate.model_id) violations.push('Merge gate model_id is empty');
  if (!gate.model_fingerprint) violations.push('Merge gate model_fingerprint is empty');
  const paragraphIds = new Set<string>();
  for (const paragraphId of gate.paragraph_ids) {
    if (!paragraphId) violations.push('Merge gate contains an empty paragraph ID');
    if (paragraphIds.has(paragraphId)) violations.push(`Merge gate repeats paragraph ${paragraphId}`);
    paragraphIds.add(paragraphId);
  }
  validateHashRecord(gate.source_hashes, 'merge gate', violations);
}

function validateArtifact(
  artifact: MergeArtifact,
  task: MergeTaskSnapshot | undefined,
  gate: MergeGate,
  violations: string[],
): void {
  const prefix = `Artifact ${artifact.artifact_id}`;
  if (!task) {
    violations.push(`${prefix} has no ledger task ${artifact.task_id}`);
    return;
  }
  if (task.state !== 'SUCCEEDED') violations.push(`${prefix} task is ${task.state}, not SUCCEEDED`);
  if (artifact.stale === true || task.state === 'STALE') violations.push(`${prefix} is stale`);
  compare(`${prefix} project`, artifact.project_id, gate.project_id, violations);
  compare(`${prefix} task project`, task.project_id, gate.project_id, violations);
  compare(`${prefix} prompt version`, artifact.prompt_version, gate.prompt_version, violations);
  compare(`${prefix} prompt fingerprint`, artifact.prompt_fingerprint, gate.prompt_fingerprint, violations);
  compare(`${prefix} instruction version`, artifact.instruction_version, gate.instruction_version, violations);
  compare(`${prefix} context hash`, artifact.context_hash, gate.context_hash, violations);
  compare(`${prefix} model id`, artifact.model_id, gate.model_id, violations);
  compare(`${prefix} model fingerprint`, artifact.model_fingerprint, gate.model_fingerprint, violations);
  compare(`${prefix} source hashes`, canonicalHashes(artifact.source_hashes), canonicalHashes(gate.source_hashes), violations);
  compare(`${prefix} payload hash`, artifact.payload_hash, hashCanonicalJson(artifact.payload), violations);

  compare(`${prefix} task prompt version`, task.prompt_version, artifact.prompt_version, violations);
  compare(`${prefix} task prompt fingerprint`, task.prompt_fingerprint, artifact.prompt_fingerprint, violations);
  compare(`${prefix} task instruction version`, task.instruction_version, artifact.instruction_version, violations);
  compare(`${prefix} task context hash`, task.context_hash, artifact.context_hash, violations);
  compare(`${prefix} task model id`, task.model_id, artifact.model_id, violations);
  compare(`${prefix} task model fingerprint`, task.model_fingerprint, artifact.model_fingerprint, violations);
  compare(`${prefix} task source hashes`, canonicalHashes(task.source_hashes), canonicalHashes(artifact.source_hashes), violations);
  validateHashRecord(artifact.source_hashes, prefix, violations);
  if (!Number.isFinite(Date.parse(artifact.created_at))) violations.push(`${prefix} created_at is invalid`);
}

function collectPatches(
  artifacts: readonly MergeArtifact[],
  paragraphIds: ReadonlySet<string>,
  violations: string[],
): Map<string, Array<{ patch: RepairPatch; artifactId: string; arbitration: boolean }>> {
  const result = new Map<string, Array<{ patch: RepairPatch; artifactId: string; arbitration: boolean }>>();
  for (const artifact of artifacts) {
    if (artifact.payload.kind === 'translation') continue;
    const seen = new Set<string>();
    for (const patch of artifact.payload.patches) {
      if (!paragraphIds.has(patch.paragraph_id)) {
        violations.push(`Artifact ${artifact.artifact_id} patch references unknown paragraph ${patch.paragraph_id}`);
        continue;
      }
      if (seen.has(patch.paragraph_id)) {
        violations.push(`Artifact ${artifact.artifact_id} repeats a patch for ${patch.paragraph_id}`);
        continue;
      }
      seen.add(patch.paragraph_id);
      if (!patch.issue_id) violations.push(`Artifact ${artifact.artifact_id} patch has no issue_id`);
      if (!patch.reason) violations.push(`Artifact ${artifact.artifact_id} patch has no reason`);
      if (sha256Bytes(patch.old_translation) !== patch.old_translation_hash) {
        violations.push(`Artifact ${artifact.artifact_id} patch old_translation_hash is invalid`);
      }
      const candidates = result.get(patch.paragraph_id) ?? [];
      candidates.push({ patch, artifactId: artifact.artifact_id, arbitration: artifact.payload.kind === 'arbitration' });
      result.set(patch.paragraph_id, candidates);
    }
  }
  return result;
}

function selectPatch(
  paragraphId: string,
  candidates: Array<{ patch: RepairPatch; artifactId: string; arbitration: boolean }>,
  conflicts: MergeConflict[],
  violations: string[],
): { patch: RepairPatch; artifactId: string; arbitration: boolean } | undefined {
  const unique = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    unique.set(canonicalJson(candidate.patch), candidate);
  }
  const values = [...unique.values()].sort((left, right) => compareStrings(left.artifactId, right.artifactId));
  if (values.length === 1) return values[0];
  const arbitrations = values.filter((candidate) => candidate.arbitration);
  const ordinary = values.filter((candidate) => !candidate.arbitration);
  if (arbitrations.length === 1) {
    const arbitration = arbitrations[0];
    if (!arbitration) return undefined;
    const declared = new Set(arbitration.patch.conflict_set ?? []);
    const unresolved = ordinary.filter(
      (candidate) => !declared.has(candidate.artifactId) && !declared.has(candidate.patch.issue_id),
    );
    if (unresolved.length === 0 && ordinary.length > 0) return arbitration;
    violations.push(`Arbitration patch for ${paragraphId} does not declare every conflicting patch`);
  }
  conflicts.push({
    paragraph_id: paragraphId,
    artifact_ids: values.map((candidate) => candidate.artifactId),
    reason: arbitrations.length > 1 ? 'Multiple arbitration patches exist' : 'Repair patches conflict without arbitration',
  });
  return undefined;
}

function validatePatch(
  current: TranslationRecord,
  patch: RepairPatch,
  artifactId: string,
  violations: string[],
): boolean {
  let valid = true;
  if (current.translation !== patch.old_translation) {
    violations.push(`Artifact ${artifactId} patch old_translation does not match ${patch.paragraph_id}`);
    valid = false;
  }
  if (sha256Bytes(current.translation) !== patch.old_translation_hash) {
    violations.push(`Artifact ${artifactId} patch rejected: old_translation_hash conflict on ${patch.paragraph_id}`);
    valid = false;
  }
  if (!patch.new_translation.trim()) {
    violations.push(`Artifact ${artifactId} patch produces an empty translation for ${patch.paragraph_id}`);
    valid = false;
  }
  return valid;
}

function validateTranslationRecord(record: TranslationRecord, artifactId: string, violations: string[]): void {
  if (!record.translation.trim()) {
    violations.push(`Artifact ${artifactId} has an empty translation for ${record.paragraph_id}`);
  }
  if (record.segment_translations) {
    for (const [segmentId, translation] of Object.entries(record.segment_translations)) {
      if (!segmentId) violations.push(`Artifact ${artifactId} has an empty segment ID`);
      if (typeof translation !== 'string') violations.push(`Artifact ${artifactId} segment ${segmentId} is not text`);
    }
  }
}

function normalizeRecord(record: TranslationRecord): TranslationRecord {
  return {
    paragraph_id: record.paragraph_id,
    translation: record.translation,
    ...(record.segment_translations
      ? { segment_translations: Object.fromEntries(Object.entries(record.segment_translations).sort(([a], [b]) => compareStrings(a, b))) }
      : {}),
  };
}

function validateHashRecord(value: readonly string[], label: string, violations: string[]): void {
  if (value.length === 0) violations.push(`${label} has no source hashes`);
  if (new Set(value).size !== value.length) violations.push(`${label} repeats a source hash`);
  for (const hash of value) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) violations.push(`${label} has invalid source SHA-256`);
  }
}

function canonicalHashes(value: readonly string[]): string {
  return canonicalJson([...value].sort(compareStrings));
}

function compare(label: string, actual: unknown, expected: unknown, violations: string[]): void {
  if (actual !== expected) violations.push(`${label} mismatch`);
}

function uniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
  violations: string[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (!key) {
      violations.push(`Merge contains ${label} with empty ID`);
      continue;
    }
    if (result.has(key)) {
      violations.push(`Merge contains duplicate ${label} ${key}`);
      continue;
    }
    result.set(key, value);
  }
  return result;
}
