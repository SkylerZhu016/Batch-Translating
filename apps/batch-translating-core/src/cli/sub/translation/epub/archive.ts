import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

import { open as openZip, type Entry, type ZipFile as ReadZipFile } from 'yauzl';
import { ZipFile as WriteZipFile } from 'yazl';

import {
  EPUB_INSPECTION_SCHEMA_VERSION,
  EpubArchiveError,
  type EpubInspection,
  type EpubIssue,
  type EpubZipEntry,
  type InspectEpubOptions,
  type RepackEpubOptions,
  type RepackEpubResult,
  type UnpackEpubOptions,
  type UnpackEpubResult,
  type ValidateEpubResult,
} from './types';
import { decodeXml, parseContainerXml, parsePackageDocument } from './xml';

export const EPUB_MANIFEST_RELATIVE_PATH = '.batch-translating/epub-manifest.json';

const EPUB_MIMETYPE = 'application/epub+zip';
const EPUB_CONTAINER_PATH = 'META-INF/container.xml';
const MAX_ENTRIES = 100_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 2_000;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const UNIX_HOST_SYSTEM = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;

interface PhysicalFirstEntry {
  readonly path?: string;
  readonly compressionMethod?: number;
  readonly extraFieldLength?: number;
}

interface EntryContent {
  readonly buffer: Buffer;
  readonly crc32: number;
  readonly bytes: number;
}

interface ExtractionDigest {
  readonly crc32: number;
  readonly bytes: number;
}

