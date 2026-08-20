import type {
  AffectedScope,
  InstructionApplicationResult,
  InterruptMode,
} from '@batch-translating/translation-domain';
import type {
  BookManifest,
  DeterministicReportInput,
  FinalArtifactReceipt,
  TranslationRecord,
} from '@batch-translating/translation-tools';

export const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const SAFE_FILE_ID = /^f_[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const SHA256 = /^[a-f0-9]{64}$/;

export interface RuntimeTranslationSource {
  readonly kind: 'epub' | 'txt';
  readonly sourcePath: string;
  readonly immutable: true;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly chapterPattern?: string;
}

export interface RuntimeTranslationPaths {
  readonly projectRoot: string;
  readonly sourcePath: string;
  readonly sourceCopy: string;
  readonly unpackedDir: string;
  readonly manifestPath: string;
  readonly memoryDir: string;
  readonly translationDir: string;
  readonly reviewsDir: string;
  readonly repairsDir: string;
  readonly finalDir: string;
  readonly logsDir: string;
  readonly stateDir: string;
  readonly taskManifestPath: string;
  readonly issuesPath: string;
  readonly checkpointPath: string;
  readonly finalOutputPath: string;
  readonly finalReportPath: string;
}

/**
 * The server deliberately keeps the UI-owned project metadata extensible. It
 * validates every field it relies on, then persists only normalized ledger
 * facts; unknown UI projection fields never become filesystem authority.
 */
export interface RuntimeTranslationProject {
  readonly schemaVersion: number;
  readonly projectId: string;
  readonly name: string;
  readonly languages: {
    readonly source: string;
    readonly target: 'zh-CN' | 'en';
  };
  readonly model: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: RuntimeTranslationSource;
  readonly paths: RuntimeTranslationPaths;
  readonly workflow: {
    readonly secondTranslation: boolean;
    readonly secondReview: boolean;
    readonly consistencyReview: boolean;
  };
  readonly executionPolicy: {
    readonly softBudgetMicros: number | null;
    readonly hardBudgetMicros: number | null;
    readonly maxRetries: number;
    readonly maxConcurrency: number;
  };
  readonly maxAgents: number;
  readonly status: string;
  readonly planFingerprint: string;
  readonly promptVersion: string;
  readonly overrideRevision: number;
  readonly stages: readonly unknown[];
  readonly chapters: readonly unknown[];
  readonly issues: readonly unknown[];
  readonly artifacts: readonly unknown[];
  readonly checkpoints: readonly unknown[];
  readonly overrides: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface InitializeTranslationProjectInput {
  readonly project: RuntimeTranslationProject;
  readonly sourceFileId: string;
  /** Enables exact accounting of Coordinator and sub-agent usage. */
  readonly sessionId?: string;
}

export interface InitializedTranslationProject {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly sourceCopy: string;
  readonly sourceSha256: string;
  readonly sourceSizeBytes: number;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly bookId: string;
  readonly chapterCount: number;
  readonly paragraphCount: number;
  readonly manifest: BookManifest;
  readonly chapters: BookManifest['chapters'];
  readonly sourceReceipt: {
    readonly original: {
      readonly source_path: string;
      readonly format: 'epub' | 'txt';
      readonly sha256: string;
      readonly byte_length: number;
      readonly modified_at_ms: number;
    };
    readonly copied_path: string;
    readonly copied_sha256: string;
    readonly byte_length: number;
    readonly immutable: true;
  };
  readonly reused: boolean;
  readonly ledgerSummary: unknown;
  readonly quality: TranslationQualityStatus;
  readonly integrityOk: boolean;
}

export interface ProjectReference {
  readonly projectId: string;
  readonly projectRoot: string;
}

export interface ApplyProjectInstructionInput extends ProjectReference {
  readonly sessionMessageId: string;
  readonly message: string;
  readonly affectedScope: AffectedScope;
  readonly interruptMode?: InterruptMode;
}

export interface AppliedProjectInstruction {
  readonly result: InstructionApplicationResult;
  readonly ledgerSummary: unknown;
  readonly integrity: unknown;
}

export interface VerifyCompletionInput extends ProjectReference {
  readonly finalArtifact?: FinalArtifactReceipt;
  readonly finalArtifactIds?: readonly string[];
  readonly finalTaskTypes?: readonly string[];
  readonly requiredTaskTypes?: readonly string[];
}

export interface VerifiedCompletionReceipt {
  readonly verified: boolean;
  readonly projectId: string;
  readonly outputPath: string;
  readonly artifactSha256: string;
  readonly byteLength: number;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly planFingerprint: string;
  readonly instructionVersion: number;
  readonly structuralValidation: unknown;
  /** Receipt recovered from the immutable selected ledger artifact. */
  readonly finalArtifact?: FinalArtifactReceipt;
  readonly completion: unknown;
  readonly integrity: unknown;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly verifiedAt: string;
}

export interface WriteProjectReportInput extends ProjectReference {
  readonly outputPath?: string;
  /**
   * The immutable render receipt and translations are cross-checked against
   * the manifest/ledger. They are data inputs, never authority for completion.
   */
  readonly finalArtifact?: FinalArtifactReceipt;
  readonly finalArtifactIds?: readonly string[];
  readonly finalTaskTypes?: readonly string[];
  readonly requiredTaskTypes?: readonly string[];
  readonly translations?: readonly TranslationRecord[];
  readonly ragConfiguration?: Readonly<Record<string, string | number | boolean>>;
}

export interface ProjectReportReceipt {
  readonly projectId: string;
  readonly ledgerSnapshot: unknown;
  readonly reportInput: DeterministicReportInput;
  readonly report: {
    readonly output_path: string;
    readonly sha256: string;
    readonly byte_length: number;
    readonly immutable: true;
  };
  readonly warnings: readonly string[];
}

export type BgeSetupStatus =
  | 'detected'
  | 'missing'
  | 'downloading'
  | 'verifying'
  | 'available'
  | 'failed';

export interface TranslationQualityStatus {
  readonly available: boolean;
  readonly bgeStatus: BgeSetupStatus;
  readonly ragServiceStatus: 'not_started' | 'ready' | 'degraded' | 'unavailable';
  readonly forcedSecondReview: boolean;
  readonly adjacentChapterAudit: boolean;
  readonly extraCostWarning: boolean;
  readonly warnings: readonly string[];
}

export interface BgeRuntimeStatus {
  readonly status: BgeSetupStatus;
  readonly source: 'mirror' | 'official';
  readonly progress?: number;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number;
  readonly diskAvailableBytes?: number;
  readonly diskRequiredBytes?: number;
  readonly modelPath?: string;
  readonly fingerprint?: string;
  readonly cpuFallback: boolean;
  readonly serviceStatus: 'not_started' | 'ready' | 'degraded' | 'unavailable';
  readonly degraded: boolean;
  readonly denseReady: boolean;
  readonly indexReady: boolean;
  readonly points: number;
  readonly capabilities?: unknown;
  readonly error?: string;
  readonly errorCode?:
    | 'network'
    | 'disk_space'
    | 'permission'
    | 'checksum'
    | 'invalid_model'
    | 'service_unavailable'
    | 'cancelled'
    | 'unknown';
  readonly recommendedVramGb: 4;
  readonly qualityMessage: string;
  readonly fallbackMessage: string;
  readonly modelDownloadIsExplicit: true;
}

export interface LoadedProject {
  readonly project: RuntimeTranslationProject;
  readonly manifest: BookManifest;
}
