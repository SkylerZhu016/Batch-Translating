/**
 * `sessionExport` domain — `ISessionExportService` implementation.
 *
 * Coordinates live session flushing through the live workspace handler
 * registry, derives session paths from the handler-chain addressing, reads
 * persisted summaries through the session index, and packages diagnostic
 * files through the local zip writer. Bound at App scope.
 */

import { join, resolve } from 'pathe';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { resolveGlobalLogPath } from '#/_base/log/logConfig';
import { IWireService } from '#/wire/wire';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IWorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycle';
import { IWorkspaceService } from '#/app/workspace/workspace';
import {
  sessionDirOf,
  workspacePersistenceScope,
} from '#/workspace/sessionLifecycle/internal/addressing';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { buildExportManifest, type ExportSessionManifestSummary } from './manifest';
import {
  type ExportSessionPayload,
  type ExportSessionResult,
  type ExportSessionOptions,
  ISessionExportService,
} from './sessionExport';
import { scanSessionWire } from './wire-scan';
import {
  type ExtraZipEntry,
  type SessionZipEntry,
  collectFilesRecursive,
  writeExportZip,
} from './zip';
import { openZipSource, type ZipSource } from './file-source';

const SESSION_LOG_REL = 'logs/kimi-code.log';
const GLOBAL_LOG_REL = 'logs/global/kimi-code.log';
const WEB_LOG_REL = 'logs/kimi-web.jsonl';
const DESKTOP_LOG_REL = 'logs/kimi-desktop.log';

export class SessionExportService implements ISessionExportService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionIndex private readonly index: ISessionIndex,
    @IWorkspaceLifecycleService private readonly workspaceLifecycle: IWorkspaceLifecycleService,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @ILogService private readonly log: ILogService,
  ) {}

  async export(
    input: ExportSessionPayload,
    options: ExportSessionOptions = {},
  ): Promise<ExportSessionResult> {
    options.signal?.throwIfAborted();
    if (input.version.trim().length === 0) {
      throw new Error2(
        ErrorCodes.SESSION_EXPORT_MISSING_VERSION,
        'Session export requires a host version.',
        { details: { sessionId: input.sessionId } },
      );
    }

    const summary = await this.index.get(input.sessionId);
    if (summary === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `Session "${input.sessionId}" does not exist`,
        { details: { sessionId: input.sessionId } },
      );
    }

    const liveSummary = await this.flushLiveSession(summary);
    options.signal?.throwIfAborted();
    if (input.includeGlobalLog === true) {
      await this.warnIfFails('export global log flush failed', () => this.log.flush(), {
        retry: true,
      });
    }

    return exportSessionDirectory({
      request: input,
      summary: liveSummary,
      globalLogPath: resolveGlobalLogPath(this.bootstrap.homeDir),
      desktopLogPath:
        input.includeDesktopLog === true
          ? join(this.bootstrap.homeDir, 'logs', 'kimi-code-desktop.log')
          : undefined,
      webLog: options.webLog,
      signal: options.signal,
      maxArchiveBytes: options.maxArchiveBytes,
    });
  }

  private async flushLiveSession(summary: SessionSummary): Promise<ExportSessionDirectorySummary> {
    const workspace = await this.workspaces.get(summary.workspaceId);
    const sessionDir = sessionDirOf(
      this.bootstrap.homeDir,
      workspacePersistenceScope(this.bootstrap.scope('sessions'), summary.workspaceId),
      summary.id,
    );
    let exportSummary: ExportSessionDirectorySummary = {
      id: summary.id,
      title: summary.title,
      workspaceDir: workspace?.root,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      sessionDir,
    };
    const handle = this.liveSession(summary.id);
    if (handle === undefined) {
      return exportSummary;
    }

    try {
      const metadata = handle.accessor.get(ISessionMetadata);
      await metadata.ready;
      const meta = await metadata.read();
      exportSummary = {
        id: meta.id,
        title: meta.title,
        workspaceDir: workspace?.root,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        sessionDir,
      };
    } catch (error) {
      this.log.warn('flushMetadata failed before export', { error });
    }

    await this.warnIfFails('export session log flush failed', () =>
      handle.accessor.get(ILogService).flush(),
    );
    const agents = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agents.list()) {
      await this.warnIfFails('export agent wire flush failed', () =>
        agent.accessor.get(IWireService).flush(),
      );
    }

    return exportSummary;
  }

  private liveSession(sessionId: string): ISessionScopeHandle | undefined {
    for (const handler of this.workspaceLifecycle.handlers.list()) {
      const handle = handler.accessor.get(ISessionLifecycleService).get(sessionId);
      if (handle !== undefined) return handle;
    }
    return undefined;
  }

  private async warnIfFails(
    message: string,
    operation: () => Promise<void>,
    options: { readonly retry?: boolean } = {},
  ): Promise<void> {
    try {
      await operation();
      return;
    } catch (error) {
      this.log.warn(message, { error });
    }
    if (options.retry !== true) return;
    try {
      await operation();
    } catch {}
  }
}