export async function inspectEpub(
  sourcePath: string,
  options: InspectEpubOptions = {},
): Promise<EpubInspection> {
  const source = resolve(sourcePath);
  const sourceStat = await stat(source).catch((error: unknown) => {
    throw new EpubArchiveError('source_unreadable', `Cannot read EPUB "${source}": ${errorMessage(error)}`, {
      cause: error,
    });
  });
  if (!sourceStat.isFile()) {
    throw new EpubArchiveError('source_not_file', `EPUB source is not a regular file: ${source}`);
  }

  const [sha256, physicalFirst] = await Promise.all([
    sha256File(source),
    readPhysicalFirstEntry(source),
  ]);
  const issues: EpubIssue[] = [];
  const entries: EpubZipEntry[] = [];
  const archiveFilePaths = new Set<string>();
  const portablePaths = new Map<string, string>();
  let totalUncompressedBytes = 0;
  let mimetypeContent: Buffer | undefined;
  let containerContent: Buffer | undefined;

  await visitZipEntries(source, async (entry, index, zip) => {
    const path = normalizeEntryPath(entry.fileName);
    const directory = path.endsWith('/');
    validateEntryMetadata(entry, path, directory, issues);
    totalUncompressedBytes += entry.uncompressedSize;
    if (entries.length >= MAX_ENTRIES) {
      throw new EpubArchiveError(
        'entry_limit_exceeded',
        `EPUB contains more than ${String(MAX_ENTRIES)} ZIP entries.`,
      );
    }
    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new EpubArchiveError(
        'size_limit_exceeded',
        `EPUB expands beyond the ${String(MAX_TOTAL_UNCOMPRESSED_BYTES)} byte safety limit.`,
      );
    }

    const collisionKey = portablePathKey(path);
    const collidingPath = portablePaths.get(collisionKey);
    if (collidingPath !== undefined) {
      issues.push({
        severity: 'error',
        code: 'duplicate_entry_path',
        message: `ZIP entries "${collidingPath}" and "${path}" collide on a portable filesystem.`,
        path,
      });
    } else {
      portablePaths.set(collisionKey, path);
    }
    if (!directory) archiveFilePaths.add(path);
    entries.push(toZipEntry(entry, path, directory, index));

    if (!directory && (path === 'mimetype' || path === EPUB_CONTAINER_PATH)) {
      try {
        const content = await readEntryContent(zip, entry, MAX_XML_BYTES);
        if (path === 'mimetype') mimetypeContent = content.buffer;
        else containerContent = content.buffer;
      } catch (error) {
        issues.push({
          severity: 'error',
          code: 'unreadable_required_entry',
          message: `Cannot read required EPUB entry "${path}": ${errorMessage(error)}`,
          path,
        });
      }
    }
  });

  const firstCentralEntry = entries[0];
  const mimetype = {
    firstEntry: physicalFirst.path === 'mimetype' && firstCentralEntry?.path === 'mimetype',
    stored:
      physicalFirst.compressionMethod === 0 &&
      firstCentralEntry?.path === 'mimetype' &&
      firstCentralEntry.compressionMethod === 0,
    noExtraField: physicalFirst.extraFieldLength === 0,
    contentValid: mimetypeContent?.equals(Buffer.from(EPUB_MIMETYPE, 'ascii')) === true,
  };
  if (!mimetype.firstEntry) {
    issues.push({
      severity: 'error',
      code: 'mimetype_not_first',
      message: 'The first physical and central-directory ZIP entry must be named "mimetype".',
      path: 'mimetype',
    });
  }
  if (!mimetype.stored) {
    issues.push({
      severity: 'error',
      code: 'mimetype_compressed',
      message: 'The mimetype entry must use ZIP method 0 (stored, not compressed).',
      path: 'mimetype',
    });
  }
  if (!mimetype.noExtraField) {
    issues.push({
      severity: 'error',
      code: 'mimetype_extra_field',
      message: 'The local header for the mimetype entry must not contain an extra field.',
      path: 'mimetype',
    });
  }
  if (!mimetype.contentValid) {
    issues.push({
      severity: 'error',
      code: 'invalid_mimetype_content',
      message: `The mimetype entry must contain exactly "${EPUB_MIMETYPE}" with no BOM or newline.`,
      path: 'mimetype',
    });
  }

  const rootfiles = parseRootfiles(containerContent, issues);
  const selectedRootfile = selectRootfile(rootfiles, archiveFilePaths, issues);
  let packageDocument: EpubInspection['package'];
  if (selectedRootfile !== undefined) {
    let packageContent: Buffer | undefined;
    await visitZipEntries(source, async (entry, _index, zip) => {
      const path = normalizeEntryPath(entry.fileName);
      const shouldRead = options.verifyCrc === true || path === selectedRootfile;
      if (entry.fileName.endsWith('/') || !shouldRead) return;
      try {
        const content = await readEntryContent(
          zip,
          entry,
          path === selectedRootfile ? MAX_XML_BYTES : MAX_ENTRY_UNCOMPRESSED_BYTES,
        );
        if (path === selectedRootfile) packageContent = content.buffer;
      } catch (error) {
        issues.push({
          severity: 'error',
          code: 'entry_integrity_error',
          message: `ZIP entry "${path}" failed integrity validation: ${errorMessage(error)}`,
          path,
        });
      }
    });
    if (packageContent !== undefined) {
      try {
        packageDocument = parsePackageDocument(
          decodeXml(packageContent, selectedRootfile),
          selectedRootfile,
          archiveFilePaths,
          issues,
        );
      } catch (error) {
        issues.push({
          severity: 'error',
          code: 'invalid_package_document',
          message: `Cannot parse OPF package document: ${errorMessage(error)}`,
          path: selectedRootfile,
        });
      }
    } else {
      issues.push({
        severity: 'error',
        code: 'unreadable_package_document',
        message: 'The selected OPF package document could not be read.',
        path: selectedRootfile,
      });
    }
  }

  return {
    schemaVersion: EPUB_INSPECTION_SCHEMA_VERSION,
    source: { path: source, size: sourceStat.size, sha256 },
    valid: issues.every((issue) => issue.severity !== 'error'),
    mimetype,
    entries,
    container: {
      path: EPUB_CONTAINER_PATH,
      rootfiles,
      selectedRootfile,
    },
    package: packageDocument,
    issues,
  };
}

