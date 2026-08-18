import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { readSourceReceipt, sha256Bytes } from './hash.js';
import { assertDestinationAbsent, writeImmutableBytes } from './immutable.js';
import { rebuildEpub } from './epub/rebuild.js';
import { renderTxtContents } from './txt.js';
import type { FinalArtifactReceipt, RenderSourceOptions, TranslationRecord } from './types.js';

export async function renderTranslationSource(options: RenderSourceOptions): Promise<FinalArtifactReceipt> {
  return options.manifest.format === 'epub' ? rebuildEpub(options) : rebuildTxt(options);
}

export async function rebuildTxt(options: RenderSourceOptions): Promise<FinalArtifactReceipt> {
  if (options.manifest.format !== 'txt') throw new Error('TXT renderer received a non-TXT manifest');
  const sourcePath = resolve(options.source_path);
  const outputPath = resolve(options.output_path);
  if (sourcePath === outputPath) throw new Error('Source TXT is immutable and cannot be the output destination');
  await assertDestinationAbsent(outputPath);
  validateProvenance(options);
  const sourceBefore = await readSourceReceipt(sourcePath, 'txt');
  if (sourceBefore.sha256 !== options.manifest.source.sha256) {
    throw new Error('Source TXT hash differs from book_manifest.json');
  }
  const records = validateTranslations(options, options.translations);
  const sourceBytes = await readFile(sourcePath);
  const outputBytes = renderTxtContents(sourceBytes, options.manifest, [...records.values()]);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(
      outputBytes[0] === 0xef && outputBytes[1] === 0xbb && outputBytes[2] === 0xbf
        ? outputBytes.subarray(3)
        : outputBytes,
    );
  } catch {
    throw new Error('Rendered TXT is not valid UTF-8');
  }
  const sourceAfter = await readSourceReceipt(sourcePath, 'txt');
  if (sourceAfter.sha256 !== sourceBefore.sha256) {
    throw new Error('Source TXT changed while rendering; output was not written');
  }
  await writeImmutableBytes(outputPath, outputBytes);
  const structuralValidation = {
    valid: true,
    checks: ['Source paragraph hashes matched', 'Rendered TXT is valid UTF-8', 'Source hash remained unchanged'],
    warnings: [],
    errors: [],
  } as const;
  return {
    schema_version: 1,
    artifact_type: 'txt',
    output_path: outputPath,
    source_path: sourcePath,
    source_sha256: sourceBefore.sha256,
    artifact_sha256: sha256Bytes(outputBytes),
    byte_length: outputBytes.byteLength,
    immutable: true,
    paragraph_count: options.manifest.paragraph_count,
    translated_paragraph_count: records.size,
    coverage: options.manifest.paragraph_count === 0 ? 1 : records.size / options.manifest.paragraph_count,
    structural_validation: structuralValidation,
    provenance: options.provenance,
    created_at: new Date().toISOString(),
  };
}

function validateTranslations(
  options: RenderSourceOptions,
  translations: readonly TranslationRecord[],
): Map<string, TranslationRecord> {
  const allowed = new Set(
    options.manifest.chapters.flatMap((chapter) => chapter.paragraphs.map((paragraph) => paragraph.paragraph_id)),
  );
  const records = new Map<string, TranslationRecord>();
  for (const record of translations) {
    if (!allowed.has(record.paragraph_id)) throw new Error(`Unknown paragraph translation: ${record.paragraph_id}`);
    if (records.has(record.paragraph_id)) throw new Error(`Duplicate paragraph translation: ${record.paragraph_id}`);
    if (!record.translation.trim()) throw new Error(`Empty paragraph translation: ${record.paragraph_id}`);
    records.set(record.paragraph_id, record);
  }
  if (options.require_complete_coverage !== false) {
    for (const paragraphId of allowed) {
      if (!records.has(paragraphId)) throw new Error(`Translation coverage is incomplete: ${paragraphId} is missing`);
    }
  }
  return records;
}

function validateProvenance(options: RenderSourceOptions): void {
  if (!options.provenance.project_id) throw new Error('Render provenance project_id is empty');
  if (!Number.isSafeInteger(options.provenance.instruction_version) || options.provenance.instruction_version < 0) {
    throw new Error('Render provenance instruction_version is invalid');
  }
  if (!/^[a-f0-9]{64}$/u.test(options.provenance.merge_receipt_hash)) {
    throw new Error('Render provenance merge_receipt_hash must be SHA-256');
  }
  if (!options.provenance.prompt_fingerprint || !options.provenance.context_hash || !options.provenance.model_fingerprint) {
    throw new Error('Render provenance fingerprints cannot be empty');
  }
}
