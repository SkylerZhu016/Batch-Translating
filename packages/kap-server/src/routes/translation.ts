import type {
  FinalArtifactReceipt,
  TranslationRecord,
} from '@batch-translating/translation-tools';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import {
  TranslationRuntime,
  TranslationRuntimeError,
  type DownloadBgeInput,
  type RagProjectReference,
  type RebuildRagInput,
} from '../services/translation/translationRuntime';
import type {
  BgeRuntimeStatus,
  RuntimeTranslationProject,
  WriteProjectReportInput,
} from '../services/translation/types';

const TRANSLATION_ERROR = {
  invalid: 40020,
  not_found: 40420,
  conflict: 40930,
  unavailable: 50310,
  internal: 50001,
} as const;

const projectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const projectRootSchema = z.string().min(1);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const translationDataSchema = z.unknown();

const projectParamsSchema = z.object({ project_id: projectIdSchema });
const projectQuerySchema = z.object({ project_root: projectRootSchema });
const ragReferenceSchema = z.object({
  project_id: projectIdSchema.optional(),
  project_root: projectRootSchema.optional(),
  book_id: z.string().min(1).optional(),
});

const initializeBodySchema = z.object({
  project: jsonObjectSchema,
  source_file_id: z.string().regex(/^f_[A-Za-z0-9][A-Za-z0-9_-]*$/),
  session_id: z.string().min(1).optional(),
});

const affectedScopeSchema = z.object({
  affected_task_ids: z.array(z.string().min(1)).default([]),
  affected_chapter_ids: z.array(z.string().min(1)).default([]),
  affected_entities: z.array(z.string().min(1)).default([]),
  global: z.boolean().default(false),
  reason: z.string().min(1),
});

const instructionBodySchema = z.object({
  project_root: projectRootSchema,
  session_message_id: z.string().min(1),
  message: z.string().min(1).max(12_000),
  affected_scope: affectedScopeSchema,
  interrupt_mode: z.enum(['SOFT', 'HARD']).optional(),
});

