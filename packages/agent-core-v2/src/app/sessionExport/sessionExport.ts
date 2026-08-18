/**
 * `sessionExport` domain — session diagnostic export contract.
 *
 * Defines the App-scope `ISessionExportService`, which packages a persisted
 * session directory plus optional global diagnostics into a zip archive. The
 * service coordinates live Session/Agent scope flushing before reading the
 * on-disk state, while the export manifest stays a JSON data contract.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ShellEnvironment {
  readonly term?: string | undefined;
  readonly termProgram?: string | undefined;
  readonly termProgramVersion?: string | undefined;
  readonly multiplexer?: string | undefined;
  readonly shell?: string | undefined;
}

export interface ExportSessionPayload {
  readonly sessionId: string;
  readonly outputPath?: string | undefined;
  readonly includeGlobalLog?: boolean | undefined;
  readonly includeDesktopLog?: boolean;
  readonly version: string;
  readonly desktopVersion?: string;
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
  readonly redacted?: boolean;
  readonly diagnostics?: ExportDiagnosticContext;
}

export interface ExportDiagnosticContext {
  readonly product: string;
  readonly upstreamBaseline: string;
  readonly runtime: {
    readonly os: NodeJS.Platform;
    readonly arch: string;
    readonly node: string;
  };
  readonly engine: {
    readonly pid: number;
    readonly serverId: string;
    readonly origin: string;
    readonly port: number;
  };
  readonly model?: {
    readonly configured?: string;
    readonly provider?: string;
  };
  readonly config: {
    readonly defaultModelConfigured: boolean;
    readonly providerCount: number;
    readonly modelAliasCount: number;
    readonly telemetryEnabled: boolean;
    readonly thinkingEnabled: boolean;
  };
  readonly project?: {
    readonly schemaVersion?: number;
    readonly projectId?: string;
    readonly revision?: number;
    readonly status?: string;
    readonly activeStageId?: string;
    readonly instructionVersion?: number;
    readonly sourceKind?: string;
    readonly chapterCount?: number;
    readonly completedChapterCount?: number;
    readonly openIssueCount?: number;
    readonly artifactCount?: number;
  };
  readonly health: {
    readonly sessionIndex: string;
    readonly ledger: string;
    readonly workers: string;
    readonly rag: string;
    readonly crash: {
      readonly status: 'unavailable';
      readonly reason: string;
    };
  };
}

export interface ExportSessionManifest {
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly kimiCodeVersion: string;
  readonly wireProtocolVersion: string;
  readonly os: string;
  readonly nodejsVersion: string;
  readonly sessionFirstActivity?: string | undefined;
  readonly sessionLastActivity?: string | undefined;
  readonly title?: string | undefined;
  readonly workspaceDir?: string | undefined;
  readonly sessionLogPath?: string | undefined;
  readonly globalLogPath?: string | undefined;
  readonly desktopLogPath?: string;
  readonly webLogPath?: string;
  readonly desktopVersion?: string;
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
  readonly exportKind?: 'full-session' | 'redacted-diagnostics';
  readonly privacy?: {
    readonly rawSessionIncluded: boolean;
    readonly sourceTextIncluded: boolean;
    readonly credentialsIncluded: false;
  };
  readonly diagnostics?: ExportDiagnosticContext;
}

export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly sessionDir: string;
  readonly manifest: ExportSessionManifest;
}

export interface ExportSessionOptions {
  readonly webLog?: string;
  readonly signal?: AbortSignal;
  readonly maxArchiveBytes?: number;
}

export interface ISessionExportService {
  readonly _serviceBrand: undefined;

  export(
    input: ExportSessionPayload,
    options?: ExportSessionOptions,
  ): Promise<ExportSessionResult>;
}

export const ISessionExportService: ServiceIdentifier<ISessionExportService> =
  createDecorator<ISessionExportService>('sessionExportService');
