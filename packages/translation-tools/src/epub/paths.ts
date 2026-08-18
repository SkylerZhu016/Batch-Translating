import { posix } from 'node:path';

export function normalizeZipPath(path: string, baseDirectory = ''): string {
  const withoutFragment = path.split('#', 1)[0] ?? '';
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    throw new Error(`EPUB contains an invalid percent-encoded path: ${path}`);
  }
  const normalized = posix.normalize(posix.join(baseDirectory, decoded.replaceAll('\\', '/')));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`EPUB path escapes its archive: ${path}`);
  }
  return normalized;
}

export function resolveArchiveReference(fromZipPath: string, reference: string): string | undefined {
  const trimmed = reference.trim();
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed)
  ) {
    return undefined;
  }
  return normalizeZipPath(trimmed, posix.dirname(fromZipPath));
}