export async function unpackEpub(
  sourcePath: string,
  outputDirectory: string,
  options: UnpackEpubOptions = {},
): Promise<UnpackEpubResult> {
  const inspection = await inspectEpub(sourcePath);
  assertValidInspection(inspection, 'unpack');

  const destination = resolve(outputDirectory);
  if (await pathExists(destination)) {
    throw new EpubArchiveError(
      'destination_exists',
      `Unpack destination already exists; refusing to merge or overwrite it: ${destination}`,
    );
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporaryDirectory = await mkdtemp(join(dirname(destination), '.epub-unpack-'));
  const manifestRelativePath = normalizeManifestRelativePath(options.manifestPath);

  try {
    await visitZipEntries(inspection.source.path, async (entry, _index, zip) => {
      const archivePath = normalizeEntryPath(entry.fileName);
      const target = resolveSafeTarget(temporaryDirectory, archivePath);
      if (target === undefined) {
        throw new EpubArchiveError(
          'zip_slip',
          `ZIP entry escapes the extraction directory: ${archivePath}`,
        );
      }
      if (archivePath.endsWith('/')) {
        await mkdir(target, { recursive: true });
        await restoreMetadata(target, entry);
        return;
      }

      await mkdir(dirname(target), { recursive: true });
      const digest = await extractEntry(zip, entry, target);
      assertEntryDigest(entry, digest);
      await restoreMetadata(target, entry);
    });

    const manifestPath = resolveSafeTarget(temporaryDirectory, manifestRelativePath);
    if (manifestPath === undefined) {
      throw new EpubArchiveError('unsafe_manifest_path', 'Manifest path escapes the output directory.');
    }
    if (inspection.entries.some((entry) => entry.path === manifestRelativePath)) {
      throw new EpubArchiveError(
        'manifest_path_collision',
        `The EPUB already contains the reserved manifest path "${manifestRelativePath}".`,
      );
    }
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(inspection, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryDirectory, destination);
    return {
      outputDirectory: destination,
      manifestPath: join(destination, ...manifestRelativePath.split('/')),
      entryCount: inspection.entries.length,
      chapterCount: inspection.package?.chapterMap.length ?? 0,
      sourceSha256: inspection.source.sha256,
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function repackEpub(
  inputDirectory: string,
  outputPath: string,
  options: RepackEpubOptions = {},
): Promise<RepackEpubResult> {
  const root = resolve(inputDirectory);
  const rootStat = await stat(root).catch((error: unknown) => {
    throw new EpubArchiveError('input_unreadable', `Cannot read unpacked EPUB directory: ${errorMessage(error)}`, {
      cause: error,
    });
  });
  if (!rootStat.isDirectory()) {
    throw new EpubArchiveError('input_not_directory', `Repack input is not a directory: ${root}`);
  }

  const manifestPath = resolveManifestPath(root, options.manifestPath);
  const inspection = await readInspectionManifest(manifestPath);
  assertValidInspection(inspection, 'repack');
  validateManifestEntries(inspection);

  const destination = resolve(outputPath);
  if (pathsEqual(destination, inspection.source.path)) {
    throw new EpubArchiveError(
      'source_overwrite_refused',
      'Repack output resolves to the source EPUB. The source archive is immutable; choose a new output path.',
    );
  }
  if (await pathExists(destination)) {
    throw new EpubArchiveError(
      'destination_exists',
      `Repack destination already exists; refusing to overwrite it: ${destination}`,
    );
  }

  const relativeManifestPath = relative(root, manifestPath).split(sep).join('/');
  await verifyRepackTree(root, inspection.entries, relativeManifestPath);
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = join(
    dirname(destination),
    `.${destinationName(destination)}.${randomBytes(8).toString('hex')}.tmp`,
  );

  try {
    await writeEpubArchive(root, temporaryPath, inspection.entries);
    const outputInspection = await inspectEpub(temporaryPath, { verifyCrc: true });
    assertValidInspection(outputInspection, 'publish');
    if (!sameEntryOrder(inspection.entries, outputInspection.entries)) {
      throw new EpubArchiveError(
        'entry_order_changed',
        'Repacked EPUB entry order differs from the source manifest.',
      );
    }
    await rename(temporaryPath, destination);
    return {
      outputPath: destination,
      entryCount: outputInspection.entries.length,
      chapterCount: outputInspection.package?.chapterMap.length ?? 0,
      sha256: outputInspection.source.sha256,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function validateEpub(sourcePath: string): Promise<ValidateEpubResult> {
  const inspection = await inspectEpub(sourcePath, { verifyCrc: true });
  return {
    valid: inspection.valid,
    path: inspection.source.path,
    sha256: inspection.source.sha256,
    entryCount: inspection.entries.length,
    chapterCount: inspection.package?.chapterMap.length ?? 0,
    issues: inspection.issues,
  };
}

export function resolveSafeTarget(root: string, entryPath: string): string | undefined {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, ...entryPath.split('/'));
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : absoluteRoot + sep;
  return target === absoluteRoot || target.startsWith(prefix) ? target : undefined;
}

async function visitZipEntries(
  sourcePath: string,
  visitor: (entry: Entry, index: number, zip: ReadZipFile) => Promise<void>,
): Promise<void> {
  const zip = await openReadZip(sourcePath);
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    let index = 0;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(
        error instanceof EpubArchiveError
          ? error
          : new EpubArchiveError('invalid_zip', `Cannot process EPUB ZIP: ${errorMessage(error)}`, {
              cause: error,
            }),
      );
    };
    zip.on('entry', (entry: Entry) => {
      const entryIndex = index;
      index += 1;
      void visitor(entry, entryIndex, zip).then(
        () => {
          if (!settled) zip.readEntry();
        },
        fail,
      );
    });
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      zip.close();
      resolvePromise();
    });
    zip.on('error', fail);
    zip.readEntry();
  });
}

function openReadZip(sourcePath: string): Promise<ReadZipFile> {
  return new Promise<ReadZipFile>((resolvePromise, reject) => {
    openZip(
      sourcePath,
      {
        autoClose: false,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error !== null || zip === undefined) {
          reject(
            new EpubArchiveError(
              'invalid_zip',
              `Not a readable ZIP archive: ${error?.message ?? 'unknown error'}`,
              { cause: error ?? undefined },
            ),
          );
          return;
        }
        resolvePromise(zip);
      },
    );
  });
}

