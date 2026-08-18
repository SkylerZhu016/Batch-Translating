import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';

import JSZip from 'jszip';

import { compareStrings, readSourceReceipt, sha256Bytes } from '../hash.js';
import type {
  BookManifest,
  ChapterManifest,
  EpubManifestItem,
  EpubResourceKind,
  ParsedSource,
} from '../types.js';
import {
  descendantElements,
  elementsByLocalName,
  firstElementByLocalName,
  getAttribute,
  localName,
  parseXml,
} from '../xml.js';
import { extractParagraphs } from './paragraphs.js';
import { normalizeZipPath } from './paths.js';

const XHTML_MEDIA_TYPES = new Set(['application/xhtml+xml', 'text/html']);

export async function parseEpubSource(sourcePath: string): Promise<ParsedSource> {
  const absolutePath = resolve(sourcePath);
  const [sourceBytes, source] = await Promise.all([
    readFile(absolutePath),
    readSourceReceipt(absolutePath, 'epub'),
  ]);
  if (sha256Bytes(sourceBytes) !== source.sha256) {
    throw new Error('Source EPUB changed while it was being parsed');
  }
  const zip = await JSZip.loadAsync(sourceBytes, { checkCRC32: true, createFolders: false });
  await assertEpubMimetype(zip);

  const containerText = await readZipText(zip, 'META-INF/container.xml');
  const container = parseXml(containerText, 'META-INF/container.xml');
  const rootfile = firstElementByLocalName(container.documentElement, 'rootfile');
  const packagePathValue = rootfile ? getAttribute(rootfile, 'full-path') : undefined;
  if (!packagePathValue) throw new Error('EPUB container does not name a package document');
  const packageDocumentPath = normalizeZipPath(packagePathValue);
  const opfText = await readZipText(zip, packageDocumentPath);
  const opf = parseXml(opfText, packageDocumentPath);
  const opfDirectory = posix.dirname(packageDocumentPath);

  const itemElements = elementsByLocalName(opf.documentElement, 'item');
  const resourcePromises = itemElements.map(async (element): Promise<EpubManifestItem> => {
    const id = element.getAttribute('id')?.trim();
    const href = element.getAttribute('href')?.trim();
    const mediaType = element.getAttribute('media-type')?.trim().toLowerCase();
    if (!id || !href || !mediaType) {
      throw new Error(`Malformed OPF manifest item in ${packageDocumentPath}`);
    }
    const zipPath = normalizeZipPath(href, opfDirectory);
    const entry = zip.file(zipPath);
    if (!entry) throw new Error(`OPF manifest references missing resource: ${zipPath}`);
    const bytes = await entry.async('nodebuffer');
    const properties = (element.getAttribute('properties') ?? '').split(/\s+/u).filter(Boolean).sort();
    return {
      id,
      href,
      zip_path: zipPath,
      media_type: mediaType,
      properties,
      kind: classifyResource(mediaType, properties),
      sha256: sha256Bytes(bytes),
      byte_length: bytes.byteLength,
    };
  });
  const resources = await Promise.all(resourcePromises);
  if (new Set(resources.map((item) => item.id)).size !== resources.length) {
    throw new Error('OPF manifest contains duplicate item IDs');
  }
  const resourcesById = new Map(resources.map((item) => [item.id, item]));

  const spine = firstElementByLocalName(opf.documentElement, 'spine');
  if (!spine) throw new Error('EPUB package has no spine');
  const itemrefs = elementsByLocalName(spine, 'itemref');
  const readingOrder: EpubManifestItem[] = [];
  for (const itemref of itemrefs) {
    const idref = itemref.getAttribute('idref')?.trim();
    if (!idref) throw new Error('EPUB spine contains itemref without idref');
    const item = resourcesById.get(idref);
    if (!item) throw new Error(`EPUB spine references unknown manifest id: ${idref}`);
    if ((itemref.getAttribute('linear') ?? 'yes').toLowerCase() !== 'no') readingOrder.push(item);
  }

  const chapters: ChapterManifest[] = [];
  for (const item of readingOrder) {
    if (!XHTML_MEDIA_TYPES.has(item.media_type) || item.properties.includes('nav')) continue;
    const chapterId = `ch${String(chapters.length + 1).padStart(3, '0')}`;
    const chapterText = await readZipText(zip, item.zip_path);
    const document = parseXml(chapterText, item.zip_path);
    chapters.push({
      chapter_id: chapterId,
      ordinal: chapters.length + 1,
      manifest_id: item.id,
      source_path: item.zip_path,
      linear: true,
      media_type: item.media_type,
      paragraphs: extractParagraphs(document, chapterId),
    });
  }
  if (chapters.length === 0) throw new Error('EPUB spine has no linear XHTML body items');

  const metadataElement = firstElementByLocalName(opf.documentElement, 'metadata');
  const metadata: Record<string, string[]> = {};
  if (metadataElement) {
    for (const element of descendantElements(metadataElement)) {
      if (element.parentNode !== metadataElement) continue;
      const key = localName(element);
      const value = element.textContent?.trim();
      if (!value) continue;
      (metadata[key] ??= []).push(value);
    }
  }
  const paragraphs = chapters.flatMap((chapter) => chapter.paragraphs);
  const navigation = resources.find((item) => item.properties.includes('nav'));
  return {
    manifest: {
      schema_version: 1,
      format: 'epub',
      source,
      book_id: `book_${source.sha256.slice(0, 32)}`,
      created_at: new Date(source.modified_at_ms).toISOString(),
      package_document_path: packageDocumentPath,
      ...(navigation ? { navigation_path: navigation.zip_path } : {}),
      metadata,
      resources: resources.slice().sort((left, right) => compareStrings(left.zip_path, right.zip_path)),
      reading_order: readingOrder.map((item) => item.zip_path),
      chapters,
      paragraph_count: paragraphs.length,
      source_word_count: countWords(paragraphs.map((paragraph) => paragraph.source_text).join('\n')),
    },
  };
}

async function assertEpubMimetype(zip: JSZip): Promise<void> {
  const mimetype = zip.file('mimetype');
  if (!mimetype) throw new Error('EPUB is missing its mimetype entry');
  if ((await mimetype.async('string')) !== 'application/epub+zip') {
    throw new Error('EPUB mimetype entry is invalid');
  }
}

async function readZipText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) throw new Error(`EPUB archive entry is missing: ${path}`);
  const bytes = await entry.async('uint8array');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`EPUB XML/XHTML resource is not valid UTF-8: ${path}`);
  }
}

function classifyResource(mediaType: string, properties: readonly string[]): EpubResourceKind {
  if (properties.includes('nav')) return 'navigation';
  if (XHTML_MEDIA_TYPES.has(mediaType)) return 'body';
  if (mediaType === 'text/css') return 'stylesheet';
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('font/') || mediaType.includes('font')) return 'font';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  if (mediaType.includes('oebps-package')) return 'package';
  return 'other';
}

function countWords(value: string): number {
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
  return Array.from(segmenter.segment(value)).filter((segment) => segment.isWordLike).length;
}
