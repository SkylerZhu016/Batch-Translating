import JSZip from 'jszip';

import type { StructuralValidationResult } from '../types.js';
import {
  descendantElements,
  elementsByLocalName,
  firstElementByLocalName,
  getAttribute,
  parseXml,
  type DomDocument,
} from '../xml.js';
import { normalizeZipPath, resolveArchiveReference } from './paths.js';

export async function validateEpubStructure(bytes: Uint8Array): Promise<StructuralValidationResult> {
  const checks: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    validateMimetypeLocalHeader(bytes, errors);
    if (errors.length === 0) checks.push('OCF mimetype is the first uncompressed ZIP entry');
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
    checks.push('ZIP CRC validation passed');
    const mimetype = zip.file('mimetype');
    if (!mimetype || (await mimetype.async('string')) !== 'application/epub+zip') {
      errors.push('Missing or invalid mimetype entry');
    } else {
      checks.push('EPUB mimetype value is valid');
    }
    const containerEntry = zip.file('META-INF/container.xml');
    if (!containerEntry) {
      errors.push('META-INF/container.xml is missing');
      return result(checks, warnings, errors);
    }
    const container = parseXml(await containerEntry.async('string'), 'META-INF/container.xml');
    const rootfile = firstElementByLocalName(container.documentElement, 'rootfile');
    const packageValue = rootfile ? getAttribute(rootfile, 'full-path') : undefined;
    if (!packageValue) {
      errors.push('container.xml has no rootfile full-path');
      return result(checks, warnings, errors);
    }
    const packagePath = normalizeZipPath(packageValue);
    const packageEntry = zip.file(packagePath);
    if (!packageEntry) {
      errors.push(`Package document is missing: ${packagePath}`);
      return result(checks, warnings, errors);
    }
    const opf = parseXml(await packageEntry.async('string'), packagePath);
    checks.push('Container and package documents are well-formed');
    const packageDirectory = packagePath.includes('/') ? packagePath.slice(0, packagePath.lastIndexOf('/')) : '';
    const manifestById = new Map<string, { path: string; mediaType: string; properties: string[] }>();
    for (const item of elementsByLocalName(opf.documentElement, 'item')) {
      const id = item.getAttribute('id')?.trim();
      const href = item.getAttribute('href')?.trim();
      const mediaType = item.getAttribute('media-type')?.trim().toLowerCase();
      if (!id || !href || !mediaType) {
        errors.push('Package manifest contains a malformed item');
        continue;
      }
      const path = normalizeZipPath(href, packageDirectory);
      if (!zip.file(path)) errors.push(`Manifest resource is missing: ${path}`);
      manifestById.set(id, {
        path,
        mediaType,
        properties: (item.getAttribute('properties') ?? '').split(/\s+/u).filter(Boolean),
      });
    }
    const spine = firstElementByLocalName(opf.documentElement, 'spine');
    if (!spine) {
      errors.push('Package spine is missing');
    } else {
      let linearCount = 0;
      for (const itemref of elementsByLocalName(spine, 'itemref')) {
        const idref = itemref.getAttribute('idref')?.trim();
        if (!idref || !manifestById.has(idref)) errors.push(`Spine references unknown manifest id: ${idref ?? '(empty)'}`);
        if ((itemref.getAttribute('linear') ?? 'yes').toLowerCase() !== 'no') linearCount += 1;
      }
      if (linearCount === 0) errors.push('Package spine has no linear items');
      else checks.push(`Package spine has ${linearCount} linear item(s)`);
    }
    const navItems = [...manifestById.values()].filter((item) => item.properties.includes('nav'));
    if (navItems.length > 1) errors.push('Package has multiple navigation documents');
    if (navItems.length === 1 && !zip.file(navItems[0]?.path ?? '')) errors.push('Navigation document is missing');
    if (navItems.length === 1) checks.push('Navigation document is present');

    const parsedXml = new Map<string, DomDocument>();
    for (const item of manifestById.values()) {
      if (!zip.file(item.path)) continue;
      if (item.mediaType === 'application/xhtml+xml' || item.mediaType === 'text/html' || item.mediaType.endsWith('+xml')) {
        try {
          const document = parseXml(await readZipUtf8(zip, item.path), item.path);
          parsedXml.set(item.path, document);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    for (const [path, document] of parsedXml) {
      await validateDocumentReferences(zip, parsedXml, path, document, errors);
    }
    for (const item of manifestById.values()) {
      if (item.mediaType !== 'text/css' || !zip.file(item.path)) continue;
      const css = await readZipUtf8(zip, item.path);
      for (const reference of cssReferences(css)) {
        const resolved = resolveArchiveReference(item.path, reference);
        if (resolved && !zip.file(resolved)) errors.push(`CSS ${item.path} references missing resource ${resolved}`);
      }
    }
    if (errors.length === 0) checks.push('Manifest, spine, links, footnotes, and CSS resource references resolve');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return result(checks, warnings, errors);
}

export async function validateResourcePreservation(
  sourceBytes: Uint8Array,
  renderedBytes: Uint8Array,
  modifiedPaths: ReadonlySet<string>,
): Promise<StructuralValidationResult> {
  const checks: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const [source, rendered] = await Promise.all([
    JSZip.loadAsync(sourceBytes, { checkCRC32: true, createFolders: false }),
    JSZip.loadAsync(renderedBytes, { checkCRC32: true, createFolders: false }),
  ]);
  const sourcePaths = Object.values(source.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort();
  const renderedPaths = Object.values(rendered.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort();
  if (JSON.stringify(sourcePaths) !== JSON.stringify(renderedPaths)) {
    errors.push('Rebuilt EPUB added or removed archive resources');
  }
  for (const path of sourcePaths) {
    if (modifiedPaths.has(path)) continue;
    const sourceEntry = source.file(path);
    const renderedEntry = rendered.file(path);
    if (!sourceEntry || !renderedEntry) continue;
    const [before, after] = await Promise.all([sourceEntry.async('nodebuffer'), renderedEntry.async('nodebuffer')]);
    if (!before.equals(after)) errors.push(`Rebuilt EPUB changed protected resource ${path}`);
  }
  if (errors.length === 0) checks.push('All non-body resources and unmodified body files are byte-preserved');
  return result(checks, warnings, errors);
}

function validateMimetypeLocalHeader(bytes: Uint8Array, errors: string[]): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 38 || buffer.readUInt32LE(0) !== 0x04034b50) {
    errors.push('ZIP does not begin with a local file header');
    return;
  }
  const compression = buffer.readUInt16LE(8);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const name = buffer.subarray(30, 30 + nameLength).toString('utf8');
  if (name !== 'mimetype') errors.push('mimetype is not the first ZIP entry');
  if (compression !== 0) errors.push('mimetype ZIP entry is compressed');
  if (extraLength !== 0) errors.push('mimetype ZIP entry has a forbidden extra field');
}

async function validateDocumentReferences(
  zip: JSZip,
  parsedXml: Map<string, DomDocument>,
  sourcePath: string,
  document: DomDocument,
  errors: string[],
): Promise<void> {
  for (const element of descendantElements(document.documentElement)) {
    for (const attribute of ['href', 'src', 'poster', 'data', 'xlink:href']) {
      const reference = getAttribute(element, attribute);
      if (!reference) continue;
      const fragment = reference.includes('#') ? reference.slice(reference.indexOf('#') + 1) : undefined;
      const resolved = resolveArchiveReference(sourcePath, reference);
      const targetPath = resolved ?? (reference.startsWith('#') ? sourcePath : undefined);
      if (targetPath && !zip.file(targetPath)) {
        errors.push(`${sourcePath} references missing resource ${targetPath}`);
        continue;
      }
      if (targetPath && fragment) {
        let targetDocument = parsedXml.get(targetPath);
        if (!targetDocument && zip.file(targetPath) && /\.(?:xhtml|html|xml|svg)$/iu.test(targetPath)) {
          try {
            targetDocument = parseXml(await readZipUtf8(zip, targetPath), targetPath);
            parsedXml.set(targetPath, targetDocument);
          } catch {
            continue;
          }
        }
        if (
          targetDocument &&
          !descendantElements(targetDocument.documentElement).some((candidate) => candidate.getAttribute('id') === fragment)
        ) {
          errors.push(`${sourcePath} references missing fragment ${targetPath}#${fragment}`);
        }
      }
    }
  }
}

function cssReferences(css: string): string[] {
  const values: string[] = [];
  const expression = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/giu;
  for (const match of css.matchAll(expression)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) values.push(value);
  }
  return values;
}

async function readZipUtf8(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) throw new Error(`Missing EPUB resource: ${path}`);
  const bytes = await entry.async('uint8array');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function result(
  checks: readonly string[],
  warnings: readonly string[],
  errors: readonly string[],
): StructuralValidationResult {
  return { valid: errors.length === 0, checks, warnings, errors };
}