function normalizeEntryPath(fileName: string): string {
  if (fileName.includes('\\')) {
    throw new EpubArchiveError('unsafe_entry_path', `ZIP entry uses backslashes: ${fileName}`);
  }
  if (fileName.includes('\0') || fileName.startsWith('/') || /^[A-Za-z]:/.test(fileName)) {
    throw new EpubArchiveError('unsafe_entry_path', `ZIP entry has an unsafe path: ${fileName}`);
  }
  const directory = fileName.endsWith('/');
  const segments = fileName.split('/');
  if (directory) segments.pop();
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new EpubArchiveError('unsafe_entry_path', `ZIP entry has an unsafe path: ${fileName}`);
  }
  return directory ? `${segments.join('/')}/` : segments.join('/');
}

function validateEntryMetadata(
  entry: Entry,
  path: string,
  directory: boolean,
  issues: EpubIssue[],
): void {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    issues.push({
      severity: 'error',
      code: 'encrypted_entry',
      message: 'Encrypted ZIP entries are not supported.',
      path,
    });
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    issues.push({
      severity: 'error',
      code: 'unsupported_compression_method',
      message: `ZIP compression method ${String(entry.compressionMethod)} is not supported.`,
      path,
    });
  }
  if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
    throw new EpubArchiveError(
      'entry_size_limit_exceeded',
      `ZIP entry "${path}" expands beyond ${String(MAX_ENTRY_UNCOMPRESSED_BYTES)} bytes.`,
    );
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
  ) {
    throw new EpubArchiveError(
      'compression_ratio_exceeded',
      `ZIP entry "${path}" exceeds the ${String(MAX_COMPRESSION_RATIO)}:1 compression-ratio limit.`,
    );
  }

  const hostSystem = entry.versionMadeBy >>> 8;
  if (hostSystem === UNIX_HOST_SYSTEM) {
    const mode = entry.externalFileAttributes >>> 16;
    const fileType = mode & UNIX_FILE_TYPE_MASK;
    if (
      fileType !== 0 &&
      fileType !== (directory ? UNIX_DIRECTORY : UNIX_REGULAR_FILE)
    ) {
      issues.push({
        severity: 'error',
        code: 'special_file_entry',
        message: 'Symbolic links and other special-file ZIP entries are not allowed.',
        path,
      });
    }
  }
}

