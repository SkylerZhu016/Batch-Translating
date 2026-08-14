import { posix } from 'node:path';

import type {
  EpubChapterMapItem,
  EpubIssue,
  EpubPackageInspection,
  EpubPackageManifestItem,
  EpubRootfile,
  EpubSpineItem,
} from './types';

const XML_MAX_BYTES = 16 * 1024 * 1024;

interface ParsedElement {
  readonly attributes: ReadonlyMap<string, string>;
  readonly body: string;
}

export function decodeXml(data: Buffer, path: string): string {
  if (data.length > XML_MAX_BYTES) {
    throw new Error(`${path} exceeds the ${String(XML_MAX_BYTES)} byte XML limit.`);
  }

  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(data.subarray(2));
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(data.length - 2);
    for (let index = 2; index + 1 < data.length; index += 2) {
      swapped[index - 2] = data[index + 1]!;
      swapped[index - 1] = data[index]!;
    }
    return new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
  }
  if (data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(3));
  }

  if (data.length >= 4 && data[0] === 0x00 && data[1] === 0x3c) {
    const swapped = Buffer.allocUnsafe(data.length);
    for (let index = 0; index + 1 < data.length; index += 2) {
      swapped[index] = data[index + 1]!;
      swapped[index + 1] = data[index]!;
    }
    return new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
  }
  if (data.length >= 4 && data[0] === 0x3c && data[1] === 0x00) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(data);
  }

  const declaration = data.subarray(0, Math.min(data.length, 512)).toString('latin1');
  const declaredEncoding = /<\?xml\s[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(
    declaration,
  )?.[1];
  const encoding = normalizeXmlEncoding(declaredEncoding);
  return new TextDecoder(encoding, { fatal: true }).decode(data);
}

export function parseContainerXml(xml: string): readonly EpubRootfile[] {
  return findElements(xml, 'rootfile').flatMap((element) => {
    const fullPath = getAttribute(element, 'full-path')?.trim();
    if (fullPath === undefined || fullPath === '') return [];
    const mediaType = getAttribute(element, 'media-type')?.trim();
    return [
      {
        path: normalizeArchiveReference(fullPath),
        mediaType: mediaType === undefined || mediaType === '' ? undefined : mediaType,
      },
    ];
  });
}

export function parsePackageDocument(
  xml: string,
  packagePath: string,
  archivePaths: ReadonlySet<string>,
  issues: EpubIssue[],
): EpubPackageInspection {
  const packageElement = findElements(xml, 'package')[0];
  const uniqueIdentifier = packageElement === undefined
    ? undefined
    : getAttribute(packageElement, 'unique-identifier')?.trim();
  const metadata = {
    version: packageElement === undefined ? undefined : getAttribute(packageElement, 'version')?.trim(),
    uniqueIdentifier,
    title: findElementText(xml, 'title'),
    language: findElementText(xml, 'language'),
    identifier:
      uniqueIdentifier === undefined
        ? findElementText(xml, 'identifier')
        : elementText(
            findElements(xml, 'identifier').find(
              (element) => getAttribute(element, 'id') === uniqueIdentifier,
            ),
          ),
  };

  const packageDirectory = posix.dirname(packagePath);
  const manifest: EpubPackageManifestItem[] = [];
  const manifestById = new Map<string, EpubPackageManifestItem>();
  for (const element of findElements(xml, 'item')) {
    const id = getAttribute(element, 'id')?.trim();
    const href = getAttribute(element, 'href')?.trim();
    const mediaType = getAttribute(element, 'media-type')?.trim();
    if (id === undefined || id === '' || href === undefined || href === '' || mediaType === undefined || mediaType === '') {
      issues.push({
        severity: 'error',
        code: 'invalid_manifest_item',
        message: 'Every OPF manifest item must have non-empty id, href, and media-type attributes.',
        path: packagePath,
      });
      continue;
    }
    if (manifestById.has(id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate_manifest_id',
        message: `The OPF manifest contains duplicate id "${id}".`,
        path: packagePath,
      });
      continue;
    }

    const remote = isRemoteReference(href);
    let resolvedPath: string | undefined;
    if (!remote) {
      try {
        resolvedPath = resolvePackageReference(packageDirectory, href);
        if (!archivePaths.has(resolvedPath)) {
          issues.push({
            severity: 'error',
            code: 'missing_manifest_resource',
            message: `Manifest item "${id}" points to missing archive entry "${resolvedPath}".`,
            path: packagePath,
          });
        }
      } catch (error) {
        issues.push({
          severity: 'error',
          code: 'invalid_manifest_href',
          message: `Manifest item "${id}" has an unsafe or invalid href: ${errorMessage(error)}`,
          path: packagePath,
        });
      }
    }

    const item: EpubPackageManifestItem = {
      id,
      href,
      path: resolvedPath,
      mediaType,
      properties: splitTokens(getAttribute(element, 'properties')),
      remote,
    };
    manifest.push(item);
    manifestById.set(id, item);
  }

  const spine: EpubSpineItem[] = [];
  const chapterMap: EpubChapterMapItem[] = [];
  for (const [index, element] of findElements(xml, 'itemref').entries()) {
    const idref = getAttribute(element, 'idref')?.trim();
    if (idref === undefined || idref === '') {
      issues.push({
        severity: 'error',
        code: 'invalid_spine_item',
        message: 'Every OPF spine itemref must have a non-empty idref attribute.',
        path: packagePath,
      });
      continue;
    }
    const manifestItem = manifestById.get(idref);
    if (manifestItem === undefined) {
      issues.push({
        severity: 'error',
        code: 'missing_spine_manifest_item',
        message: `Spine idref "${idref}" does not exist in the OPF manifest.`,
        path: packagePath,
      });
    }
    const spineItem: EpubSpineItem = {
      index,
      idref,
      linear: getAttribute(element, 'linear')?.trim().toLowerCase() !== 'no',
      properties: splitTokens(getAttribute(element, 'properties')),
      path: manifestItem?.path,
      mediaType: manifestItem?.mediaType,
    };
    spine.push(spineItem);
    if (
      manifestItem?.path !== undefined &&
      (manifestItem.mediaType === 'application/xhtml+xml' || manifestItem.mediaType === 'text/html')
    ) {
      chapterMap.push({
        chapterIndex: chapterMap.length,
        spineIndex: index,
        idref,
        href: manifestItem.href,
        path: manifestItem.path,
        mediaType: manifestItem.mediaType,
        linear: spineItem.linear,
        properties: spineItem.properties,
      });
    }
  }
  if (spine.length === 0) {
    issues.push({
      severity: 'error',
      code: 'empty_spine',
      message: 'The OPF spine does not contain any itemref entries.',
      path: packagePath,
    });
  }

  return { path: packagePath, metadata, manifest, spine, chapterMap };
}

