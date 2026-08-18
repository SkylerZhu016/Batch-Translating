import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import JSZip from 'jszip';

import { readSourceReceipt, sha256Bytes } from '../hash.js';
import { assertDestinationAbsent, writeImmutableBytes } from '../immutable.js';
import type {
  BookManifest,
  FinalArtifactReceipt,
  RenderSourceOptions,
  StructuralValidationResult,
  TranslationRecord,
} from '../types.js';
import { parseXml, resolveNodePath, type DomElement, type DomNode } from '../xml.js';
import { runEpubcheck } from './epubcheck.js';
import { validateEpubStructure, validateResourcePreservation } from './validate.js';

export async function rebuildEpub(options: RenderSourceOptions): Promise<FinalArtifactReceipt> {
  if (options.manifest.format !== 'epub') throw new Error('EPUB renderer received a non-EPUB manifest');
  const sourcePath = resolve(options.source_path);
  const outputPath = resolve(options.output_path);
  if (sourcePath === outputPath) throw new Error('Source EPUB is immutable and cannot be the output destination');
  await assertDestinationAbsent(outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  validateProvenance(options);
  const sourceReceipt = await readSourceReceipt(sourcePath, 'epub');
  if (sourceReceipt.sha256 !== options.manifest.source.sha256) {
    throw new Error('Source EPUB hash differs from book_manifest.json');
  }
  const sourceBytes = await readFile(sourcePath);
  const recordsById = validateTranslationCoverage(options.manifest, options.translations, options.require_complete_coverage);
  const { bytes: renderedBytes, modifiedPaths } = await rebuildEpubBytes(
    sourceBytes,
    options.manifest,
    recordsById,
  );
  const [structure, preservation] = await Promise.all([
    validateEpubStructure(renderedBytes),
    validateResourcePreservation(sourceBytes, renderedBytes, modifiedPaths),
  ]);
  const structuralValidation = combineValidation(structure, preservation);
  if (!structuralValidation.valid) {
    throw new Error(`Rebuilt EPUB failed structural validation: ${structuralValidation.errors.join('; ')}`);
  }

  const epubcheck = await runEpubcheckOnBytes(renderedBytes, outputPath, options.epubcheck_path);
  if (
    options.require_epubcheck === true &&
    (epubcheck.status === 'unavailable' || epubcheck.status === 'timed_out' || epubcheck.status === 'failed')
  ) {
    throw new Error(`epubcheck is required but returned ${epubcheck.status}: ${epubcheck.output}`);
  }
  if (epubcheck.status === 'failed') {
    throw new Error(`epubcheck rejected the rebuilt EPUB: ${epubcheck.output}`);
  }

  const sourceAfterBuild = await readSourceReceipt(sourcePath, 'epub');
  if (sourceAfterBuild.sha256 !== sourceReceipt.sha256) {
    throw new Error('Source EPUB changed while rendering; output was not written');
  }
  await writeImmutableBytes(outputPath, renderedBytes);
  const artifactHash = sha256Bytes(renderedBytes);
  const translatedCount = recordsById.size;
  return {
    schema_version: 1,
    artifact_type: 'epub',
    output_path: outputPath,
    source_path: sourcePath,
    source_sha256: sourceReceipt.sha256,
    artifact_sha256: artifactHash,
    byte_length: renderedBytes.byteLength,
    immutable: true,
    paragraph_count: options.manifest.paragraph_count,
    translated_paragraph_count: translatedCount,
    coverage: coverage(translatedCount, options.manifest.paragraph_count),
    structural_validation: structuralValidation,
    epubcheck,
    provenance: options.provenance,
    created_at: new Date().toISOString(),
  };
}

export async function rebuildEpubBytes(
  sourceBytes: Uint8Array,
  manifest: BookManifest,
  recordsById: ReadonlyMap<string, TranslationRecord>,
): Promise<{ bytes: Uint8Array; modifiedPaths: ReadonlySet<string> }> {
  const source = await JSZip.loadAsync(sourceBytes, { checkCRC32: true, createFolders: false });
  const modified = new Map<string, Uint8Array>();
  for (const chapter of manifest.chapters) {
    const records = chapter.paragraphs
      .map((paragraph) => recordsById.get(paragraph.paragraph_id))
      .filter((record): record is TranslationRecord => record !== undefined);
    if (records.length === 0) continue;
    const entry = source.file(chapter.source_path);
    if (!entry) throw new Error(`Source EPUB chapter is missing: ${chapter.source_path}`);
    const markup = await entry.async('string');
    const document = parseXml(markup, chapter.source_path);
    const paragraphsById = new Map(chapter.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph]));
    for (const record of records) {
      const paragraph = paragraphsById.get(record.paragraph_id);
      if (!paragraph?.element_path) throw new Error(`Paragraph ${record.paragraph_id} has no XHTML locator`);
      const element = resolveNodePath(document.documentElement, paragraph.element_path);
      if (!element || element.nodeType !== 1) throw new Error(`Paragraph locator is stale: ${record.paragraph_id}`);
      applyParagraphTranslation(element as DomElement, paragraph, record);
    }
    modified.set(chapter.source_path, Buffer.from(document.toString(), 'utf8'));
  }

  const output = new JSZip();
  const mimetype = source.file('mimetype');
  if (!mimetype) throw new Error('Source EPUB has no mimetype entry');
  output.file('mimetype', await mimetype.async('nodebuffer'), {
    date: mimetype.date,
    compression: 'STORE',
    createFolders: false,
  });
  for (const entry of Object.values(source.files)) {
    if (entry.dir || entry.name === 'mimetype') continue;
    const bytes = modified.get(entry.name) ?? (await entry.async('nodebuffer'));
    output.file(entry.name, bytes, {
      date: entry.date,
      createFolders: false,
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
      ...(entry.comment ? { comment: entry.comment } : {}),
      ...(entry.unixPermissions === null ? {} : { unixPermissions: entry.unixPermissions }),
      ...(entry.dosPermissions === null ? {} : { dosPermissions: entry.dosPermissions }),
    });
  }
  const bytes = await output.generateAsync({
    type: 'uint8array',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  return { bytes, modifiedPaths: new Set(modified.keys()) };
}

function applyParagraphTranslation(
  element: DomElement,
  paragraph: BookManifest['chapters'][number]['paragraphs'][number],
  record: TranslationRecord,
): void {
  const nodes = new Map<string, { node: DomNode; protectedMarkup: boolean }>();
  for (const segment of paragraph.segments) {
    const node = resolveNodePath(element, segment.node_path);
    if (!node || node.nodeType !== 3) throw new Error(`Text segment locator is stale: ${segment.segment_id}`);
    if (sha256Bytes(node.nodeValue ?? '') !== segment.source_hash) {
      throw new Error(`Source text changed for segment ${segment.segment_id}`);
    }
    nodes.set(segment.segment_id, { node, protectedMarkup: segment.protected_markup });
  }
  if (nodes.size === 0) throw new Error(`Paragraph ${record.paragraph_id} has no translatable text nodes`);
  if (record.segment_translations) {
    for (const segmentId of Object.keys(record.segment_translations)) {
      if (!nodes.has(segmentId)) throw new Error(`Translation references unknown segment ${segmentId}`);
    }
    for (const [segmentId, translation] of Object.entries(record.segment_translations)) {
      const target = nodes.get(segmentId);
      if (!target) continue;
      target.node.nodeValue = withOriginalBoundaryWhitespace(target.node.nodeValue ?? '', translation);
    }
    return;
  }

  const ordinary = [...nodes.values()].filter((value) => !value.protectedMarkup);
  const targets = ordinary.length > 0 ? ordinary : [...nodes.values()];
  const first = targets[0];
  if (!first) throw new Error(`Paragraph ${record.paragraph_id} has no render target`);
  first.node.nodeValue = withOriginalBoundaryWhitespace(first.node.nodeValue ?? '', record.translation);
  for (const remaining of targets.slice(1)) {
    remaining.node.nodeValue = withOriginalBoundaryWhitespace(remaining.node.nodeValue ?? '', '');
  }
}

function withOriginalBoundaryWhitespace(original: string, replacement: string): string {
  const leading = original.match(/^\s*/u)?.[0] ?? '';
  const trailing = original.match(/\s*$/u)?.[0] ?? '';
  return `${leading}${replacement}${trailing}`;
}

async function runEpubcheckOnBytes(
  bytes: Uint8Array,
  outputPath: string,
  executable?: string,
): Promise<Awaited<ReturnType<typeof runEpubcheck>>> {
  const temporary = resolve(dirname(outputPath), `.epubcheck-${process.pid}-${randomUUID()}.epub`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.close();
    handle = undefined;
    return await runEpubcheck(temporary, executable);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function validateTranslationCoverage(
  manifest: BookManifest,
  translations: readonly TranslationRecord[],
  requireComplete = true,
): Map<string, TranslationRecord> {
  const paragraphIds = new Set(manifest.chapters.flatMap((chapter) => chapter.paragraphs.map((p) => p.paragraph_id)));
  const result = new Map<string, TranslationRecord>();
  for (const record of translations) {
    if (!paragraphIds.has(record.paragraph_id)) throw new Error(`Unknown paragraph translation: ${record.paragraph_id}`);
    if (result.has(record.paragraph_id)) throw new Error(`Duplicate paragraph translation: ${record.paragraph_id}`);
    if (!record.translation.trim()) throw new Error(`Empty paragraph translation: ${record.paragraph_id}`);
    result.set(record.paragraph_id, record);
  }
  if (requireComplete) {
    for (const paragraphId of paragraphIds) {
      if (!result.has(paragraphId)) throw new Error(`Translation coverage is incomplete: ${paragraphId} is missing`);
    }
  }
  return result;
}

function validateProvenance(options: RenderSourceOptions): void {
  const provenance = options.provenance;
  if (!provenance.project_id) throw new Error('Render provenance project_id is empty');
  if (!Number.isSafeInteger(provenance.instruction_version) || provenance.instruction_version < 0) {
    throw new Error('Render provenance instruction_version is invalid');
  }
  for (const [key, value] of Object.entries({
    prompt_fingerprint: provenance.prompt_fingerprint,
    context_hash: provenance.context_hash,
    model_fingerprint: provenance.model_fingerprint,
    merge_receipt_hash: provenance.merge_receipt_hash,
  })) {
    if (!value) throw new Error(`Render provenance ${key} is empty`);
  }
  if (!/^[a-f0-9]{64}$/u.test(provenance.merge_receipt_hash)) {
    throw new Error('Render provenance merge_receipt_hash must be SHA-256');
  }
}

function combineValidation(...results: readonly StructuralValidationResult[]): StructuralValidationResult {
  return {
    valid: results.every((result) => result.valid),
    checks: results.flatMap((result) => result.checks),
    warnings: results.flatMap((result) => result.warnings),
    errors: results.flatMap((result) => result.errors),
  };
}

function coverage(translated: number, total: number): number {
  return total === 0 ? 1 : translated / total;
}