function toZipEntry(entry: Entry, path: string, directory: boolean, index: number): EpubZipEntry {
  return {
    index,
    path,
    directory,
    compressionMethod: entry.compressionMethod,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    crc32: formatCrc32(entry.crc32),
    modifiedAt: safeModifiedAt(entry),
    mode: (entry.externalFileAttributes >>> 16) & 0xffff,
    encrypted: (entry.generalPurposeBitFlag & 0x1) !== 0,
  };
}

async function readEntryContent(
  zip: ReadZipFile,
  entry: Entry,
  maxBytes: number,
): Promise<EntryContent> {
  if (entry.uncompressedSize > maxBytes) {
    throw new EpubArchiveError(
      'entry_read_limit_exceeded',
      `Entry "${entry.fileName}" exceeds the ${String(maxBytes)} byte read limit.`,
    );
  }
  const stream = await openEntryReadStream(zip, entry);
  // yauzl's fd-slicer ReadStream only flows through 'data' events; async
  // iteration over it never triggers _read. Collect events explicitly.
  return await new Promise<EntryContent>((resolvePromise, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let crc32 = 0xffffffff;
    stream.on('data', (rawChunk: Buffer) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        stream.destroy();
        reject(
          new EpubArchiveError(
            'entry_read_limit_exceeded',
            `Entry "${entry.fileName}" exceeds the ${String(maxBytes)} byte read limit.`,
          ),
        );
        return;
      }
      crc32 = updateCrc32(crc32, chunk);
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      const result = { buffer: Buffer.concat(chunks), crc32: finalizeCrc32(crc32), bytes };
      try {
        assertEntryDigest(entry, result);
        resolvePromise(result);
      } catch (error) {
        reject(error);
      }
    });
    stream.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.resume();
  });
}

function openEntryReadStream(
  zip: ReadZipFile,
  entry: Entry,
): Promise<Readable> {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null || stream === undefined) {
        reject(error ?? new Error('ZIP entry stream is unavailable.'));
        return;
      }
      resolvePromise(stream as Readable);
    });
  });
}

async function extractEntry(
  zip: ReadZipFile,
  entry: Entry,
  target: string,
): Promise<ExtractionDigest> {
  const source = await openEntryReadStream(zip, entry);
  let bytes = 0;
  let crc32 = 0xffffffff;
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ENTRY_UNCOMPRESSED_BYTES) {
        callback(new EpubArchiveError('entry_size_limit_exceeded', `Entry exceeds the extraction size limit: ${entry.fileName}`));
        return;
      }
      crc32 = updateCrc32(crc32, chunk);
      callback(null, chunk);
    },
  });
  await pipeline(source, digest, createWriteStream(target, { flags: 'wx' }));
  return { bytes, crc32: finalizeCrc32(crc32) };
}

