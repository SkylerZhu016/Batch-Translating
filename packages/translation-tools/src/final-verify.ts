import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { readSourceReceipt } from './hash.js';
import type { FinalArtifactReceipt, StructuralValidationResult } from './types.js';
import { validateEpubStructure } from './epub/validate.js';

export async function verifyFinalArtifactReceipt(
  receipt: FinalArtifactReceipt,
): Promise<StructuralValidationResult> {
  const checks: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const outputPath = resolve(receipt.output_path);
    const sourcePath = resolve(receipt.source_path);
    if (outputPath !== receipt.output_path) errors.push('Final artifact receipt output_path is not absolute');
    if (sourcePath !== receipt.source_path) errors.push('Final artifact receipt source_path is not absolute');
    if (outputPath.toLowerCase() === sourcePath.toLowerCase()) errors.push('Final artifact overwrites its source');
    if (!outputPath.toLowerCase().endsWith(`.${receipt.artifact_type}`)) {
      errors.push(`Final artifact extension does not match ${receipt.artifact_type}`);
    }
    const [output, source] = await Promise.all([
      readSourceReceipt(outputPath, receipt.artifact_type),
      readSourceReceipt(sourcePath, receipt.artifact_type),
    ]);
    if (output.sha256 !== receipt.artifact_sha256) errors.push('Final artifact byte hash differs from its receipt');
    if (output.byte_length !== receipt.byte_length) errors.push('Final artifact byte length differs from its receipt');
    if (source.sha256 !== receipt.source_sha256) errors.push('Source byte hash differs from the final receipt');
    if (receipt.immutable !== true) errors.push('Final artifact receipt is not marked immutable');
    if (receipt.translated_paragraph_count > receipt.paragraph_count) {
      errors.push('Final artifact translated paragraph count exceeds total paragraphs');
    }
    const expectedCoverage = receipt.paragraph_count === 0 ? 1 : receipt.translated_paragraph_count / receipt.paragraph_count;
    if (Math.abs(expectedCoverage - receipt.coverage) > Number.EPSILON) {
      errors.push('Final artifact coverage does not match its paragraph counts');
    }
    if (errors.length === 0) checks.push('Final/source byte hashes, sizes, paths, and coverage match the receipt');
    if (receipt.artifact_type === 'epub') {
      const structure = await validateEpubStructure(await readFile(outputPath));
      checks.push(...structure.checks);
      warnings.push(...structure.warnings);
      errors.push(...structure.errors);
    } else {
      const bytes = await readFile(outputPath);
      const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
      new TextDecoder('utf-8', { fatal: true }).decode(body);
      checks.push('Final TXT is valid UTF-8');
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { valid: errors.length === 0, checks, warnings, errors };
}

export async function assertFinalArtifactReceipt(receipt: FinalArtifactReceipt): Promise<StructuralValidationResult> {
  const result = await verifyFinalArtifactReceipt(receipt);
  if (!result.valid) throw new Error(`Final artifact receipt verification failed: ${result.errors.join('; ')}`);
  return result;
}