export interface ExportSessionDirectorySummary extends ExportSessionManifestSummary {
  readonly sessionDir: string;
}

export async function exportSessionDirectory(input: {
  readonly request: ExportSessionPayload;
  readonly summary: ExportSessionDirectorySummary;
  readonly globalLogPath?: string | undefined;
  readonly desktopLogPath?: string | undefined;
  readonly webLog?: string;
  readonly signal?: AbortSignal;
  readonly maxArchiveBytes?: number;
}): Promise<ExportSessionResult> {
  input.signal?.throwIfAborted();
  const sessionDir = input.summary.sessionDir;
  const sessionLogPath = join(sessionDir, SESSION_LOG_REL);
  let sessionLogSource: ZipSource | undefined;
  let sessionLogSourceTransferred = false;
  let globalSource: ZipSource | undefined;
  let globalSourceTransferred = false;
  let desktopSource: ZipSource | undefined;
  let desktopSourceTransferred = false;

  try {
    const redacted = input.request.redacted === true;
    if (!redacted) {
      sessionLogSource = await openOptionalZipSource(sessionLogPath, input.signal);
    }
    if (!redacted && input.request.includeGlobalLog === true && input.globalLogPath !== undefined) {
      globalSource = await openOptionalZipSource(input.globalLogPath, input.signal);
    }
    if (!redacted && input.desktopLogPath !== undefined) {
      desktopSource = await openOptionalZipSource(input.desktopLogPath, input.signal);
    }
    const sessionFiles = redacted ? [] : await collectFilesRecursive(sessionDir);
    if (!redacted && sessionFiles.length === 0 && sessionLogSource === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_EXPORT_NOT_FOUND,
        `Session "${input.summary.id}" has no exportable directory at "${sessionDir}"`,
        { details: { sessionId: input.summary.id, sessionDir } },
      );
    }

    const sessionScan = redacted ? {} : await scanSessionWire(sessionDir, input.signal);
    const stableSessionLog = sessionLogSource;
    const selectedSessionFiles: SessionZipEntry[] = sessionFiles.filter(
      (file) => file !== sessionLogPath,
    );
    if (stableSessionLog !== undefined) {
      selectedSessionFiles.push({ path: sessionLogPath, source: stableSessionLog });
      selectedSessionFiles.sort((left, right) =>
        sessionZipEntryPath(left).localeCompare(sessionZipEntryPath(right)),
      );
    }
    const webLog = redacted ? sanitizeDiagnosticWebLog(input.webLog) : input.webLog;
    const bundledWebLog = webLog !== undefined;
    const now = new Date();
    const baseManifest = buildExportManifest({
      summary: input.summary,
      now,
      version: input.request.version,
      sessionScan,
      sessionLogPath: stableSessionLog === undefined ? undefined : SESSION_LOG_REL,
      webLogPath: bundledWebLog ? WEB_LOG_REL : undefined,
      desktopVersion: input.request.desktopVersion,
      installSource: input.request.installSource,
      shellEnv: input.request.shellEnv,
      redacted,
      diagnostics: input.request.diagnostics,
    });
    const outputPath =
      input.request.outputPath !== undefined
        ? resolve(input.request.outputPath)
        : resolve(defaultExportZipName(input.summary.id, now));
    const extras: ExtraZipEntry[] = [];
    if (webLog !== undefined) {
      extras.push({ data: Buffer.from(webLog, 'utf8'), target: WEB_LOG_REL });
    }
    if (globalSource !== undefined) {
      extras.push({ source: globalSource, target: GLOBAL_LOG_REL });
    }
    if (desktopSource !== undefined) {
      extras.push({ source: desktopSource, target: DESKTOP_LOG_REL });
    }
    const manifest = {
      ...baseManifest,
      globalLogPath: globalSource === undefined ? undefined : GLOBAL_LOG_REL,
      desktopLogPath: desktopSource === undefined ? undefined : DESKTOP_LOG_REL,
    };

    const writing = writeExportZip({
      outputPath,
      manifest,
      sessionDir,
      sessionFiles: selectedSessionFiles,
      extraEntries: extras,
      signal: input.signal,
      maxArchiveBytes: input.maxArchiveBytes,
    });
    sessionLogSourceTransferred = sessionLogSource !== undefined;
    globalSourceTransferred = globalSource !== undefined;
    desktopSourceTransferred = desktopSource !== undefined;
    const entries = await writing;

    return {
      zipPath: outputPath,
      entries,
      sessionDir,
      manifest,
    };
  } finally {
    if (sessionLogSource !== undefined && !sessionLogSourceTransferred) {
      await sessionLogSource.close().catch(() => {});
    }
    if (globalSource !== undefined && !globalSourceTransferred) {
      await globalSource.close().catch(() => {});
    }
    if (desktopSource !== undefined && !desktopSourceTransferred) {
      await desktopSource.close().catch(() => {});
    }
  }
}