const structuralValidationSchema = z.object({
  valid: z.boolean(),
  checks: z.array(z.string()),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

const finalArtifactSchema = z.object({
  schema_version: z.literal(1),
  artifact_type: z.enum(['epub', 'txt']),
  output_path: z.string().min(1),
  source_path: z.string().min(1),
  source_sha256: sha256Schema,
  artifact_sha256: sha256Schema,
  byte_length: z.number().int().nonnegative(),
  immutable: z.literal(true),
  paragraph_count: z.number().int().nonnegative(),
  translated_paragraph_count: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  structural_validation: structuralValidationSchema,
  epubcheck: z.object({
    status: z.enum(['passed', 'failed', 'unavailable', 'timed_out']),
    command: z.string().optional(),
    exit_code: z.number().int().optional(),
    output: z.string(),
  }).optional(),
  provenance: z.object({
    project_id: projectIdSchema,
    instruction_version: z.number().int().nonnegative(),
    prompt_fingerprint: z.string().min(1),
    context_hash: z.string().min(1),
    model_fingerprint: z.string().min(1),
    merge_receipt_hash: sha256Schema,
  }),
  created_at: z.string().min(1),
});

const completionBodySchema = z.object({
  project_root: projectRootSchema,
  final_artifact: finalArtifactSchema.optional(),
  final_artifact_ids: z.array(z.string().min(1)).min(1).optional(),
  final_task_types: z.array(z.string().min(1)).optional(),
  required_task_types: z.array(z.string().min(1)).optional(),
});

const translationRecordSchema = z.object({
  paragraph_id: z.string().min(1),
  translation: z.string().min(1),
  segment_translations: z.record(z.string(), z.string()).optional(),
});

const reportBodySchema = z.object({
  project_root: projectRootSchema,
  output_path: z.string().min(1).optional(),
  final_artifact: finalArtifactSchema.optional(),
  final_artifact_ids: z.array(z.string().min(1)).min(1).optional(),
  final_task_types: z.array(z.string().min(1)).optional(),
  required_task_types: z.array(z.string().min(1)).optional(),
  translations: z.array(translationRecordSchema).optional(),
  rag_configuration: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const detectBodySchema = z.object({ verify_hashes: z.boolean().default(false) });
const downloadBodySchema = z.object({
  source: z.enum(['mirror', 'official']).default('mirror'),
  revision: z.string().min(1).optional(),
  cpu_fallback: z.boolean().default(true),
});
const verifyRagBodySchema = ragReferenceSchema.extend({ cpu_fallback: z.boolean().default(true) });
const rebuildRagBodySchema = z.object({
  project_id: projectIdSchema,
  project_root: projectRootSchema,
  book_id: z.string().min(1),
  indexes: z.array(z.enum(['story_memory', 'translation_memory', 'source_paragraph'])).optional(),
  force: z.boolean().optional(),
});

interface TranslationRouteHost {
  get(path: string, options: unknown, handler: unknown): unknown;
  post(path: string, options: unknown, handler: unknown): unknown;
  delete(path: string, options: unknown, handler: unknown): unknown;
}

export function registerTranslationRoutes(
  app: TranslationRouteHost,
  runtime: TranslationRuntime,
): void {
  register(app, 'post', defineRoute(
    {
      method: 'POST',
      path: '/translation/projects/initialize',
      body: initializeBodySchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Initialize an immutable translation project ledger',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => {
        const result = await runtime.initialize({
          project: req.body.project as unknown as RuntimeTranslationProject,
          sourceFileId: req.body.source_file_id,
          sessionId: req.body.session_id,
        });
        return {
          project_id: result.projectId,
          manifest: {
            ...result.manifest,
            path: result.manifestPath,
            sha256: result.manifestSha256,
            schema_version: result.manifest.schema_version,
            book_id: result.bookId,
            chapter_count: result.chapterCount,
            paragraph_count: result.paragraphCount,
            source_word_count: result.manifest.source_word_count,
          },
          ledger_summary: {
            ...asRecord(toSnakeCase(result.ledgerSummary)),
            database_path: result.databasePath,
            integrity_ok: result.integrityOk,
          },
          chapters: result.chapters,
          source_receipt: result.sourceReceipt,
          quality_capability: toSnakeCase(result.quality),
          integrity_ok: result.integrityOk,
          reused: result.reused,
          database_path: result.databasePath,
          manifest_path: result.manifestPath,
          manifest_sha256: result.manifestSha256,
          artifact_root: result.artifactRoot,
        };
      });
    },
  ));

  register(app, 'get', defineRoute(
    {
      method: 'GET',
      path: '/translation/projects/{project_id}/status',
      params: projectParamsSchema,
      querystring: projectQuerySchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Read ledger, budget, integrity, and quality status',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => {
        const result = await runtime.projectStatus({
          projectId: req.params.project_id,
          projectRoot: req.query.project_root,
        });
        return {
          project_id: result.project.projectId,
          status: result.project.status,
          ledger_summary: {
            ...asRecord(toSnakeCase(result.ledger)),
            database_path: result.databasePath,
            integrity_ok: result.integrity.ok,
          },
          manifest: {
            ...result.manifest,
            path: result.manifestPath,
            sha256: result.manifestSha256,
            chapter_count: result.manifest.chapters.length,
          },
          manifest_path: result.manifestPath,
          manifest_sha256: result.manifestSha256,
          chapters: result.chapters,
          source_receipt: result.sourceReceipt,
          latest_instruction: toSnakeCase(result.latestInstruction),
          completion_receipt: toSnakeCase(result.completionReceipt),
          final_output: toSnakeCase(result.finalOutput),
          report_receipt: toSnakeCase(result.reportReceipt),
          integrity: toSnakeCase(result.integrity),
          budget: toSnakeCase(result.budget),
          quality_capability: toSnakeCase(result.quality),
          warnings: result.warnings,
        };
      });
    },
  ));

  register(app, 'post', defineRoute(
    {
      method: 'POST',
      path: '/translation/projects/{project_id}/instructions',
      params: projectParamsSchema,
      body: instructionBodySchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Persist a correction and deterministically stale its affected scope',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => {
        const applied = await runtime.applyInstruction({
          projectId: req.params.project_id,
          projectRoot: req.body.project_root,
          sessionMessageId: req.body.session_message_id,
          message: req.body.message,
          affectedScope: {
            affectedTaskIds: req.body.affected_scope.affected_task_ids,
            affectedChapterIds: req.body.affected_scope.affected_chapter_ids,
            affectedEntities: req.body.affected_scope.affected_entities,
            global: req.body.affected_scope.global,
            reason: req.body.affected_scope.reason,
          },
          interruptMode: req.body.interrupt_mode,
        });
        return {
          instruction_version: applied.result.instruction.instructionVersion,
          affected_scope: req.body.affected_scope,
          stale_task_ids: applied.result.staleTaskIds,
          cancelled_task_ids: applied.result.cancelledTaskIds,
          continued_task_ids: applied.result.continuedTaskIds,
          interrupted_task_ids: applied.result.interruptedTaskIds,
          replacement_task_ids: applied.result.replacementTaskIds,
          cost_impact: toSnakeCase(applied.ledgerSummary),
          integrity: toSnakeCase(applied.integrity),
          accepted_at: applied.result.instruction.createdAt,
        };
      });
    },
  ));

  register(app, 'post', defineRoute(
    {
      method: 'POST',
      path: '/translation/projects/{project_id}/completion/verify',
      params: projectParamsSchema,
      body: completionBodySchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Verify final bytes and the complete ledger gate',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => {
        const result = await runtime.verifyCompletion({
          projectId: req.params.project_id,
          projectRoot: req.body.project_root,
          finalArtifact: req.body.final_artifact as FinalArtifactReceipt | undefined,
          finalArtifactIds: req.body.final_artifact_ids,
          finalTaskTypes: req.body.final_task_types,
          requiredTaskTypes: req.body.required_task_types,
        });
        return {
          verified: result.verified,
          receipt: toSnakeCase(result),
          final_output: result.finalArtifact
            ? {
                ...result.finalArtifact,
                path: result.finalArtifact.output_path,
                sha256: result.finalArtifact.artifact_sha256,
                structural_validation: toSnakeCase(result.structuralValidation),
              }
            : undefined,
          failures: result.blockers,
          warnings: result.warnings,
        };
      });
    },
  ));

  register(app, 'post', defineRoute(
    {
      method: 'POST',
      path: '/translation/projects/{project_id}/report',
      params: projectParamsSchema,
      body: reportBodySchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Create an immutable deterministic project report',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => {
        const input: WriteProjectReportInput = {
          projectId: req.params.project_id,
          projectRoot: req.body.project_root,
          outputPath: req.body.output_path,
          finalArtifact: req.body.final_artifact as FinalArtifactReceipt | undefined,
          finalArtifactIds: req.body.final_artifact_ids,
          finalTaskTypes: req.body.final_task_types,
          requiredTaskTypes: req.body.required_task_types,
          translations: req.body.translations as TranslationRecord[] | undefined,
          ragConfiguration: req.body.rag_configuration,
        };
        const result = await runtime.writeReport(input);
        return {
          path: result.report.output_path,
          sha256: result.report.sha256,
          generated_at: result.reportInput.snapshot_as_of,
          summary: toSnakeCase(result.ledgerSnapshot),
          warnings: result.warnings,
        };
      });
    },
  ));

  register(app, 'get', defineRoute(
    {
      method: 'GET',
      path: '/translation/rag/status',
      querystring: ragReferenceSchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Read the six-state BGE-M3 and RAG status',
    },
    async (req, reply) => {
      const reference: RagProjectReference = {
        projectId: req.query.project_id,
        projectRoot: req.query.project_root,
        bookId: req.query.book_id,
      };
      await sendRuntimeResult(req, reply, async () => wireRagStatus(await runtime.ragStatus(reference)));
    },
  ));

  register(app, 'post', defineRoute(
    {
      method: 'POST',
      path: '/translation/rag/detect',
      body: detectBodySchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Explicitly detect a local BGE-M3 model',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => wireRagStatus(
        await runtime.detectBge(req.body.verify_hashes),
      ));
    },
  ));

  register(app, 'post', defineRoute(
    {
      method: 'POST',
      path: '/translation/rag/download',
      body: downloadBodySchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Start an explicit resumable BGE-M3 download',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => wireRagStatus(runtime.startBgeDownload({
        source: req.body.source,
        revision: req.body.revision,
        cpuFallback: req.body.cpu_fallback,
      } satisfies DownloadBgeInput)));
    },
  ));

  register(app, 'delete', defineRoute(
    {
      method: 'DELETE',
      path: '/translation/rag/download',
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Cancel the active BGE-M3 download',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => wireRagStatus(runtime.cancelBgeDownload()));
    },
  ));

  register(app, 'post', defineRoute(
    {
      method: 'POST',
      path: '/translation/rag/verify',
      body: verifyRagBodySchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Verify BGE-M3, start the local sidecar, and optionally verify project indexes',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => {
        const result = await runtime.verifyRag({
          projectId: req.body.project_id,
          projectRoot: req.body.project_root,
          bookId: req.body.book_id,
        }, req.body.cpu_fallback);
        return {
          ...wireRagStatus(result.status),
          verification: toSnakeCase(result.verification),
        };
      });
    },
  ));

  register(app, 'post', defineRoute(
    {
      method: 'POST',
      path: '/translation/rag/rebuild',
      body: rebuildRagBodySchema,
      success: { data: translationDataSchema },
      errors: translationErrors(),
      tags: ['translation'],
      summary: 'Rebuild authenticated local RAG indexes',
    },
    async (req, reply) => {
      await sendRuntimeResult(req, reply, async () => {
        const rebuild = await runtime.rebuildRag({
          projectId: req.body.project_id,
          projectRoot: req.body.project_root,
          bookId: req.body.book_id,
          indexes: req.body.indexes,
          force: req.body.force,
        } satisfies RebuildRagInput);
        return {
          ...wireRagStatus(await runtime.ragStatus({
            projectId: req.body.project_id,
            projectRoot: req.body.project_root,
            bookId: req.body.book_id,
          })),
          rebuild: toSnakeCase(rebuild),
        };
      });
    },
  ));
}