function assertEntryDigest(
  entry: Entry,
  digest: Pick<ExtractionDigest, 'bytes' | 'crc32'>,
): void {
  if (digest.bytes !== entry.uncompressedSize) {
    throw new EpubArchiveError(
      'entry_size_mismatch',
      `Entry "${entry.fileName}" produced ${String(digest.bytes)} bytes; expected ${String(entry.uncompressedSize)}.`,
    );
  }
  if (digest.crc32 !== (entry.crc32 >>> 0)) {
    throw new EpubArchiveError(
      'entry_crc_mismatch',
      `Entry "${entry.fileName}" failed CRC-32 validation.`,
    );
  }
}

function parseRootfiles(containerContent: Buffer | undefined, issues: EpubIssue[]) {
  if (containerContent === undefined) {
    issues.push({
      severity: 'error',
      code: 'missing_container',
      message: `Required EPUB entry "${EPUB_CONTAINER_PATH}" is missing or unreadable.`,
      path: EPUB_CONTAINER_PATH,
    });
    return [];
  }
  try {
    const rootfiles = parseContainerXml(decodeXml(containerContent, EPUB_CONTAINER_PATH));
    if (rootfiles.length === 0) {
      issues.push({
        severity: 'error',
        code: 'missing_rootfile',
        message: 'container.xml does not declare an OPF rootfile.',
        path: EPUB_CONTAINER_PATH,
      });
    }
    return rootfiles;
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'invalid_container',
      message: `Cannot parse container.xml: ${errorMessage(error)}`,
      path: EPUB_CONTAINER_PATH,
    });
    return [];
  }
}

function selectRootfile(
  rootfiles: ReturnType<typeof parseRootfiles>,
  archivePaths: ReadonlySet<string>,
  issues: EpubIssue[],
): string | undefined {
  if (rootfiles.length > 1) {
    issues.push({
      severity: 'warning',
      code: 'multiple_rootfiles',
      message: 'container.xml declares multiple rootfiles; the first OPF-compatible entry is selected deterministically.',
      path: EPUB_CONTAINER_PATH,
    });
  }
  const selected =
    rootfiles.find((rootfile) => rootfile.mediaType === 'application/oebps-package+xml') ??
    rootfiles[0];
  if (selected !== undefined && !archivePaths.has(selected.path)) {
    issues.push({
      severity: 'error',
      code: 'missing_rootfile_entry',
      message: `container.xml points to missing OPF entry "${selected.path}".`,
      path: EPUB_CONTAINER_PATH,
    });
    return undefined;
  }
  return selected?.path;
}

