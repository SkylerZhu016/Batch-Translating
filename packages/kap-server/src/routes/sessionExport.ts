/**
 * `POST /sessions/{session_id}/export` — stream a session diagnostic archive.
 *
 * The server owns archive options and temporary paths. A bounded Web JSONL log
 * may be supplied by the client and is added to the archive by sessionExport.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ErrorCodes,
  IConfigService,
  ILogService,
  ISessionIndex,
  ISessionExportService,
  isError2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { errEnvelope } from '../protocol/envelope';
import {
  exportSessionParamsSchema,
  exportSessionRequestSchema,
} from '../protocol/rest-session';

const MAX_WEB_SESSION_EXPORT_BYTES = 64 * 1024 * 1024;

interface SessionExportRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: unknown, reply: SessionExportReply) => unknown,
  ): unknown;
}

interface SessionExportReply {
  type(mime: string): SessionExportReply;
  header(name: string, value: string | number): SessionExportReply;
  send(payload: unknown): unknown;
}

export function registerSessionExportRoute(
  app: SessionExportRouteHost,
  core: Scope,
  options: {
    readonly hostIdentity: KimiHostIdentity;
    readonly serverId: string;
    readonly engineRuntime: () => { readonly origin: string; readonly port: number };
  },
): void {
  const log = core.accessor.get(ILogService);
  const route = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/export',
      params: exportSessionParamsSchema,
      body: exportSessionRequestSchema,
      rawResponse: {
        200: { type: 'string', format: 'binary' },
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FILE_TOO_LARGE]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Export a redacted diagnostic archive for a session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const response = reply as unknown as SessionExportReply;
      let tempDir: string | undefined;
      let cleanupPromise: Promise<void> | undefined;

      const cleanup = async (): Promise<void> => {
        if (tempDir === undefined) return;
        cleanupPromise ??= rm(tempDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        }).catch((error: unknown) => {
          log.warn('session export temporary directory cleanup failed', {
            error,
            requestId: req.id,
            tempDir,
          });
        });
        await cleanupPromise;
      };

      try {
        const safeSessionId = sanitizeSessionId(req.params.session_id);
        tempDir = await mkdtemp(join(tmpdir(), `kimi-session-export-${safeSessionId}-`));

        const outputPath = join(tempDir, 'session.zip');
        const diagnostics = await buildDiagnosticContext(
          core,
          req.params.session_id,
          options,
        );
        await core.accessor.get(ISessionExportService).export(
          {
            sessionId: req.params.session_id,
            outputPath,
            includeGlobalLog: false,
            includeDesktopLog: false,
            version: options.hostIdentity.version,
            desktopVersion:
              req.body.desktop === true ? options.hostIdentity.version : undefined,
            redacted: true,
            diagnostics,
          },
          {
            webLog: req.body.web_log,
            maxArchiveBytes: MAX_WEB_SESSION_EXPORT_BYTES,
          },
        );

        const archive = await stat(outputPath);
        // The archive is capped at 64 MiB by the export service, so buffering it
        // here is bounded. Sending a complete Buffer also avoids a Fastify/Node
        // stream-close race observed with browser fetch clients on Windows,
        // where the response could end as an empty 204 while the archive itself
        // had been generated successfully.
        const payload = await readFile(outputPath);
        await cleanup();

        return response
          .type('application/zip')
          .header(
            'content-disposition',
            `attachment; filename="kimi-session-${safeSessionId}.zip"`,
          )
          .header('content-length', archive.size)
          .header('cache-control', 'no-store')
          .send(payload) as void;
      } catch (error) {
        await cleanup();
        sendMappedError(response, req, error);
      }
    },
  );

  app.post(
    route.path,
    route.options,
    route.handler as unknown as Parameters<SessionExportRouteHost['post']>[2],
  );
}

const UPSTREAM_BASELINE = '53c832dfdf9566afd59a8b3d54ebd36d3cb03d72';

async function buildDiagnosticContext(
  core: Scope,
  sessionId: string,
  options: {
    readonly hostIdentity: KimiHostIdentity;
    readonly serverId: string;
    readonly engineRuntime: () => { readonly origin: string; readonly port: number };
  },
) {
  const index = core.accessor.get(ISessionIndex);
  const summary = await index.get(sessionId);
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const resolved = config.getAll();
  const configured = nonEmptyString(resolved['defaultModel']);
  const providers = isRecord(resolved['providers']) ? resolved['providers'] : {};
  const models = isRecord(resolved['models']) ? resolved['models'] : {};
  const thinking = isRecord(resolved['thinking']) ? resolved['thinking'] : {};
  const runtime = options.engineRuntime();
  return {
    product: 'Batch Translating',
    upstreamBaseline: UPSTREAM_BASELINE,
    runtime: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
    },
    engine: {
      pid: process.pid,
      serverId: options.serverId,
      origin: runtime.origin,
      port: runtime.port,
    },
    model:
      configured === undefined
        ? undefined
        : {
            configured,
            provider: configured.includes('/') ? configured.split('/', 1)[0] : undefined,
          },
    config: {
      defaultModelConfigured: configured !== undefined,
      providerCount: Object.keys(providers).length,
      modelAliasCount: Object.keys(models).length,
      telemetryEnabled: resolved['telemetry'] === true,
      thinkingEnabled: thinking['enabled'] === true,
    },
    project: summarizeTranslationProject(summary?.custom?.['batchTranslation']),
    health: {
      sessionIndex: index.status().state,
      ledger: 'legacy-session-metadata',
      workers: 'session-managed',
      rag: 'disabled:not-implemented',
      crash: {
        status: 'unavailable',
        reason: 'crash-reporter-not-implemented',
      },
    },
  } as const;
}

function summarizeTranslationProject(value: unknown) {
  if (!isRecord(value)) return undefined;
  const chapters = Array.isArray(value['chapters']) ? value['chapters'] : [];
  const issues = Array.isArray(value['issues']) ? value['issues'] : [];
  const artifacts = Array.isArray(value['artifacts']) ? value['artifacts'] : [];
  return {
    schemaVersion: finiteNumber(value['schemaVersion']),
    projectId: nonEmptyString(value['projectId']),
    revision: finiteNumber(value['revision']),
    status: nonEmptyString(value['status']),
    activeStageId: nonEmptyString(value['activeStageId']),
    instructionVersion: finiteNumber(value['overrideRevision']),
    sourceKind: isRecord(value['source']) ? nonEmptyString(value['source']['kind']) : undefined,
    chapterCount: chapters.length,
    completedChapterCount: chapters.filter(
      (chapter) => isRecord(chapter) && chapter['status'] === 'completed',
    ).length,
    openIssueCount: issues.filter(
      (issue) =>
        isRecord(issue) && issue['status'] !== 'resolved' && issue['status'] !== 'wont_fix',
    ).length,
    artifactCount: artifacts.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, 200);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'session';
}

function sendMappedError(reply: SessionExportReply, req: { id: string }, error: unknown): void {
  const requestId = req.id;
  if (isError2(error)) {
    if (error.code === ErrorCodes.SESSION_NOT_FOUND) {
      reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, error.message, requestId));
      return;
    }
    if (error.code === ErrorCodes.SESSION_EXPORT_TOO_LARGE) {
      reply.send(
        errEnvelope(
          ErrorCode.FILE_TOO_LARGE,
          'session export exceeds the 64 MiB web limit',
          requestId,
        ),
      );
      return;
    }
  }
  requestLog(req)?.error({ err: error }, 'session export failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      error instanceof Error ? error.message : 'internal error',
      requestId,
    ),
  );
}