const DIAGNOSTIC_STRING_FIELDS = new Set([
  'event',
  'sessionId',
  'status',
  'operation',
  'errorName',
  'requestId',
  'phase',
]);
const DIAGNOSTIC_NUMBER_FIELDS = new Set([
  'ts',
  'seq',
  'durationMs',
  'messageCount',
  'contentCount',
  'mediaCount',
  'sessionCount',
  'workspaceCount',
  'zipBytes',
  'errorCode',
  'httpStatus',
  'line',
  'col',
]);

export function sanitizeDiagnosticWebLog(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const output: string[] = [];
  for (const line of value.split(/\r?\n/).slice(0, 500)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const input = parsed as Record<string, unknown>;
    const safe: Record<string, string | number | boolean> = {};
    for (const [key, item] of Object.entries(input)) {
      if (DIAGNOSTIC_STRING_FIELDS.has(key) && typeof item === 'string') {
        safe[key] = item.slice(0, 200).replaceAll(/[\r\n]/g, ' ');
      } else if (
        DIAGNOSTIC_NUMBER_FIELDS.has(key) &&
        typeof item === 'number' &&
        Number.isFinite(item)
      ) {
        safe[key] = item;
      } else if (key === 'fatal' && typeof item === 'boolean') {
        safe[key] = item;
      }
    }
    if (typeof safe['event'] === 'string' && typeof safe['ts'] === 'number') {
      output.push(JSON.stringify(safe));
    }
  }
  return output.length === 0 ? undefined : output.join('\n');
}

function defaultExportZipName(sessionId: string, now: Date): string {
  const shortId = sessionId.slice(0, 8);
  const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
  return `kimi-debug-${shortId}-${timestamp}.zip`;
}

function sessionZipEntryPath(entry: SessionZipEntry): string {
  return typeof entry === 'string' ? entry : entry.path;
}

async function openOptionalZipSource(
  path: string,
  signal: AbortSignal | undefined,
): Promise<ZipSource | undefined> {
  try {
    return await openZipSource(path, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

registerScopedService(
  LifecycleScope.App,
  ISessionExportService,
  SessionExportService,
  ScopeActivation.OnScopeCreated,
  'sessionExport',
);