async function readPhysicalFirstEntry(sourcePath: string): Promise<PhysicalFirstEntry> {
  const file = await openFile(sourcePath, 'r');
  try {
    const fixedHeader = Buffer.alloc(30);
    const fixedRead = await file.read(fixedHeader, 0, fixedHeader.length, 0);
    if (fixedRead.bytesRead !== fixedHeader.length || fixedHeader.readUInt32LE(0) !== 0x04034b50) {
      return {};
    }
    const fileNameLength = fixedHeader.readUInt16LE(26);
    const extraFieldLength = fixedHeader.readUInt16LE(28);
    const fileName = Buffer.alloc(fileNameLength);
    const nameRead = await file.read(fileName, 0, fileName.length, 30);
    if (nameRead.bytesRead !== fileName.length) return {};
    return {
      path: fileName.toString((fixedHeader.readUInt16LE(6) & 0x800) !== 0 ? 'utf8' : 'latin1'),
      compressionMethod: fixedHeader.readUInt16LE(8),
      extraFieldLength,
    };
  } finally {
    await file.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function safeModifiedAt(entry: Entry): string {
  try {
    return entry.getLastModDate().toISOString();
  } catch {
    return '1980-01-01T00:00:00.000Z';
  }
}

function portablePathKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function normalizeManifestRelativePath(path: string | undefined): string {
  const input = path ?? EPUB_MANIFEST_RELATIVE_PATH;
  if (isAbsolute(input)) {
    throw new EpubArchiveError('unsafe_manifest_path', 'Unpack manifest path must be relative to the output directory.');
  }
  const normalized = normalizeEntryPath(input.replaceAll('\\', '/'));
  if (normalized.endsWith('/')) {
    throw new EpubArchiveError('unsafe_manifest_path', 'Unpack manifest path must name a file, not a directory.');
  }
  return normalized;
}

function resolveManifestPath(root: string, path: string | undefined): string {
  if (path === undefined) return join(root, ...EPUB_MANIFEST_RELATIVE_PATH.split('/'));
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new EpubArchiveError('unsafe_manifest_path', 'Repack manifest path must be inside the unpacked EPUB directory.');
  }
  return candidate;
}

async function readInspectionManifest(path: string): Promise<EpubInspection> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new EpubArchiveError('invalid_manifest', `Cannot read EPUB inspection manifest "${path}": ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('schemaVersion' in parsed) ||
    parsed.schemaVersion !== EPUB_INSPECTION_SCHEMA_VERSION ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries) ||
    !('source' in parsed) ||
    typeof parsed.source !== 'object' ||
    parsed.source === null ||
    !('path' in parsed.source) ||
    typeof parsed.source.path !== 'string' ||
    !('sha256' in parsed.source) ||
    typeof parsed.source.sha256 !== 'string' ||
    !('valid' in parsed) ||
    typeof parsed.valid !== 'boolean' ||
    !('issues' in parsed) ||
    !Array.isArray(parsed.issues)
  ) {
    throw new EpubArchiveError('invalid_manifest', 'EPUB inspection manifest has an unsupported or invalid schema.');
  }
  return parsed as EpubInspection;
}

function validateManifestEntries(inspection: EpubInspection): void {
  if (inspection.entries.length === 0 || inspection.entries[0]?.path !== 'mimetype') {
    throw new EpubArchiveError('invalid_manifest', 'EPUB manifest does not begin with the mimetype entry.');
  }
  const seen = new Set<string>();
  for (const [index, entry] of inspection.entries.entries()) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      entry.index !== index ||
      typeof entry.path !== 'string' ||
      typeof entry.directory !== 'boolean'
    ) {
      throw new EpubArchiveError('invalid_manifest', `EPUB manifest entry ${String(index)} is invalid.`);
    }
    const path = normalizeEntryPath(entry.path);
    if (path !== entry.path || seen.has(portablePathKey(path))) {
      throw new EpubArchiveError('invalid_manifest', `EPUB manifest entry path is unsafe or duplicated: ${entry.path}`);
    }
    seen.add(portablePathKey(path));
  }
}

async function verifyRepackTree(
  root: string,
  entries: readonly EpubZipEntry[],
  manifestRelativePath: string,
): Promise<void> {
  const expectedFiles = new Set(entries.filter((entry) => !entry.directory).map((entry) => portablePathKey(entry.path)));
  const expectedDirectories = new Set(entries.filter((entry) => entry.directory).map((entry) => portablePathKey(entry.path)));

  for (const entry of entries) {
    const target = resolveSafeTarget(root, entry.path);
    if (target === undefined) {
      throw new EpubArchiveError('unsafe_entry_path', `Manifest entry escapes input directory: ${entry.path}`);
    }
    const targetStat = await lstat(target).catch(() => undefined);
    if (targetStat === undefined) {
      throw new EpubArchiveError('missing_repack_resource', `Required EPUB resource is missing: ${entry.path}`);
    }
    if (targetStat.isSymbolicLink()) {
      throw new EpubArchiveError('symlink_resource', `Symbolic links are not allowed in EPUB input: ${entry.path}`);
    }
    if (entry.directory ? !targetStat.isDirectory() : !targetStat.isFile()) {
      throw new EpubArchiveError('resource_type_changed', `EPUB resource type changed: ${entry.path}`);
    }
  }

  const diskEntries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const diskEntry of diskEntries) {
    const relativePath = relative(root, join(diskEntry.parentPath, diskEntry.name))
      .split(sep)
      .join('/');
    if (portablePathKey(relativePath) === portablePathKey(manifestRelativePath)) continue;
    if (diskEntry.isSymbolicLink()) {
      throw new EpubArchiveError('symlink_resource', `Symbolic links are not allowed in EPUB input: ${relativePath}`);
    }
    if (diskEntry.isFile() && !expectedFiles.has(portablePathKey(relativePath))) {
      throw new EpubArchiveError('unexpected_repack_resource', `Unexpected file would not be included in the EPUB: ${relativePath}`);
    }
    const directoryKey = portablePathKey(`${relativePath}/`);
    const isMetadataDirectory = portablePathKey(manifestRelativePath).startsWith(directoryKey);
    if (diskEntry.isDirectory() && !expectedDirectories.has(directoryKey) && !isMetadataDirectory) {
      const hasExpectedDescendant = [...expectedFiles, ...expectedDirectories].some((path) => path.startsWith(directoryKey));
      if (!hasExpectedDescendant) {
        throw new EpubArchiveError('unexpected_repack_directory', `Unexpected directory would not be included in the EPUB: ${relativePath}/`);
      }
    }
  }
}

async function writeEpubArchive(
  root: string,
  outputPath: string,
  entries: readonly EpubZipEntry[],
): Promise<void> {
  const zip = new WriteZipFile();
  const output = zip.outputStream as unknown as Readable;
  const destination = createWriteStream(outputPath, { flags: 'wx' });
  const writing = pipeline(output, destination);
  try {
    for (const entry of entries) {
      const source = resolveSafeTarget(root, entry.path);
      if (source === undefined) {
        throw new EpubArchiveError('unsafe_entry_path', `Manifest entry escapes input directory: ${entry.path}`);
      }
      const options = {
        compress: entry.path === 'mimetype' ? false : entry.compressionMethod !== 0,
        mtime: new Date(entry.modifiedAt),
        mode: entry.mode === 0 ? undefined : entry.mode,
      };
      if (entry.directory) {
        zip.addEmptyDirectory(entry.path, options);
      } else if (entry.path === 'mimetype') {
        zip.addBuffer(await readFile(source), entry.path, options);
      } else {
        zip.addFile(source, entry.path, options);
      }
    }
    zip.end();
    await writing;
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
    await writing.catch(() => {});
    throw error;
  }
}

async function restoreMetadata(target: string, entry: Entry): Promise<void> {
  const mode = (entry.externalFileAttributes >>> 16) & 0o777;
  if (mode !== 0) await chmod(target, mode).catch(() => {});
  const modifiedAt = entry.getLastModDate();
  await utimes(target, modifiedAt, modifiedAt).catch(() => {});
}

function assertValidInspection(inspection: EpubInspection, operation: string): void {
  if (inspection.valid) return;
  const errors = inspection.issues
    .filter((issue) => issue.severity === 'error')
    .slice(0, 5)
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join('; ');
  throw new EpubArchiveError(
    'invalid_epub',
    `Cannot ${operation} invalid EPUB${errors === '' ? '.' : `: ${errors}`}`,
  );
}

function sameEntryOrder(left: readonly EpubZipEntry[], right: readonly EpubZipEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry.path === right[index]?.path);
}

function destinationName(path: string): string {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  return name === '' ? 'output.epub' : name;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function formatCrc32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

const CRC32_TABLE = makeCrc32Table();

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(current: number, chunk: Buffer): number {
  let value = current >>> 0;
  for (const byte of chunk) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

function finalizeCrc32(value: number): number {
  return (value ^ 0xffffffff) >>> 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
