export const EPUB_INSPECTION_SCHEMA_VERSION = 1;

export type EpubIssueSeverity = 'error' | 'warning';

export interface EpubIssue {
  readonly severity: EpubIssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface EpubSourceIdentity {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface EpubZipEntry {
  readonly index: number;
  readonly path: string;
  readonly directory: boolean;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: string;
  readonly modifiedAt: string;
  readonly mode: number;
  readonly encrypted: boolean;
}

export interface EpubRootfile {
  readonly path: string;
  readonly mediaType?: string;
}

export interface EpubContainerInspection {
  readonly path: 'META-INF/container.xml';
  readonly rootfiles: readonly EpubRootfile[];
  readonly selectedRootfile?: string;
}

export interface EpubPackageMetadata {
  readonly version?: string;
  readonly uniqueIdentifier?: string;
  readonly title?: string;
  readonly language?: string;
  readonly identifier?: string;
}

export interface EpubPackageManifestItem {
  readonly id: string;
  readonly href: string;
  readonly path?: string;
  readonly mediaType: string;
  readonly properties: readonly string[];
  readonly remote: boolean;
}

export interface EpubSpineItem {
  readonly index: number;
  readonly idref: string;
  readonly linear: boolean;
  readonly properties: readonly string[];
  readonly path?: string;
  readonly mediaType?: string;
}

export interface EpubChapterMapItem {
  readonly chapterIndex: number;
  readonly spineIndex: number;
  readonly idref: string;
  readonly href: string;
  readonly path: string;
  readonly mediaType: string;
  readonly linear: boolean;
  readonly properties: readonly string[];
}

export interface EpubPackageInspection {
  readonly path: string;
  readonly metadata: EpubPackageMetadata;
  readonly manifest: readonly EpubPackageManifestItem[];
  readonly spine: readonly EpubSpineItem[];
  readonly chapterMap: readonly EpubChapterMapItem[];
}

export interface EpubInspection {
  readonly schemaVersion: typeof EPUB_INSPECTION_SCHEMA_VERSION;
  readonly source: EpubSourceIdentity;
  readonly valid: boolean;
  readonly mimetype: {
    readonly firstEntry: boolean;
    readonly stored: boolean;
    readonly noExtraField: boolean;
    readonly contentValid: boolean;
  };
  readonly entries: readonly EpubZipEntry[];
  readonly container: EpubContainerInspection;
  readonly package?: EpubPackageInspection;
  readonly issues: readonly EpubIssue[];
}

export interface InspectEpubOptions {
  readonly verifyCrc?: boolean;
}

export interface UnpackEpubOptions {
  readonly manifestPath?: string;
}

export interface UnpackEpubResult {
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly entryCount: number;
  readonly chapterCount: number;
  readonly sourceSha256: string;
}

export interface RepackEpubOptions {
  readonly manifestPath?: string;
}

export interface RepackEpubResult {
  readonly outputPath: string;
  readonly entryCount: number;
  readonly chapterCount: number;
  readonly sha256: string;
}

export interface ValidateEpubResult {
  readonly valid: boolean;
  readonly path: string;
  readonly sha256: string;
  readonly entryCount: number;
  readonly chapterCount: number;
  readonly issues: readonly EpubIssue[];
}

export class EpubArchiveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EpubArchiveError';
  }
}