function findElements(xml: string, localName: string): ParsedElement[] {
  const cleaned = xml.replaceAll(/<!--[\s\S]*?-->/g, '');
  const pattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(localName)}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(localName)}\\s*>|<(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(localName)}\\b([^>]*)\\/?\\s*>`,
    'gi',
  );
  const result: ParsedElement[] = [];
  for (const match of cleaned.matchAll(pattern)) {
    result.push({
      attributes: parseAttributes(match[1] ?? match[3] ?? ''),
      body: match[2] ?? '',
    });
  }
  return result;
}

function parseAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    const rawName = match[1]!;
    const localName = rawName.includes(':') ? rawName.slice(rawName.lastIndexOf(':') + 1) : rawName;
    attributes.set(localName.toLowerCase(), decodeXmlEntities(match[2] ?? match[3] ?? ''));
  }
  return attributes;
}

function getAttribute(element: ParsedElement, localName: string): string | undefined {
  return element.attributes.get(localName.toLowerCase());
}

function findElementText(xml: string, localName: string): string | undefined {
  return elementText(findElements(xml, localName)[0]);
}

function elementText(element: ParsedElement | undefined): string | undefined {
  if (element === undefined) return undefined;
  const text = decodeXmlEntities(element.body.replaceAll(/<[^>]*>/g, '')).trim();
  return text === '' ? undefined : text;
}

function decodeXmlEntities(value: string): string {
  return value.replaceAll(/&(?:#x([0-9a-f]+)|#([0-9]+)|amp|lt|gt|quot|apos);/gi, (entity, hex: string | undefined, decimal: string | undefined) => {
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
    switch (entity.toLowerCase()) {
      case '&amp;': return '&';
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&quot;': return '"';
      case '&apos;': return "'";
      default: return entity;
    }
  });
}

function normalizeXmlEncoding(value: string | undefined): string {
  const encoding = value?.trim().toLowerCase() ?? 'utf-8';
  if (encoding === 'utf8') return 'utf-8';
  if (encoding === 'utf16' || encoding === 'utf-16') return 'utf-16le';
  if (encoding === 'utf-16be') return 'utf-16le';
  return encoding;
}

function normalizeArchiveReference(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`absolute archive path "${value}" is not allowed`);
  }
  const result = posix.normalize(normalized);
  if (result === '..' || result.startsWith('../') || result === '.' || result === '') {
    throw new Error(`archive path "${value}" escapes the EPUB root`);
  }
  return result;
}

function resolvePackageReference(packageDirectory: string, href: string): string {
  const withoutFragment = href.split('#', 1)[0]!.split('?', 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch (error) {
    throw new Error('invalid percent encoding', { cause: error });
  }
  return normalizeArchiveReference(posix.join(packageDirectory, decoded));
}

function isRemoteReference(href: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith('//');
}

function splitTokens(value: string | undefined): string[] {
  return value?.trim().split(/\s+/).filter(Boolean) ?? [];
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