function register(
  app: TranslationRouteHost,
  method: 'get' | 'post' | 'delete',
  route: { path: string; options: unknown; handler: unknown },
): void {
  app[method](route.path, route.options, route.handler);
}

async function sendRuntimeResult(
  req: { id: string },
  reply: { send(payload: unknown): unknown },
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    reply.send(okEnvelope(await action(), req.id));
  } catch (error) {
    if (error instanceof TranslationRuntimeError) {
      requestLog(req)?.warn({ kind: error.kind }, 'translation runtime request rejected');
      reply.send(errEnvelope(TRANSLATION_ERROR[error.kind], error.message, req.id));
      return;
    }
    requestLog(req)?.error({ err: safeLogError(error) }, 'translation runtime request failed');
    reply.send(errEnvelope(TRANSLATION_ERROR.internal, 'translation runtime request failed', req.id));
  }
}

function translationErrors(): Record<number, Record<string, never>> {
  return Object.fromEntries(
    Object.values(TRANSLATION_ERROR).map((code) => [code, {}]),
  ) as Record<number, Record<string, never>>;
}

function wireRagStatus(status: BgeRuntimeStatus): Record<string, unknown> {
  return {
    status: status.status,
    service_status: status.serviceStatus === 'not_started' ? 'unavailable' : status.serviceStatus,
    source: status.source,
    progress: status.progress,
    downloaded_bytes: status.downloadedBytes,
    total_bytes: status.totalBytes,
    disk_available_bytes: status.diskAvailableBytes,
    disk_required_bytes: status.diskRequiredBytes,
    // Compatibility aliases for clients created before the final field order
    // was fixed; both names carry the same byte values.
    available_disk_bytes: status.diskAvailableBytes,
    required_disk_bytes: status.diskRequiredBytes,
    model_path: status.modelPath,
    fingerprint: status.fingerprint,
    cpu_fallback: status.cpuFallback,
    degraded: status.degraded,
    dense_ready: status.denseReady,
    index_ready: status.indexReady,
    points: status.points,
    capabilities: toSnakeCase(status.capabilities),
    error: status.error,
    error_code: status.errorCode,
    recommended_vram_gb: status.recommendedVramGb,
    quality_message: status.qualityMessage,
    fallback_message: status.fallbackMessage,
    model_download_is_explicit: status.modelDownloadIsExplicit,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    toSnakeCase(entry),
  ]));
}

function safeLogError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/([?&](?:token|api_key|key)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500);
}
