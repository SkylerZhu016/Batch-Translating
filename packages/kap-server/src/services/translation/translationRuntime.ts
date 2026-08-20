import {
  TranslationProjectLedger,
  type BudgetStatus,
  type DeterministicReportData,
  type IntegrityReport,
  type ProjectRecord,
} from '@batch-translating/translation-domain';
import {
  BgeM3ModelManager,
  TranslationRagService,
  checkModelDownloadDiskSpace,
  prepareRagPythonEnvironment,
  probeRagPython,
  type DiscoveredModel,
  type ModelDownloadProgress,
  type RagHealthResponse,
  type RagIndexName,
} from '@batch-translating/translation-rag';
import {
  hashCanonicalJson,
  parseTranslationSource,
  sha256Bytes,
  validateEpubStructure,
  writeBookManifest,
  writeDeterministicReport,
  type BookManifest,
  type DeterministicReportInput,
  type FinalArtifactReceipt,
  type StructuralValidationResult,
} from '@batch-translating/translation-tools';
import type { IFileService } from '@moonshot-ai/agent-core-v2';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import type { ServerLogger } from '../pinoLoggerService';
import {
  buildLegacyTranslationTaskBook,
  buildTranslationTaskBook,
  buildTranslationTaskBookV3,
} from './taskBook';
import type {
  AppliedProjectInstruction,
  ApplyProjectInstructionInput,
  BgeRuntimeStatus,
  BgeSetupStatus,
  InitializeTranslationProjectInput,
  InitializedTranslationProject,
  LoadedProject,
  ProjectReference,
  ProjectReportReceipt,
  RuntimeTranslationProject,
  TranslationQualityStatus,
  VerifiedCompletionReceipt,
  VerifyCompletionInput,
  WriteProjectReportInput,
} from './types';
import { SAFE_FILE_ID, SAFE_PROJECT_ID, SHA256 } from './types';

const PROJECT_METADATA_FILE = 'project.runtime.json';
const DATABASE_FILE = 'translation.sqlite3';
const MODEL_DESTINATION_DIRECTORY = 'bge-m3';
const RAG_RUNTIME_ENV = 'BATCH_TRANSLATING_RAG_RUNTIME';
const USAGE_OUTBOX_DIRECTORY = 'translation-usage-outbox';
const DEFAULT_FINAL_TASK_TYPES = [
  'render',
  'final-render',
  'epub-render',
  'txt-render',
  'render-final',
  'export_epub',
  'export_txt',
] as const;

type RuntimeErrorKind = 'invalid' | 'not_found' | 'conflict' | 'unavailable' | 'internal';

export class TranslationRuntimeError extends Error {
  constructor(
    readonly kind: RuntimeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'TranslationRuntimeError';
  }
}

export interface ModelTokenPricing {
  readonly currency: 'USD';
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly cacheReadUsdPerMillion?: number;
  readonly cacheCreationUsdPerMillion?: number;
}

export interface ModelPricingLookup {
  readonly modelId: string;
  readonly providerId: string;
}

interface TranslationRuntimeOptions {
  readonly homeDir: string;
  readonly fileService: IFileService;
  readonly logger: ServerLogger;
  readonly resolveModelPricing?: (
    input: ModelPricingLookup,
  ) => ModelTokenPricing | undefined | Promise<ModelTokenPricing | undefined>;
}

interface ProjectHandle {
  readonly root: string;
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly ledger: TranslationProjectLedger;
  project?: RuntimeTranslationProject;
  manifest?: BookManifest;
}

interface MutableBgeState {
  status: BgeSetupStatus;
  source: 'mirror' | 'official';
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  diskAvailableBytes?: number;
  diskRequiredBytes?: number;
  modelPath?: string;
  fingerprint?: string;
  cpuFallback: boolean;
  serviceStatus: 'not_started' | 'ready' | 'degraded' | 'unavailable';
  degraded: boolean;
  denseReady: boolean;
  error?: string;
  errorCode?: BgeRuntimeStatus['errorCode'];
  capabilities?: unknown;
}

export interface RagProjectReference {
  readonly projectId?: string;
  readonly projectRoot?: string;
  readonly bookId?: string;
}

export interface DownloadBgeInput {
  readonly source?: 'mirror' | 'official';
  readonly revision?: string;
  readonly cpuFallback?: boolean;
}

export interface RebuildRagInput extends Required<RagProjectReference> {
  readonly indexes?: readonly RagIndexName[];
  readonly force?: boolean;
}

/** Exact, non-cumulative usage emitted after one successful agent model request. */
export interface TranslationAgentUsageIncrement {
  readonly sessionId: string;
  readonly agentId: string;
  readonly sessionCustom?: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly sourceType: 'turn' | 'operation';
  readonly requestKind?: string;
  readonly turnId?: number;
  readonly step?: number;
  readonly modelId: string;
  readonly providerId: string;
  readonly usage: {
    readonly inputOther: number;
    readonly output: number;
    readonly inputCacheRead: number;
    readonly inputCacheCreation: number;
  };
}

export interface TranslationBudgetNotification {
  readonly code: 'translation-soft-budget-reached' | 'translation-hard-budget-reached';
  readonly message: string;
}

export interface TranslationAgentUsageReceipt {
  readonly budget: BudgetStatus;
  readonly notification?: TranslationBudgetNotification;
}

interface PersistedUsageOutboxEntry {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnId: string;
  readonly step: number;
  readonly modelId: string;
  readonly providerId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly priceSnapshot: Record<string, unknown>;
  readonly actualCostMicros: number;
  readonly stage: 'coordinator' | 'translation-subagent' | 'context-maintenance';
}

/**
 * Process-owned production boundary for translation state. Project bytes and
 * SQLite ledgers live under each caller-selected absolute project root. Only
 * the shared optional BGE model and RAG service data use the app home.
 */
export class TranslationRuntime {
  private readonly homeDir: string;
  private readonly fileService: IFileService;
  private readonly logger: ServerLogger;
  private readonly resolveModelPricing: TranslationRuntimeOptions['resolveModelPricing'];
  private readonly handles = new Map<string, ProjectHandle>();
  private readonly projectLocks = new Map<string, Promise<unknown>>();
  private readonly modelManager = new BgeM3ModelManager();
  private readonly removeProgressListener: () => void;
  private readonly modelDestination: string;
  private readonly ragDataRoot: string;
  private readonly usageOutboxRoot: string;
  private readonly ragRuntimeDescriptorPath: string;
  private bgeState: MutableBgeState = {
    status: 'missing',
    source: 'mirror',
    cpuFallback: true,
    serviceStatus: 'not_started',
    degraded: false,
    denseReady: false,
  };
  private discoveredModel: DiscoveredModel | undefined;
  private ragService: TranslationRagService | undefined;
  private ragPythonExecutable: string | undefined;
  private downloadController: AbortController | undefined;
  private downloadPromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: TranslationRuntimeOptions) {
    this.homeDir = resolve(options.homeDir);
    this.fileService = options.fileService;
    this.logger = options.logger;
    this.resolveModelPricing = options.resolveModelPricing;
    this.modelDestination = join(this.homeDir, 'models', MODEL_DESTINATION_DIRECTORY);
    this.ragDataRoot = join(this.homeDir, 'translation-rag');
    this.usageOutboxRoot = join(this.homeDir, USAGE_OUTBOX_DIRECTORY);
    // A process-unique descriptor avoids clobbering sibling KAP servers that
    // legitimately share the same product home.
    this.ragRuntimeDescriptorPath = join(
      this.ragDataRoot,
      `runtime-${process.pid}-${randomUUID()}.json`,
    );
    this.removeProgressListener = this.modelManager.onProgress((progress) => {
      this.acceptModelProgress(progress);
    });
  }

  async initialize(input: InitializeTranslationProjectInput): Promise<InitializedTranslationProject> {
    this.assertOpen();
    const project = validateRuntimeProject(input.project);
    if (!SAFE_FILE_ID.test(input.sourceFileId)) {
      throw new TranslationRuntimeError('invalid', 'source_file_id is invalid');
    }
    if (input.sessionId !== undefined && !input.sessionId.trim()) {
      throw new TranslationRuntimeError('invalid', 'session_id cannot be empty');
    }
    return await this.withProjectLock(project.paths.projectRoot, async () => {
      const handle = await this.openHandle({
        projectId: project.projectId,
        projectRoot: project.paths.projectRoot,
      }, false);
      const existingProject = handle.ledger.getProject(project.projectId);
      const reused = existingProject !== undefined;

      const copied = await this.copyUploadedSource(input.sourceFileId, project);
      const { manifest, manifestSha256 } = await this.loadOrCreateManifest(project);
      this.assertManifestMatchesProject(manifest, project, copied.sha256, copied.byteLength);
      await writeTranslationTaskBook(project, manifest);

      if (existingProject) {
        assertSameLedgerProject(existingProject, project, handle.artifactRoot);
      } else {
        const pinned = splitPinnedModel(project.model);
        handle.ledger.createProject({
          projectId: project.projectId,
          name: project.name,
          sourceRootPath: dirname(project.paths.sourceCopy),
          artifactRootPath: handle.artifactRoot,
          sourceHash: project.source.sha256,
          providerId: pinned.providerId,
          modelId: pinned.modelId,
          softBudgetMicros: project.executionPolicy.softBudgetMicros,
          hardBudgetMicros: project.executionPolicy.hardBudgetMicros,
          maxRetries: project.executionPolicy.maxRetries,
          maxConcurrency: project.executionPolicy.maxConcurrency,
          reviewPolicy: project.workflow.secondReview ? 'strict-two-pass' : 'strict',
        });
      }
      this.registerManifest(handle.ledger, project, manifest);
      await this.persistRuntimeProject(handle, project);
      handle.project = project;
      handle.manifest = manifest;
      const integrity = handle.ledger.integrityCheck(project.projectId, true);

      return {
        projectId: project.projectId,
        projectRoot: handle.root,
        databasePath: handle.databasePath,
        artifactRoot: handle.artifactRoot,
        sourceCopy: resolve(project.paths.sourceCopy),
        sourceSha256: copied.sha256,
        sourceSizeBytes: copied.byteLength,
        manifestPath: resolve(project.paths.manifestPath),
        manifestSha256,
        bookId: manifest.book_id,
        chapterCount: manifest.chapters.length,
        paragraphCount: manifest.paragraph_count,
        manifest,
        chapters: manifest.chapters,
        sourceReceipt: {
          original: {
            source_path: project.source.sourcePath,
            format: project.source.kind,
            sha256: project.source.sha256,
            byte_length: project.source.sizeBytes,
            modified_at_ms: copied.originalModifiedAtMs,
          },
          copied_path: resolve(project.paths.sourceCopy),
          copied_sha256: copied.sha256,
          byte_length: copied.byteLength,
          immutable: true,
        },
        reused,
        ledgerSummary: handle.ledger.ledgerSummary(project.projectId),
        quality: this.qualityStatus(),
        integrityOk: integrity.ok,
      };
    });
  }

  async projectStatus(reference: ProjectReference): Promise<{
    project: RuntimeTranslationProject;
    manifest: BookManifest;
    manifestPath: string;
    manifestSha256: string;
    databasePath: string;
    chapters: BookManifest['chapters'];
    sourceReceipt: Record<string, unknown>;
    latestInstruction: unknown;
    completionReceipt: unknown;
    finalOutput: unknown;
    reportReceipt: unknown;
    ledger: unknown;
    budget: unknown;
    integrity: IntegrityReport;
    quality: TranslationQualityStatus;
    warnings: readonly string[];
  }> {
    const handle = await this.openHandle(reference);
    const loaded = await this.loadProjectFiles(handle);
    await writeTranslationTaskBook(loaded.project, loaded.manifest);
    const reportData = handle.ledger.getDeterministicReportData(reference.projectId);
    const warnings = costWarnings(reportData);
    const source = await readFileReceipt(loaded.project.paths.sourceCopy, 'immutable source');
    const sourceReceipt = {
      original: {
        source_path: loaded.project.source.sourcePath,
        format: loaded.project.source.kind,
        sha256: loaded.project.source.sha256,
        byte_length: loaded.project.source.sizeBytes,
        modified_at_ms: loaded.manifest.source.modified_at_ms,
      },
      copied_path: resolve(loaded.project.paths.sourceCopy),
      copied_sha256: source.sha256,
      byte_length: source.byteLength,
      immutable: true as const,
    };
    const latestInstruction = handle.ledger.listInstructionEvents(reference.projectId).at(-1);
    const completionReceipt = reportData.completionSnapshots.at(-1);
    const finalOutput = await optionalFileReceipt(loaded.project.paths.finalOutputPath);
    const finalValidation = finalOutput
      ? await validateFinalBytes(
          await readFile(loaded.project.paths.finalOutputPath),
          loaded.project.source.kind,
        )
      : undefined;
    const reportReceipt = await optionalReportReceipt(loaded.project.paths.finalReportPath);
    return {
      project: loaded.project,
      manifest: loaded.manifest,
      manifestPath: resolve(loaded.project.paths.manifestPath),
      manifestSha256: hashCanonicalJson(loaded.manifest),
      databasePath: handle.databasePath,
      chapters: loaded.manifest.chapters,
      sourceReceipt,
      latestInstruction,
      completionReceipt,
      finalOutput: finalOutput ? {
        path: resolve(loaded.project.paths.finalOutputPath),
        sha256: finalOutput.sha256,
        byteLength: finalOutput.byteLength,
        structuralValidation: finalValidation,
      } : undefined,
      reportReceipt: reportReceipt ? {
        path: resolve(loaded.project.paths.finalReportPath),
        sha256: reportReceipt.sha256,
        byteLength: reportReceipt.byteLength,
        generatedAt: reportReceipt.generatedAt,
      } : undefined,
      ledger: handle.ledger.ledgerSummary(reference.projectId),
      budget: handle.ledger.getBudgetStatus(reference.projectId),
      integrity: handle.ledger.integrityCheck(reference.projectId, true),
      quality: this.qualityStatus(),
      warnings,
    };
  }

  async assertPaidWorkAllowed(
    sessionCustom: Readonly<Record<string, unknown>> | undefined,
  ): Promise<TranslationBudgetNotification | undefined> {
    const binding = translationUsageBinding(sessionCustom);
    if (binding === undefined) return;
    this.assertOpen();
    const replayNotification = await this.replayPendingUsage(binding);
    return await this.withProjectLock(binding.projectRoot, async () => {
      const handle = await this.openHandle(binding);
      const budget = handle.ledger.getBudgetStatus(binding.projectId);
      if (!budget.hardExceeded) return replayNotification;
      throw new TranslationRuntimeError(
        'conflict',
        `费用硬上限已达到：项目累计费用为 ${formatBudgetUsd(budget.actualCostMicros)}，硬上限为 ${formatBudgetUsd(budget.hardBudgetMicros!)}。不会启动新的付费工作；已开始的工作会继续运行。`,
      );
    });
  }

  async recordAgentUsage(
    input: TranslationAgentUsageIncrement,
  ): Promise<TranslationAgentUsageReceipt | undefined> {
    const binding = translationUsageBinding(input.sessionCustom);
    if (binding === undefined) return;
    this.assertOpen();

    const sessionId = usageIdentity(input.sessionId, 'session id');
    const agentId = usageIdentity(input.agentId, 'agent id');
    const modelId = usageIdentity(input.modelId, 'model id');
    const providerId = usageIdentity(input.providerId, 'provider id');
    const requestId = usageIdentity(input.requestId, 'request id');
    const turnId = input.sourceType === 'turn'
      ? usageInteger(input.turnId, 'turn id')
      : input.turnId === undefined
        ? undefined
        : usageInteger(input.turnId, 'operation turn id');
    const step = input.step === undefined ? 0 : usageInteger(input.step, 'turn step');
    const ledgerTurnId = input.sourceType === 'turn'
      ? String(turnId)
      : `operation:${input.requestKind?.trim() || 'unspecified'}:${requestId}`;
    const inputOther = usageInteger(input.usage.inputOther, 'input token count');
    const output = usageInteger(input.usage.output, 'output token count');
    const inputCacheRead = usageInteger(input.usage.inputCacheRead, 'cache-read token count');
    const inputCacheCreation = usageInteger(
      input.usage.inputCacheCreation,
      'cache-creation token count',
    );
    const inputTokens = inputOther + inputCacheRead + inputCacheCreation;
    if (!Number.isSafeInteger(inputTokens)) {
      throw new TranslationRuntimeError('invalid', 'Combined input token count is not a safe integer');
    }

    let cost: UsageCostResult = unavailableUsageCost(
      modelId,
      providerId,
      'model_price_not_configured',
    );
    if (this.resolveModelPricing !== undefined) {
      try {
        const pricing = await this.resolveModelPricing({ modelId, providerId });
        if (pricing !== undefined) {
          cost = calculateUsageCost({
            inputOther,
            output,
            inputCacheRead,
            inputCacheCreation,
          }, pricing, { modelId, providerId });
        }
      } catch (error) {
        this.logger.warn(
          { modelId, providerId, err: safeErrorText(error) },
          'model pricing lookup failed; token usage will remain unpriced',
        );
        cost = unavailableUsageCost(modelId, providerId, 'model_price_lookup_failed');
      }
    }

    // `onDidRecord` is a per-finish increment, never the cumulative status
    // snapshot. Including its exact four counters makes an identical replay
    // idempotent while keeping a contradictory observation visibly distinct.
    const eventId = hashCanonicalJson({
      schema_version: 1,
      request_id: requestId,
      source_type: input.sourceType,
      session_id: sessionId,
      agent_id: agentId,
      turn_id: turnId ?? null,
      step,
      model_id: modelId,
      provider_id: providerId,
      usage: {
        input_other: inputOther,
        output,
        input_cache_read: inputCacheRead,
        input_cache_creation: inputCacheCreation,
      },
    });
    const entry: PersistedUsageOutboxEntry = {
      schemaVersion: 1,
      eventId,
      projectId: binding.projectId,
      projectRoot: binding.projectRoot,
      sessionId,
      agentId,
      turnId: ledgerTurnId,
      step,
      modelId,
      providerId,
      inputTokens,
      outputTokens: output,
      cachedTokens: inputCacheRead,
      priceSnapshot: cost.priceSnapshot,
      // When pricing is unavailable the ledger still requires a numeric
      // storage value; the snapshot explicitly marks that zero as a
      // placeholder so reports never present it as the true cost.
      actualCostMicros: cost.actualCostMicros,
      stage: input.sourceType === 'operation'
        ? 'context-maintenance'
        : agentId === 'main'
          ? 'coordinator'
          : 'translation-subagent',
    };
    const outboxPath = this.usageOutboxPath(entry);
    await ensureUsageOutboxEntry(outboxPath, entry);
    const receipt = await this.commitUsageOutboxEntry(entry);
    await this.removeCommittedUsageOutboxEntry(outboxPath);
    return receipt;
  }

  private usageOutboxPath(entry: PersistedUsageOutboxEntry): string {
    return join(this.usageOutboxRoot, entry.projectId, `${entry.eventId}.json`);
  }

  private async commitUsageOutboxEntry(
    entry: PersistedUsageOutboxEntry,
  ): Promise<TranslationAgentUsageReceipt> {
    return await this.withProjectLock(entry.projectRoot, async () => {
      const handle = await this.openHandle({
        projectId: entry.projectId,
        projectRoot: entry.projectRoot,
      });
      const before = handle.ledger.getBudgetStatus(entry.projectId);
      const recorded = handle.ledger.recordSyntheticUsageEvent({
        projectId: entry.projectId,
        eventId: entry.eventId,
        sessionId: entry.sessionId,
        agentId: entry.agentId,
        turnId: entry.turnId,
        step: entry.step,
        modelId: entry.modelId,
        providerId: entry.providerId,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cachedTokens: entry.cachedTokens,
        priceSnapshot: entry.priceSnapshot,
        actualCostMicros: entry.actualCostMicros,
        stage: entry.stage,
      });
      return {
        budget: recorded.budget,
        notification: budgetNotification(before, recorded.budget, recorded.reused),
      };
    });
  }

  private async replayPendingUsage(
    binding: ProjectReference,
  ): Promise<TranslationBudgetNotification | undefined> {
    const directory = join(this.usageOutboxRoot, binding.projectId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    let notification: TranslationBudgetNotification | undefined;
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
      const path = join(directory, name);
      const entry = validateUsageOutboxEntry(JSON.parse(await readFile(path, 'utf8')) as unknown);
      if (entry.projectId !== binding.projectId || !samePath(entry.projectRoot, binding.projectRoot)) {
        throw new TranslationRuntimeError(
          'conflict',
          'Pending usage belongs to a different translation project root',
        );
      }
      if (name !== `${entry.eventId}.json`) {
        throw new TranslationRuntimeError('conflict', 'Pending usage filename is invalid');
      }
      const receipt = await this.commitUsageOutboxEntry(entry);
      notification ??= receipt.notification;
      await this.removeCommittedUsageOutboxEntry(path);
    }
    return notification;
  }

  private async removeCommittedUsageOutboxEntry(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch (error) {
      this.logger.warn(
        { path, err: safeErrorText(error) },
        'committed translation usage outbox entry could not be removed; replay is idempotent',
      );
    }
  }

  async applyInstruction(input: ApplyProjectInstructionInput): Promise<AppliedProjectInstruction> {
    const handle = await this.openHandle(input);
    const result = handle.ledger.applyInstruction({
      projectId: input.projectId,
      sessionMessageId: input.sessionMessageId,
      message: input.message,
      affectedScope: input.affectedScope,
      interruptMode: input.interruptMode,
    });
    return {
      result,
      ledgerSummary: handle.ledger.ledgerSummary(input.projectId),
      integrity: handle.ledger.integrityCheck(input.projectId, false),
    };
  }

  async verifyCompletion(input: VerifyCompletionInput): Promise<VerifiedCompletionReceipt> {
    const handle = await this.openHandle(input);
    const { project, manifest } = await this.loadProjectFiles(handle);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const ledgerProject = handle.ledger.getProject(input.projectId);
    if (!ledgerProject) throw projectNotFound(input.projectId);
    const finalTaskTypes = input.finalTaskTypes?.length
      ? [...new Set(input.finalTaskTypes)]
      : [...DEFAULT_FINAL_TASK_TYPES];
    const selectedFinalArtifactIds = input.finalArtifactIds
      ? validateSelectedFinalArtifacts(
          handle.ledger,
          input.projectId,
          input.finalArtifactIds,
          finalTaskTypes,
          project.planFingerprint,
        )
      : discoverFinalArtifactIds(
          handle.ledger,
          input.projectId,
          finalTaskTypes,
          project.planFingerprint,
        );
    if (selectedFinalArtifactIds.length === 0) blockers.push('final_artifact_receipt_missing');
    if (selectedFinalArtifactIds.length > 1) blockers.push('multiple_final_artifacts_require_explicit_selection');
    const ledgerFinalArtifact = selectedFinalArtifactIds.length === 1
      ? await readLedgerFinalArtifactReceipt(
          handle.ledger,
          input.projectId,
          selectedFinalArtifactIds[0]!,
        )
      : undefined;
    if (
      ledgerFinalArtifact
      && input.finalArtifact
      && hashCanonicalJson(ledgerFinalArtifact) !== hashCanonicalJson(input.finalArtifact)
    ) {
      blockers.push('supplied_final_artifact_differs_from_ledger');
    }
    const sourcePath = resolve(project.paths.sourceCopy);
    const outputPath = resolve(project.paths.finalOutputPath);
    assertPathWithin(handle.root, outputPath, 'final output path');
    if (samePath(sourcePath, outputPath)) {
      throw new TranslationRuntimeError('invalid', 'final output path must differ from the immutable source');
    }

    const source = await readFileReceipt(sourcePath, 'immutable source');
    if (source.sha256 !== project.source.sha256 || source.sha256 !== manifest.source.sha256) {
      blockers.push('source_hash_mismatch');
    }
    const output = await readFileReceipt(outputPath, 'final output');
    const structuralValidation = await validateFinalBytes(output.bytes, manifest.format);
    if (!structuralValidation.valid) blockers.push('final_structure_invalid');

    if (ledgerFinalArtifact) {
      validateFinalArtifactReceipt(
        ledgerFinalArtifact,
        project,
        manifest,
        ledgerProject.instructionVersion,
      );
      if (ledgerFinalArtifact.artifact_sha256 !== output.sha256) blockers.push('final_artifact_hash_mismatch');
      if (ledgerFinalArtifact.byte_length !== output.byteLength) blockers.push('final_artifact_size_mismatch');
      if (ledgerFinalArtifact.source_sha256 !== source.sha256) blockers.push('final_artifact_source_mismatch');
      if (!ledgerFinalArtifact.structural_validation.valid) blockers.push('render_receipt_structure_invalid');
    }

    const completion = handle.ledger.createCompletionSnapshot(input.projectId, {
      finalTaskTypes,
      requiredTaskTypes: input.requiredTaskTypes ? [...input.requiredTaskTypes] : undefined,
      verifyFiles: true,
    });
    for (const artifactId of selectedFinalArtifactIds) {
      if (!completion.finalArtifactIds.includes(artifactId)) {
        blockers.push(`selected_final_artifact_not_accepted:${artifactId}`);
      }
    }
    blockers.push(...completion.blockers);
    if (completion.cost.hardExceeded) blockers.push('hard_budget_exceeded');
    if (completion.cost.softExceeded) warnings.push('soft_budget_exceeded');
    const integrity = handle.ledger.integrityCheck(input.projectId, true);
    if (!integrity.ok) blockers.push('ledger_integrity_failed');
    warnings.push(...costWarnings(handle.ledger.getDeterministicReportData(input.projectId)));

    const uniqueBlockers = [...new Set(blockers)].sort();
    return {
      verified: completion.complete && structuralValidation.valid && uniqueBlockers.length === 0,
      projectId: input.projectId,
      outputPath,
      artifactSha256: output.sha256,
      byteLength: output.byteLength,
      sourceSha256: source.sha256,
      sourceByteLength: source.byteLength,
      planFingerprint: project.planFingerprint,
      instructionVersion: completion.instructionVersion,
      structuralValidation,
      finalArtifact: ledgerFinalArtifact,
      completion,
      integrity,
      blockers: uniqueBlockers,
      warnings: [...new Set(warnings)].sort(),
      verifiedAt: new Date().toISOString(),
    };
  }

  async writeReport(input: WriteProjectReportInput): Promise<ProjectReportReceipt> {
    const completion = await this.verifyCompletion({
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      finalArtifact: input.finalArtifact,
      finalArtifactIds: input.finalArtifactIds,
      finalTaskTypes: input.finalTaskTypes,
      requiredTaskTypes: input.requiredTaskTypes,
    });
    if (!completion.verified) {
      throw new TranslationRuntimeError(
        'conflict',
        `Completion verification failed: ${completion.blockers.join(', ') || 'unknown blocker'}`,
      );
    }
    if (!completion.finalArtifact) {
      throw new TranslationRuntimeError('conflict', 'Verified completion has no authoritative final artifact receipt');
    }

    const handle = await this.openHandle(input);
    const { project, manifest } = await this.loadProjectFiles(handle);
    const ledgerData = handle.ledger.getDeterministicReportData(input.projectId);
    const reportInput = buildDeterministicReportInput(
      manifest,
      completion.finalArtifact,
      input.translations ?? [],
      ledgerData,
      input.ragConfiguration ?? ragReportConfiguration(this.bgeState),
    );
    const outputPath = resolve(input.outputPath ?? project.paths.finalReportPath);
    assertPathWithin(handle.root, outputPath, 'report output path');
    const report = await writeDeterministicReport(outputPath, reportInput);
    return {
      projectId: input.projectId,
      ledgerSnapshot: ledgerData,
      reportInput,
      report,
      warnings: costWarnings(ledgerData),
    };
  }

  async ragStatus(reference: RagProjectReference = {}): Promise<BgeRuntimeStatus> {
    let indexReady = false;
    let points = 0;
    if (
      this.ragService
      && !this.ragService.isClosed
      && reference.projectId
      && reference.projectRoot
      && reference.bookId
    ) {
      try {
        await this.openHandle({ projectId: reference.projectId, projectRoot: reference.projectRoot });
        const index = await this.ragService.client().indexStatus({
          project_id: reference.projectId,
          book_id: reference.bookId,
        });
        indexReady = index.indexes.length > 0 && index.indexes.every((item) => item.ready);
        points = index.indexes.reduce((total, item) => total + item.point_count, 0);
      } catch (error) {
        this.logger.warn({ err: safeErrorText(error) }, 'translation RAG index status unavailable');
      }
    }
    return this.publicBgeStatus(indexReady, points);
  }

  async detectBge(verifyHashes = false): Promise<BgeRuntimeStatus> {
    this.assertOpen();
    if (this.downloadPromise) {
      throw new TranslationRuntimeError('conflict', 'BGE-M3 download is already running');
    }
    this.bgeState = {
      ...this.bgeState,
      status: verifyHashes ? 'verifying' : 'missing',
      progress: undefined,
      downloadedBytes: undefined,
      totalBytes: undefined,
      diskAvailableBytes: undefined,
      diskRequiredBytes: undefined,
      error: undefined,
      errorCode: undefined,
    };
    try {
      const result = await this.modelManager.discover({ verify_hashes: verifyHashes });
      this.discoveredModel = result.selected;
      if (!result.selected) {
        await this.stopRagService();
        this.bgeState = {
          ...this.bgeState,
          status: 'missing',
          modelPath: undefined,
          fingerprint: undefined,
          serviceStatus: 'unavailable',
          degraded: false,
          denseReady: false,
          error: undefined,
          errorCode: undefined,
        };
      } else {
        this.bgeState = {
          ...this.bgeState,
          status: 'detected',
          modelPath: result.selected.directory,
          fingerprint: result.selected.fingerprint,
          serviceStatus: this.ragService?.isClosed === false ? this.bgeState.serviceStatus : 'not_started',
          error: undefined,
          errorCode: undefined,
        };
      }
      return this.publicBgeStatus(false, 0);
    } catch (error) {
      this.markBgeFailure(error, 'invalid_model');
      return this.publicBgeStatus(false, 0);
    }
  }

  async verifyBge(cpuFallback = true): Promise<BgeRuntimeStatus> {
    this.bgeState.cpuFallback = cpuFallback;
    // Fast path: when a healthy sidecar for a known model is already running,
    // verification only needs a live health check. Skipping re-discovery avoids
    // re-hashing the whole BGE-M3 weights file, and skipping the restart avoids
    // re-loading Torch and the model — a repeat verify returns in milliseconds
    // instead of another ~60s cold start (which the web client's longer RAG
    // timeout now tolerates on the genuinely cold first run).
    if (
      this.ragService !== undefined
      && !this.ragService.isClosed
      && this.bgeState.status === 'available'
      && this.discoveredModel !== undefined
    ) {
      try {
        const health = await this.ragService.client().health();
        this.acceptRagHealth(health, this.discoveredModel);
        if (this.bgeState.status === 'available') {
          return this.publicBgeStatus(false, 0);
        }
      } catch {
        // The live sidecar is unreachable — fall through to a fresh start.
      }
    }
    const discovered = await this.detectBge(true);
    if (discovered.status !== 'detected' || !this.discoveredModel) return discovered;
    await this.startRagForModel(this.discoveredModel);
    return this.publicBgeStatus(false, 0);
  }

  startBgeDownload(input: DownloadBgeInput): BgeRuntimeStatus {
    this.assertOpen();
    if (this.downloadPromise) {
      throw new TranslationRuntimeError('conflict', 'BGE-M3 download is already running');
    }
    const sourceKind = input.source ?? 'mirror';
    const source = this.modelManager
      .sources(sourceKind === 'mirror')
      .find((candidate) => candidate.kind === sourceKind);
    if (!source) throw new TranslationRuntimeError('unavailable', `BGE-M3 ${sourceKind} source is unavailable`);
    const controller = new AbortController();
    this.downloadController = controller;
    this.bgeState = {
      status: 'downloading',
      source: sourceKind,
      progress: 0,
      downloadedBytes: 0,
      cpuFallback: input.cpuFallback ?? true,
      serviceStatus: 'not_started',
      degraded: false,
      denseReady: false,
    };
    this.downloadPromise = this.runBgeDownload({
      source,
      revision: input.revision,
      controller,
    }).finally(() => {
      if (this.downloadController === controller) this.downloadController = undefined;
      this.downloadPromise = undefined;
    });
    return this.publicBgeStatus(false, 0);
  }

  cancelBgeDownload(): BgeRuntimeStatus {
    if (this.downloadPromise) {
      this.downloadController?.abort(new Error('cancelled by user'));
      this.modelManager.cancelDownload('cancelled by user');
      this.bgeState = {
        ...this.bgeState,
        status: 'failed',
        error: 'BGE-M3 download was cancelled; partial files are retained for resume.',
        errorCode: 'cancelled',
      };
    }
    return this.publicBgeStatus(false, 0);
  }

  async rebuildRag(input: RebuildRagInput): Promise<unknown> {
    const service = this.requireRagService();
    await this.openHandle({ projectId: input.projectId, projectRoot: input.projectRoot });
    return await service.client().rebuildIndex({
      project_id: input.projectId,
      book_id: input.bookId,
      indexes: input.indexes,
      force: input.force,
    });
  }

  async verifyRag(reference: RagProjectReference, cpuFallback = true): Promise<{
    status: BgeRuntimeStatus;
    verification?: unknown;
  }> {
    const status = await this.verifyBge(cpuFallback);
    if (status.status !== 'available') return { status };
    if (!reference.projectId || !reference.projectRoot || !reference.bookId) return { status };
    await this.openHandle({ projectId: reference.projectId, projectRoot: reference.projectRoot });
    const verification = await this.requireRagService().client().verify({
      project_id: reference.projectId,
      book_id: reference.bookId,
    });
    return { status: await this.ragStatus(reference), verification };
  }

  qualityStatus(): TranslationQualityStatus {
    const available = this.bgeState.status === 'available' && this.bgeState.denseReady;
    const warnings = available
      ? this.bgeState.degraded
        ? ['BGE-M3 is available in degraded mode; inspect RAG capabilities before relying on sparse/rerank retrieval.']
        : []
      : [
          'BGE-M3 is unavailable. A second audit and repair pass is mandatory and cannot be disabled.',
          'The first audit receives the current and next chapter; the last chapter receives a safe prior-chapter summary.',
          'Extra model calls increase token usage and cost.',
        ];
    return {
      available,
      bgeStatus: this.bgeState.status,
      ragServiceStatus: this.bgeState.serviceStatus,
      forcedSecondReview: !available,
      adjacentChapterAudit: !available,
      extraCostWarning: !available,
      warnings,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.downloadController?.abort(new Error('server shutting down'));
    this.modelManager.cancelDownload('server shutting down');
    await this.downloadPromise?.catch(() => undefined);
    this.removeProgressListener();
    await this.stopRagService();
    for (const handle of this.handles.values()) handle.ledger.close();
    this.handles.clear();
  }

  private async openHandle(reference: ProjectReference, requireExisting = true): Promise<ProjectHandle> {
    this.assertOpen();
    if (!SAFE_PROJECT_ID.test(reference.projectId)) {
      throw new TranslationRuntimeError('invalid', 'project_id is invalid');
    }
    const root = normalizeProjectRoot(reference.projectRoot);
    const databasePath = join(root, 'ledger', DATABASE_FILE);
    const artifactRoot = join(root, 'artifacts');
    const key = pathKey(root);
    const cached = this.handles.get(key);
    if (cached) {
      const project = cached.ledger.getProject(reference.projectId);
      if (requireExisting && !project) throw projectNotFound(reference.projectId);
      if (project && project.projectId !== reference.projectId) throw projectNotFound(reference.projectId);
      return cached;
    }
    if (requireExisting) {
      try {
        const info = await stat(databasePath);
        if (!info.isFile()) throw projectNotFound(reference.projectId);
      } catch (error) {
        if (error instanceof TranslationRuntimeError) throw error;
        throw projectNotFound(reference.projectId);
      }
    }
    await mkdir(dirname(databasePath), { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    const ledger = new TranslationProjectLedger({ databasePath });
    const handle: ProjectHandle = { root, databasePath, artifactRoot, ledger };
    this.handles.set(key, handle);
    if (requireExisting && !ledger.getProject(reference.projectId)) {
      ledger.close();
      this.handles.delete(key);
      throw projectNotFound(reference.projectId);
    }
    return handle;
  }

  private async loadProjectFiles(handle: ProjectHandle): Promise<LoadedProject> {
    if (handle.project && handle.manifest) return { project: handle.project, manifest: handle.manifest };
    const metadataPath = join(handle.root, 'ledger', PROJECT_METADATA_FILE);
    let project: RuntimeTranslationProject;
    try {
      project = validateRuntimeProject(JSON.parse(await readFile(metadataPath, 'utf8')) as unknown);
    } catch (error) {
      throw new TranslationRuntimeError(
        'not_found',
        error instanceof TranslationRuntimeError ? error.message : 'Translation project metadata is missing or invalid',
      );
    }
    if (!samePath(project.paths.projectRoot, handle.root)) {
      throw new TranslationRuntimeError('conflict', 'Stored translation project root does not match the requested root');
    }
    const manifest = await readManifest(project.paths.manifestPath);
    handle.project = project;
    handle.manifest = manifest;
    return { project, manifest };
  }

  private async copyUploadedSource(
    fileId: string,
    project: RuntimeTranslationProject,
  ): Promise<{ sha256: string; byteLength: number; originalModifiedAtMs: number }> {
    const sourceCopy = resolve(project.paths.sourceCopy);
    assertPathWithin(project.paths.projectRoot, sourceCopy, 'source copy path');
    if (isAbsolute(project.source.sourcePath) && samePath(project.source.sourcePath, sourceCopy)) {
      throw new TranslationRuntimeError('invalid', 'source copy must not overwrite the original source');
    }
    const uploaded = await this.fileService.get(fileId).catch(() => {
      throw new TranslationRuntimeError('not_found', 'Uploaded source file was not found');
    });
    if (uploaded.meta.sha256 && uploaded.meta.sha256 !== project.source.sha256) {
      throw new TranslationRuntimeError('conflict', 'Uploaded source SHA-256 does not match project metadata');
    }
    if (uploaded.meta.size !== project.source.sizeBytes) {
      throw new TranslationRuntimeError('conflict', 'Uploaded source size does not match project metadata');
    }

    const existing = await optionalFileReceipt(sourceCopy);
    if (existing) {
      if (existing.sha256 !== project.source.sha256 || existing.byteLength !== project.source.sizeBytes) {
        throw new TranslationRuntimeError('conflict', 'Immutable source copy already exists with different bytes');
      }
      return {
        sha256: existing.sha256,
        byteLength: existing.byteLength,
        originalModifiedAtMs: Date.parse(uploaded.meta.created_at),
      };
    }

    await mkdir(dirname(sourceCopy), { recursive: true });
    const temporary = `${sourceCopy}.upload-${process.pid}-${randomUUID()}`;
    const handle = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    let byteLength = 0;
    try {
      for await (const chunk of uploaded.stream()) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        byteLength += bytes.byteLength;
        hash.update(bytes);
        await handle.write(bytes);
      }
      await handle.sync();
      await handle.close();
      const sha256 = hash.digest('hex');
      if (sha256 !== project.source.sha256 || byteLength !== project.source.sizeBytes) {
        throw new TranslationRuntimeError('conflict', 'Uploaded source failed byte-level SHA-256 or size verification');
      }
      try {
        // A same-directory hard link is an atomic no-overwrite publication.
        await link(temporary, sourceCopy);
      } catch (error) {
        const raced = await optionalFileReceipt(sourceCopy);
        if (!raced || raced.sha256 !== sha256 || raced.byteLength !== byteLength) throw error;
      }
      await chmod(sourceCopy, 0o444);
      return { sha256, byteLength, originalModifiedAtMs: Date.parse(uploaded.meta.created_at) };
    } finally {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async loadOrCreateManifest(project: RuntimeTranslationProject): Promise<{
    manifest: BookManifest;
    manifestSha256: string;
  }> {
    const manifestPath = resolve(project.paths.manifestPath);
    assertPathWithin(project.paths.projectRoot, manifestPath, 'manifest path');
    try {
      const manifest = await readManifest(manifestPath);
      return { manifest, manifestSha256: hashCanonicalJson(manifest) };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    const parsed = await parseTranslationSource(project.paths.sourceCopy);
    try {
      const manifestSha256 = await writeBookManifest(manifestPath, parsed.manifest);
      return { manifest: parsed.manifest, manifestSha256 };
    } catch (error) {
      // A concurrent idempotent initialize may have published it first.
      const manifest = await readManifest(manifestPath).catch(() => undefined);
      if (!manifest) throw error;
      return { manifest, manifestSha256: hashCanonicalJson(manifest) };
    }
  }

  private assertManifestMatchesProject(
    manifest: BookManifest,
    project: RuntimeTranslationProject,
    copiedSha256: string,
    copiedSize: number,
  ): void {
    if (
      manifest.format !== project.source.kind
      || manifest.source.sha256 !== project.source.sha256
      || manifest.source.sha256 !== copiedSha256
      || manifest.source.byte_length !== project.source.sizeBytes
      || manifest.source.byte_length !== copiedSize
    ) {
      throw new TranslationRuntimeError('conflict', 'Book manifest does not match the immutable uploaded source');
    }
  }

  private registerManifest(
    ledger: TranslationProjectLedger,
    project: RuntimeTranslationProject,
    manifest: BookManifest,
  ): void {
    const resourcesByPath = new Map(manifest.resources.map((resource) => [resource.zip_path, resource]));
    for (const chapter of manifest.chapters) {
      const sourceItemId = `source_${chapter.chapter_id}`;
      const resource = resourcesByPath.get(chapter.source_path);
      ledger.registerSourceItem({
        sourceItemId,
        projectId: project.projectId,
        href: chapter.source_path,
        mediaType: chapter.media_type,
        kind: 'body',
        spineIndex: chapter.ordinal - 1,
        linear: chapter.linear,
        // immutablePath is the whole copied container, so the ledger's file
        // integrity hash must be the container hash. Preserve the inner EPUB
        // resource hash separately as provenance.
        sourceHash: project.source.sha256,
        immutablePath: project.paths.sourceCopy,
        metadata: {
          book_id: manifest.book_id,
          chapter_id: chapter.chapter_id,
          manifest_id: chapter.manifest_id ?? null,
          resource_sha256: resource?.sha256 ?? null,
        },
      });
      for (const paragraph of chapter.paragraphs) {
        ledger.registerParagraph({
          paragraphId: paragraph.paragraph_id,
          projectId: project.projectId,
          sourceItemId,
          ordinal: paragraph.ordinal,
          sourceText: paragraph.source_text,
          sourceHash: paragraph.source_hash,
          entities: [],
        });
      }
    }
  }

  private async persistRuntimeProject(handle: ProjectHandle, project: RuntimeTranslationProject): Promise<void> {
    const path = join(handle.root, 'ledger', PROJECT_METADATA_FILE);
    const existing = await readFile(path, 'utf8').catch((error: unknown) => {
      if (isMissingFile(error)) return undefined;
      throw error;
    });
    if (existing !== undefined) {
      const stored = validateRuntimeProject(JSON.parse(existing) as unknown);
      if (
        stored.projectId !== project.projectId
        || stored.source.sha256 !== project.source.sha256
        || !samePath(stored.paths.sourceCopy, project.paths.sourceCopy)
        || !samePath(stored.paths.manifestPath, project.paths.manifestPath)
      ) {
        throw new TranslationRuntimeError('conflict', 'Stored project metadata has a different immutable identity');
      }
      return;
    }
    await writeExclusiveJson(path, project);
  }

  private async runBgeDownload(options: {
    source: ReturnType<BgeM3ModelManager['sources']>[number];
    revision?: string;
    controller: AbortController;
  }): Promise<void> {
    try {
      const plan = await this.modelManager.plan({
        source: options.source,
        destination: this.modelDestination,
        revision: options.revision,
        signal: options.controller.signal,
      });
      const disk = await checkModelDownloadDiskSpace(plan);
      this.bgeState = {
        ...this.bgeState,
        totalBytes: plan.total_bytes,
        diskAvailableBytes: disk.available_bytes,
        diskRequiredBytes: disk.required_bytes,
      };
      const result = await this.modelManager.download(plan, { signal: options.controller.signal });
      this.discoveredModel = {
        ...result.fingerprint,
        directory: result.directory,
        source: 'managed',
      };
      this.bgeState = {
        ...this.bgeState,
        status: 'verifying',
        progress: 100,
        downloadedBytes: plan.total_bytes,
        totalBytes: plan.total_bytes,
        modelPath: result.directory,
        fingerprint: result.fingerprint.fingerprint,
        error: undefined,
        errorCode: undefined,
      };
      await this.startRagForModel(this.discoveredModel, options.controller.signal);
    } catch (error) {
      if (options.controller.signal.aborted) {
        this.bgeState = {
          ...this.bgeState,
          status: 'failed',
          error: 'BGE-M3 download was cancelled; partial files are retained for resume.',
          errorCode: 'cancelled',
        };
      } else {
        this.markBgeFailure(error, classifyBgeError(error));
      }
      this.logger.warn({ err: safeErrorText(error) }, 'BGE-M3 setup failed');
    }
  }

  private async startRagForModel(model: DiscoveredModel, signal?: AbortSignal): Promise<void> {
    await this.stopRagService();
    let python = await probeRagPython(
      this.ragPythonExecutable ? { pythonExecutable: this.ragPythonExecutable } : undefined,
    );
    if (!python.available) {
      try {
        const prepared = await prepareRagPythonEnvironment({
          homeDirectory: this.homeDir,
          packageIndex: this.bgeState.source,
          signal,
        });
        this.ragPythonExecutable = prepared.pythonExecutable;
        python = await probeRagPython({ pythonExecutable: prepared.pythonExecutable });
      } catch (error) {
        if (signal?.aborted) throw error;
        this.markBgeFailure(error, 'service_unavailable');
        return;
      }
    }
    if (!python.available) {
      this.bgeState = {
        ...this.bgeState,
        status: 'failed',
        modelPath: model.directory,
        fingerprint: model.fingerprint,
        serviceStatus: 'unavailable',
        denseReady: false,
        error: python.missingPackages.length > 0
          ? `Local RAG dependencies are unavailable: ${python.missingPackages.join(', ')}`
          : 'A compatible local Python runtime for RAG is unavailable.',
        errorCode: 'service_unavailable',
      };
      return;
    }
    try {
      const service = await TranslationRagService.start({
        pythonExecutable: python.pythonExecutable,
        dataRoot: this.ragDataRoot,
        modelPath: model.directory,
        host: '127.0.0.1',
        port: 0,
        preferDevice: this.bgeState.cpuFallback ? 'auto' : 'cuda',
      });
      const health = await service.client().health();
      this.ragService = service;
      this.acceptRagHealth(health, model);
      if (this.bgeState.status !== 'available') {
        await this.stopRagService();
        return;
      }
      await this.publishRagRuntimeDescriptor({
        url: service.url,
        token: service.token,
        instanceId: service.instanceId,
      });
    } catch (error) {
      this.markBgeFailure(error, 'service_unavailable');
      await this.stopRagService();
    }
  }

  private acceptRagHealth(health: RagHealthResponse, model: DiscoveredModel): void {
    const denseReady = health.capabilities.dense === true;
    const serviceStatus = health.status === 'ready'
      ? health.degraded ? 'degraded' : 'ready'
      : health.status === 'degraded'
        ? 'degraded'
        : 'unavailable';
    const usable = denseReady && (serviceStatus === 'ready' || serviceStatus === 'degraded');
    this.bgeState = {
      ...this.bgeState,
      status: usable ? 'available' : 'failed',
      modelPath: model.directory,
      fingerprint: health.model?.fingerprint ?? model.fingerprint,
      serviceStatus,
      degraded: health.degraded || serviceStatus === 'degraded',
      denseReady,
      capabilities: health.capabilities,
      error: usable ? undefined : health.warnings.join('; ') || 'Local RAG service is unavailable.',
      errorCode: usable ? undefined : 'service_unavailable',
    };
  }

  private acceptModelProgress(progress: ModelDownloadProgress): void {
    const status: BgeSetupStatus = progress.phase === 'verifying'
      ? 'verifying'
      : progress.phase === 'completed'
        ? 'detected'
        : progress.phase === 'failed' || progress.phase === 'cancelled'
          ? 'failed'
          : progress.phase === 'discovering'
            ? this.bgeState.status
            : 'downloading';
    this.bgeState = {
      ...this.bgeState,
      status,
      progress: progress.percent,
      downloadedBytes: progress.bytes_downloaded,
      totalBytes: progress.bytes_total,
      error: progress.phase === 'failed' || progress.phase === 'cancelled' ? progress.message : undefined,
      errorCode: progress.phase === 'cancelled' ? 'cancelled' : this.bgeState.errorCode,
    };
  }

  private markBgeFailure(error: unknown, code: NonNullable<BgeRuntimeStatus['errorCode']>): void {
    this.bgeState = {
      ...this.bgeState,
      status: 'failed',
      serviceStatus: 'unavailable',
      denseReady: false,
      error: publicBgeError(error, code),
      errorCode: code,
    };
  }

  private publicBgeStatus(indexReady: boolean, points: number): BgeRuntimeStatus {
    return {
      status: this.bgeState.status,
      source: this.bgeState.source,
      progress: this.bgeState.progress,
      downloadedBytes: this.bgeState.downloadedBytes,
      totalBytes: this.bgeState.totalBytes,
      diskAvailableBytes: this.bgeState.diskAvailableBytes,
      diskRequiredBytes: this.bgeState.diskRequiredBytes,
      modelPath: this.bgeState.modelPath,
      fingerprint: this.bgeState.fingerprint,
      cpuFallback: this.bgeState.cpuFallback,
      serviceStatus: this.bgeState.serviceStatus,
      degraded: this.bgeState.degraded,
      denseReady: this.bgeState.denseReady,
      indexReady,
      points,
      capabilities: this.bgeState.capabilities,
      error: this.bgeState.error,
      errorCode: this.bgeState.errorCode,
      recommendedVramGb: 4,
      qualityMessage: 'BGE-M3 improves terminology, callbacks, and long-range translation consistency.',
      fallbackMessage: 'Without BGE-M3, a second audit and repair pass is mandatory and increases model cost.',
      modelDownloadIsExplicit: true,
    };
  }

  private requireRagService(): TranslationRagService {
    if (!this.ragService || this.ragService.isClosed || this.bgeState.status !== 'available') {
      throw new TranslationRuntimeError('unavailable', 'Local BGE-M3 RAG service is unavailable');
    }
    return this.ragService;
  }

  private async publishRagRuntimeDescriptor(runtime: {
    readonly url: string;
    readonly token: string;
    readonly instanceId: string;
  }): Promise<void> {
    await this.clearRagRuntimeDescriptor();
    await writeAtomicPrivateJson(this.ragRuntimeDescriptorPath, {
      url: runtime.url,
      token: runtime.token,
      instance_id: runtime.instanceId,
    });
    process.env[RAG_RUNTIME_ENV] = this.ragRuntimeDescriptorPath;
  }

  private async clearRagRuntimeDescriptor(): Promise<void> {
    await rm(this.ragRuntimeDescriptorPath, { force: true }).catch(() => undefined);
    if (process.env[RAG_RUNTIME_ENV] === this.ragRuntimeDescriptorPath) {
      delete process.env[RAG_RUNTIME_ENV];
    }
  }

  private async stopRagService(): Promise<void> {
    const service = this.ragService;
    this.ragService = undefined;
    await this.clearRagRuntimeDescriptor();
    if (service) await service.close().catch(() => undefined);
  }

  private async withProjectLock<T>(projectRoot: string, action: () => Promise<T>): Promise<T> {
    const key = pathKey(normalizeProjectRoot(projectRoot));
    const predecessor = this.projectLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = predecessor.catch(() => undefined).then(() => gate);
    this.projectLocks.set(key, queued);
    await predecessor.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.projectLocks.get(key) === queued) this.projectLocks.delete(key);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new TranslationRuntimeError('unavailable', 'Translation runtime is closed');
  }
}

function validateRuntimeProject(value: unknown): RuntimeTranslationProject {
  if (!isRecord(value)) throw new TranslationRuntimeError('invalid', 'project must be an object');
  const projectId = requiredString(value, 'projectId');
  if (!SAFE_PROJECT_ID.test(projectId)) throw new TranslationRuntimeError('invalid', 'project.projectId is invalid');
  const name = requiredString(value, 'name');
  const rawLanguages = value['languages'];
  const languages = rawLanguages === undefined
    ? { source: 'auto' as const, target: 'zh-CN' as const }
    : rawLanguages;
  if (!isRecord(languages)) {
    throw new TranslationRuntimeError('invalid', 'project.languages must be an object');
  }
  const sourceLanguage = languages['source'];
  const targetLanguage = languages['target'];
  if (typeof sourceLanguage !== 'string' || !sourceLanguage.trim() || sourceLanguage.length > 80) {
    throw new TranslationRuntimeError('invalid', 'project.languages.source is invalid');
  }
  if (!['zh-CN', 'en'].includes(String(targetLanguage))) {
    throw new TranslationRuntimeError('invalid', 'project.languages.target is invalid');
  }
  if (sourceLanguage !== 'auto' && sourceLanguage === targetLanguage) {
    throw new TranslationRuntimeError('invalid', 'project source and target languages must differ');
  }
  const model = requiredString(value, 'model');
  splitPinnedModel(model);
  const source = value['source'];
  if (!isRecord(source)) throw new TranslationRuntimeError('invalid', 'project.source must be an object');
  const kind = source['kind'];
  if (kind !== 'epub' && kind !== 'txt') throw new TranslationRuntimeError('invalid', 'project.source.kind is invalid');
  const sourcePath = requiredString(source, 'sourcePath');
  if (source['immutable'] !== true) throw new TranslationRuntimeError('invalid', 'project source must be immutable');
  const sourceSha256 = requiredString(source, 'sha256');
  if (!SHA256.test(sourceSha256)) {
    throw new TranslationRuntimeError('invalid', 'project.source.sha256 must be 64 lowercase hexadecimal characters');
  }
  const sourceSize = source['sizeBytes'];
  if (!Number.isSafeInteger(sourceSize) || (sourceSize as number) < 0) {
    throw new TranslationRuntimeError('invalid', 'project.source.sizeBytes must be a non-negative integer');
  }
  const paths = value['paths'];
  if (!isRecord(paths)) throw new TranslationRuntimeError('invalid', 'project.paths must be an object');
  const pathNames = [
    'projectRoot', 'sourcePath', 'sourceCopy', 'unpackedDir', 'manifestPath', 'memoryDir',
    'translationDir', 'reviewsDir', 'repairsDir', 'finalDir', 'logsDir', 'stateDir',
    'taskManifestPath', 'issuesPath', 'checkpointPath', 'finalOutputPath', 'finalReportPath',
  ] as const;
  const normalizedPaths: Record<string, string> = {};
  for (const name of pathNames) normalizedPaths[name] = requiredString(paths, name);
  const root = normalizeProjectRoot(normalizedPaths['projectRoot']!);
  for (const name of pathNames) {
    if (name === 'sourcePath') continue;
    if (name === 'projectRoot') continue;
    if (!isAbsolute(normalizedPaths[name]!)) {
      throw new TranslationRuntimeError('invalid', `project.paths.${name} must be absolute`);
    }
    assertPathWithin(root, normalizedPaths[name]!, `project.paths.${name}`);
  }
  if (!samePath(normalizedPaths['projectRoot']!, root)) {
    throw new TranslationRuntimeError('invalid', 'project.paths.projectRoot must be a normalized absolute path');
  }
  const expectedSuffix = kind === 'epub' ? '.epub' : '.txt';
  if (!normalizedPaths['sourceCopy']!.toLowerCase().endsWith(expectedSuffix)) {
    throw new TranslationRuntimeError('invalid', `project.paths.sourceCopy must end in ${expectedSuffix}`);
  }

  const workflow = value['workflow'];
  if (!isRecord(workflow)) throw new TranslationRuntimeError('invalid', 'project.workflow must be an object');
  for (const name of ['secondTranslation', 'secondReview', 'consistencyReview']) {
    if (typeof workflow[name] !== 'boolean') {
      throw new TranslationRuntimeError('invalid', `project.workflow.${name} must be boolean`);
    }
  }
  const maxAgents = value['maxAgents'];
  if (!Number.isSafeInteger(maxAgents) || (maxAgents as number) <= 0) {
    throw new TranslationRuntimeError('invalid', 'project.maxAgents must be a positive integer');
  }
  const executionPolicy = value['executionPolicy'];
  if (!isRecord(executionPolicy)) {
    throw new TranslationRuntimeError('invalid', 'project.executionPolicy must be an object');
  }
  for (const name of ['softBudgetMicros', 'hardBudgetMicros'] as const) {
    const budget = executionPolicy[name];
    if (budget !== null && (!Number.isSafeInteger(budget) || (budget as number) < 0)) {
      throw new TranslationRuntimeError(
        'invalid',
        `project.executionPolicy.${name} must be null or a non-negative integer`,
      );
    }
  }
  const softBudget = executionPolicy['softBudgetMicros'] as number | null;
  const hardBudget = executionPolicy['hardBudgetMicros'] as number | null;
  if (softBudget !== null && hardBudget !== null && hardBudget < softBudget) {
    throw new TranslationRuntimeError(
      'invalid',
      'project.executionPolicy.hardBudgetMicros must be greater than or equal to softBudgetMicros',
    );
  }
  const maxRetries = executionPolicy['maxRetries'];
  if (!Number.isSafeInteger(maxRetries) || (maxRetries as number) < 0) {
    throw new TranslationRuntimeError('invalid', 'project.executionPolicy.maxRetries must be a non-negative integer');
  }
  const maxConcurrency = executionPolicy['maxConcurrency'];
  if (
    !Number.isSafeInteger(maxConcurrency)
    || (maxConcurrency as number) <= 0
    || (maxConcurrency as number) > (maxAgents as number)
  ) {
    throw new TranslationRuntimeError(
      'invalid',
      'project.executionPolicy.maxConcurrency must be a positive integer no greater than project.maxAgents',
    );
  }
  for (const name of ['schemaVersion', 'revision', 'overrideRevision']) {
    if (!Number.isSafeInteger(value[name]) || (value[name] as number) < 0) {
      throw new TranslationRuntimeError('invalid', `project.${name} must be a non-negative integer`);
    }
  }
  for (const name of ['createdAt', 'updatedAt']) {
    const timestamp = requiredString(value, name);
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new TranslationRuntimeError('invalid', `project.${name} must be an ISO timestamp`);
    }
  }
  for (const name of ['status', 'planFingerprint', 'promptVersion']) requiredString(value, name);
  for (const name of ['stages', 'chapters', 'issues', 'artifacts', 'checkpoints', 'overrides']) {
    if (!Array.isArray(value[name])) throw new TranslationRuntimeError('invalid', `project.${name} must be an array`);
  }
  return {
    ...value,
    languages: {
      source: sourceLanguage.trim(),
      target: targetLanguage as RuntimeTranslationProject['languages']['target'],
    },
  } as unknown as RuntimeTranslationProject;
}

function taskBookText(project: RuntimeTranslationProject, manifest: BookManifest): string {
  return buildTranslationTaskBook(project, manifest);
}

async function writeTranslationTaskBook(
  project: RuntimeTranslationProject,
  manifest: BookManifest,
): Promise<void> {
  const path = join(project.paths.projectRoot, 'translation-task.txt');
  assertPathWithin(project.paths.projectRoot, path, 'translation task book');
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(taskBookText(project, manifest), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isRecord(error) || error['code'] !== 'EEXIST') throw error;
    const existing = await readFile(path, 'utf8');
    if (
      existing !== buildLegacyTranslationTaskBook(project, manifest)
      && existing !== buildTranslationTaskBookV3(project, manifest)
    ) {
      // The task book is user-readable and may contain deliberate notes. Reuse
      // any unknown or edited file instead of overwriting user changes.
      return;
    }
    // Upgrade only the byte-for-byte output of the previous generator. This
    // lets existing projects receive the richer contract without touching a
    // task book that the user or an agent edited deliberately.
    const handle = await open(path, 'w', 0o600);
    try {
      await handle.writeFile(taskBookText(project, manifest), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function splitPinnedModel(value: string): { providerId: string; modelId: string } {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new TranslationRuntimeError(
      'invalid',
      'Translation model must be a non-empty identifier of at most 512 characters without control characters',
    );
  }

  const parts = normalized.split('/');
  const modelId = parts.at(-1)?.trim() ?? '';
  if (!modelId) throw new TranslationRuntimeError('invalid', 'Translation model identity is invalid');
  const providerParts = parts.slice(0, -1).map((part) => part.trim());
  if (providerParts.some((part) => !part)) {
    throw new TranslationRuntimeError('invalid', 'Translation provider identity is invalid');
  }
  const providerId = providerParts.length > 0 ? providerParts.join('/') : 'configured';
  if (!providerId) throw new TranslationRuntimeError('invalid', 'Translation provider identity is invalid');
  return { providerId, modelId };
}

function assertSameLedgerProject(
  existing: ProjectRecord,
  project: RuntimeTranslationProject,
  artifactRoot: string,
): void {
  const pinned = splitPinnedModel(project.model);
  if (
    existing.sourceHash !== project.source.sha256
    || !samePath(existing.sourceRootPath, dirname(project.paths.sourceCopy))
    || !samePath(existing.artifactRootPath, artifactRoot)
    || existing.providerId !== pinned.providerId
    || existing.modelId !== pinned.modelId
    || existing.softBudgetMicros !== project.executionPolicy.softBudgetMicros
    || existing.hardBudgetMicros !== project.executionPolicy.hardBudgetMicros
    || existing.maxRetries !== project.executionPolicy.maxRetries
    || existing.maxConcurrency !== project.executionPolicy.maxConcurrency
  ) {
    throw new TranslationRuntimeError(
      'conflict',
      'Existing ledger project has a different immutable identity, model pin, or execution policy',
    );
  }
}

function validateSelectedFinalArtifacts(
  ledger: TranslationProjectLedger,
  projectId: string,
  artifactIds: readonly string[],
  finalTaskTypes: readonly string[],
  planFingerprint: string,
): string[] {
  if (artifactIds.length === 0) {
    throw new TranslationRuntimeError('invalid', 'final_artifact_ids cannot be empty when provided');
  }
  const uniqueIds = [...new Set(artifactIds)];
  if (uniqueIds.length !== artifactIds.length) {
    throw new TranslationRuntimeError('invalid', 'final_artifact_ids cannot contain duplicates');
  }
  const project = ledger.getProject(projectId);
  if (!project) throw projectNotFound(projectId);
  const allowedTaskTypes = new Set(finalTaskTypes);
  for (const artifactId of uniqueIds) {
    if (!SAFE_PROJECT_ID.test(artifactId)) {
      throw new TranslationRuntimeError('invalid', 'final_artifact_ids contains an invalid ledger identifier');
    }
    const artifact = ledger.getArtifact(artifactId);
    if (!artifact || artifact.projectId !== projectId) {
      throw new TranslationRuntimeError('conflict', `Selected final artifact does not exist: ${artifactId}`);
    }
    if (artifact.state !== 'ACTIVE') {
      throw new TranslationRuntimeError('conflict', `Selected final artifact is stale or rejected: ${artifactId}`);
    }
    if (artifact.instructionVersion !== project.instructionVersion) {
      throw new TranslationRuntimeError('conflict', `Selected final artifact has a stale instruction version: ${artifactId}`);
    }
    const task = ledger.getTask(artifact.taskId);
    if (
      !task
      || task.projectId !== projectId
      || task.state !== 'SUCCEEDED'
      || !allowedTaskTypes.has(task.taskType)
    ) {
      throw new TranslationRuntimeError('conflict', `Selected artifact is not a succeeded final-task artifact: ${artifactId}`);
    }
    const artifactPlan = artifact.provenance['plan_fingerprint']
      ?? artifact.provenance['planFingerprint']
      ?? task.scope['plan_fingerprint']
      ?? task.scope['planFingerprint'];
    if (artifactPlan !== planFingerprint) {
      throw new TranslationRuntimeError('conflict', `Selected final artifact does not match the current plan: ${artifactId}`);
    }
  }
  return uniqueIds;
}

function discoverFinalArtifactIds(
  ledger: TranslationProjectLedger,
  projectId: string,
  finalTaskTypes: readonly string[],
  planFingerprint: string,
): string[] {
  const allowedTaskTypes = new Set(finalTaskTypes);
  const candidates = ledger.listArtifacts(projectId, 'ACTIVE')
    .filter((artifact) => {
      const task = ledger.getTask(artifact.taskId);
      return task?.state === 'SUCCEEDED' && allowedTaskTypes.has(task.taskType);
    })
    .map((artifact) => artifact.artifactId);
  return candidates.length === 0
    ? []
    : validateSelectedFinalArtifacts(
        ledger,
        projectId,
        candidates,
        finalTaskTypes,
        planFingerprint,
      );
}

async function readLedgerFinalArtifactReceipt(
  ledger: TranslationProjectLedger,
  projectId: string,
  artifactId: string,
): Promise<FinalArtifactReceipt> {
  const artifact = ledger.getArtifact(artifactId);
  if (!artifact || artifact.projectId !== projectId || artifact.state !== 'ACTIVE') {
    throw new TranslationRuntimeError('conflict', `Final artifact is missing or stale: ${artifactId}`);
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(await readFile(artifact.filePath, 'utf8')) as unknown;
  } catch {
    throw new TranslationRuntimeError('conflict', `Final artifact envelope is missing or unreadable: ${artifactId}`);
  }
  if (
    !isRecord(envelope)
    || envelope['artifactId'] !== artifactId
    || envelope['projectId'] !== projectId
    || envelope['taskId'] !== artifact.taskId
  ) {
    throw new TranslationRuntimeError('conflict', `Final artifact envelope identity is invalid: ${artifactId}`);
  }
  const payload = envelope['payload'];
  if (hashCanonicalJson(payload) !== artifact.payloadHash) {
    throw new TranslationRuntimeError('conflict', `Final artifact payload hash is invalid: ${artifactId}`);
  }
  const candidate = unwrapFinalArtifactReceipt(payload);
  if (!isFinalArtifactReceipt(candidate)) {
    throw new TranslationRuntimeError('conflict', `Final task artifact does not contain a render receipt: ${artifactId}`);
  }
  return candidate;
}

function unwrapFinalArtifactReceipt(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value['schema_version'] === 1 && value['immutable'] === true) return value;
  for (const key of ['final_artifact', 'finalArtifact', 'receipt', 'data']) {
    const nested: unknown = value[key];
    if (isRecord(nested) && nested !== value) {
      const candidate = unwrapFinalArtifactReceipt(nested);
      if (isFinalArtifactReceipt(candidate)) return candidate;
    }
  }
  return value;
}

function isFinalArtifactReceipt(value: unknown): value is FinalArtifactReceipt {
  if (!isRecord(value) || value['schema_version'] !== 1 || value['immutable'] !== true) return false;
  if (value['artifact_type'] !== 'epub' && value['artifact_type'] !== 'txt') return false;
  for (const key of ['output_path', 'source_path', 'source_sha256', 'artifact_sha256', 'created_at']) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim()) return false;
  }
  if (!SHA256.test(value['source_sha256'] as string) || !SHA256.test(value['artifact_sha256'] as string)) {
    return false;
  }
  for (const key of ['byte_length', 'paragraph_count', 'translated_paragraph_count']) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) return false;
  }
  if (typeof value['coverage'] !== 'number' || value['coverage'] < 0 || value['coverage'] > 1) return false;
  const validation = value['structural_validation'];
  if (
    !isRecord(validation)
    || typeof validation['valid'] !== 'boolean'
    || !Array.isArray(validation['checks'])
    || !Array.isArray(validation['warnings'])
    || !Array.isArray(validation['errors'])
  ) return false;
  const provenance = value['provenance'];
  if (!isRecord(provenance) || provenance['project_id'] === undefined) return false;
  for (const key of ['project_id', 'prompt_fingerprint', 'context_hash', 'model_fingerprint', 'merge_receipt_hash']) {
    if (typeof provenance[key] !== 'string' || !(provenance[key] as string).trim()) return false;
  }
  return Number.isSafeInteger(provenance['instruction_version'])
    && (provenance['instruction_version'] as number) >= 0;
}

function validateFinalArtifactReceipt(
  receipt: FinalArtifactReceipt,
  project: RuntimeTranslationProject,
  manifest: BookManifest,
  currentInstructionVersion: number,
): void {
  if (receipt.provenance.project_id !== project.projectId) {
    throw new TranslationRuntimeError('conflict', 'Final artifact belongs to a different project');
  }
  if (!samePath(receipt.output_path, project.paths.finalOutputPath)) {
    throw new TranslationRuntimeError('conflict', 'Final artifact receipt points to an unexpected output path');
  }
  if (!samePath(receipt.source_path, project.paths.sourceCopy)) {
    throw new TranslationRuntimeError('conflict', 'Final artifact receipt points to an unexpected source path');
  }
  if (receipt.source_sha256 !== manifest.source.sha256) {
    throw new TranslationRuntimeError('conflict', 'Final artifact source hash differs from the manifest');
  }
  if (receipt.provenance.instruction_version !== currentInstructionVersion) {
    throw new TranslationRuntimeError('conflict', 'Final artifact receipt has a stale instruction version');
  }
}

async function validateFinalBytes(bytes: Uint8Array, format: 'epub' | 'txt'): Promise<StructuralValidationResult> {
  if (format === 'epub') return await validateEpubStructure(bytes);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes,
    );
    return { valid: true, checks: ['Rendered TXT is valid UTF-8'], warnings: [], errors: [] };
  } catch {
    return { valid: false, checks: [], warnings: [], errors: ['Rendered TXT is not valid UTF-8'] };
  }
}

function buildDeterministicReportInput(
  manifest: BookManifest,
  finalArtifact: FinalArtifactReceipt,
  translations: readonly DeterministicReportInput['translations'][number][],
  ledger: DeterministicReportData,
  ragConfiguration: Readonly<Record<string, string | number | boolean>>,
): DeterministicReportInput {
  return {
    snapshot_as_of: ledger.generatedAt,
    manifest,
    translations,
    memory_records: ledger.rows.memoryRecords.map((row) => ({
      memory_id: rowString(row, 'memoryId'),
      type: rowString(row, 'memoryType'),
    })),
    rag_configuration: ragConfiguration,
    tasks: ledger.rows.tasks.map((row) => ({
      task_id: row.taskId,
      state: row.state,
    })),
    attempts: ledger.rows.attempts.map((row) => ({
      attempt_id: row.attemptId,
      task_id: row.taskId,
      state: row.state,
      retry_reason: row.retryReason ?? undefined,
    })),
    issues: ledger.rows.reviewIssues.map((row) => {
      const status = rowString(row, 'status');
      return {
        issue_id: rowString(row, 'issueId'),
        category: rowString(row, 'category'),
        severity: normalizeIssueSeverity(rowString(row, 'severity')),
        resolved: /^(RESOLVED|CLOSED)$/iu.test(status),
        accepted_exception: /ACCEPTED_EXCEPTION|WONT_FIX/iu.test(status),
      };
    }),
    patches: ledger.rows.repairPatches.map((row) => ({
      issue_id: rowString(row, 'issueId'),
      paragraph_id: rowString(row, 'paragraphId'),
    })),
    conflicts: ledger.rows.mergeConflicts.map((row) => ({
      conflict_id: rowString(row, 'conflictId'),
      resolved: /^(RESOLVED|CLOSED)$/iu.test(rowString(row, 'state')),
    })),
    costs: ledger.rows.costEvents.map((row) => ({
      event_id: rowString(row, 'costEventId'),
      input_tokens: rowNumber(row, 'inputTokens'),
      output_tokens: rowNumber(row, 'outputTokens'),
      reasoning_tokens: rowNumber(row, 'reasoningTokens'),
      cached_tokens: rowNumber(row, 'cachedTokens'),
      actual_cost: rowNumber(row, 'actualCostMicros') / 1_000_000,
      currency: priceCurrency(row['priceSnapshot']),
    })),
    final_artifact: finalArtifact,
  };
}

function costWarnings(ledger: DeterministicReportData): string[] {
  const unknown = ledger.rows.costEvents.filter((row) => {
    const snapshot = row['priceSnapshot'];
    return !isRecord(snapshot)
      || snapshot['availability'] === 'unavailable'
      || snapshot['unavailable'] === true
      || typeof snapshot['currency'] !== 'string';
  });
  return unknown.length > 0
    ? [`${unknown.length} usage event(s) recorded token counts, but monetary pricing was unavailable; zero is not asserted as the true cost.`]
    : [];
}

function ragReportConfiguration(state: MutableBgeState): Record<string, string | number | boolean> {
  return {
    bge_status: state.status,
    service_status: state.serviceStatus,
    dense_ready: state.denseReady,
    degraded: state.degraded,
    cpu_fallback: state.cpuFallback,
    fingerprint: state.fingerprint ?? 'unavailable',
  };
}

function rowString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : 'unknown';
}

function rowNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function priceCurrency(value: unknown): string {
  if (!isRecord(value)) return 'UNKNOWN';
  const currency = value['currency'];
  return typeof currency === 'string' && currency.trim() ? currency : 'UNKNOWN';
}

function normalizeIssueSeverity(value: string): 'low' | 'medium' | 'high' | 'critical' {
  const normalized = value.toLowerCase();
  return normalized === 'medium' || normalized === 'high' || normalized === 'critical'
    ? normalized
    : 'low';
}

async function readManifest(path: string): Promise<BookManifest> {
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  if (!isRecord(parsed) || parsed['schema_version'] !== 1) {
    throw new TranslationRuntimeError('conflict', 'Book manifest schema is invalid');
  }
  const source = parsed['source'];
  if (!isRecord(source) || typeof source['sha256'] !== 'string' || !SHA256.test(source['sha256'])) {
    throw new TranslationRuntimeError('conflict', 'Book manifest source receipt is invalid');
  }
  if (!Array.isArray(parsed['chapters']) || !Number.isSafeInteger(parsed['paragraph_count'])) {
    throw new TranslationRuntimeError('conflict', 'Book manifest contents are invalid');
  }
  return parsed as unknown as BookManifest;
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicPrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // POSIX enforces 0600; Windows applies the strongest supported mode and
    // still relies on the user's private product-home ACL.
    await chmod(temporary, 0o600).catch(() => undefined);
    await link(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensureUsageOutboxEntry(
  path: string,
  entry: PersistedUsageOutboxEntry,
): Promise<void> {
  try {
    await writeAtomicPrivateJson(path, entry);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = validateUsageOutboxEntry(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (hashCanonicalJson(existing) !== hashCanonicalJson(entry)) {
      throw new TranslationRuntimeError('conflict', 'Pending usage identity has contradictory contents');
    }
  }
}

async function readFileReceipt(path: string, label: string): Promise<{
  bytes: Buffer;
  sha256: string;
  byteLength: number;
}> {
  try {
    const bytes = await readFile(resolve(path));
    return { bytes, sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
  } catch {
    throw new TranslationRuntimeError('not_found', `${label} is missing or unreadable`);
  }
}

async function optionalFileReceipt(path: string): Promise<{
  sha256: string;
  byteLength: number;
  modifiedAt: string;
} | undefined> {
  try {
    const bytes = await readFile(resolve(path));
    const info = await stat(resolve(path));
    return {
      sha256: sha256Bytes(bytes),
      byteLength: bytes.byteLength,
      modifiedAt: info.mtime.toISOString(),
    };
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function optionalReportReceipt(path: string): Promise<{
  sha256: string;
  byteLength: number;
  generatedAt: string;
} | undefined> {
  try {
    const bytes = await readFile(resolve(path));
    const match = bytes.toString('utf8').match(/^- 数据快照时间：(.+)$/mu);
    const generatedAt = match?.[1]?.trim();
    if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) {
      throw new TranslationRuntimeError('conflict', 'Deterministic report snapshot timestamp is invalid');
    }
    return {
      sha256: sha256Bytes(bytes),
      byteLength: bytes.byteLength,
      generatedAt,
    };
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function requiredString(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== 'string' || !field.trim()) {
    throw new TranslationRuntimeError('invalid', `${name} must be a non-empty string`);
  }
  return field;
}

function translationUsageBinding(
  custom: Readonly<Record<string, unknown>> | undefined,
): ProjectReference | undefined {
  if (custom === undefined || custom['batchTranslation'] === undefined) return undefined;
  const project = custom['batchTranslation'];
  if (!isRecord(project)) {
    throw new TranslationRuntimeError('invalid', 'batchTranslation session metadata is invalid');
  }
  const projectId = project['projectId'];
  const paths = project['paths'];
  const projectRoot = isRecord(paths) ? paths['projectRoot'] : undefined;
  if (typeof projectId !== 'string' || !SAFE_PROJECT_ID.test(projectId)) {
    throw new TranslationRuntimeError('invalid', 'batchTranslation.projectId is invalid');
  }
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || !isAbsolute(projectRoot)) {
    throw new TranslationRuntimeError(
      'invalid',
      'batchTranslation.paths.projectRoot must be an absolute path',
    );
  }
  return { projectId, projectRoot: normalizeProjectRoot(projectRoot) };
}

function usageIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new TranslationRuntimeError('invalid', `Agent usage ${label} is invalid`);
  }
  return value;
}

function usageInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TranslationRuntimeError('invalid', `Agent usage ${label} is invalid`);
  }
  return value as number;
}

function validateUsageOutboxEntry(value: unknown): PersistedUsageOutboxEntry {
  if (!isRecord(value) || value['schemaVersion'] !== 1) {
    throw new TranslationRuntimeError('conflict', 'Pending usage schema is invalid');
  }
  const eventId = requiredString(value, 'eventId');
  const projectId = requiredString(value, 'projectId');
  if (!SHA256.test(eventId) || !SAFE_PROJECT_ID.test(projectId)) {
    throw new TranslationRuntimeError('conflict', 'Pending usage identity is invalid');
  }
  const projectRoot = normalizeProjectRoot(requiredString(value, 'projectRoot'));
  const sessionId = usageIdentity(value['sessionId'], 'pending session id');
  const agentId = usageIdentity(value['agentId'], 'pending agent id');
  const turnId = usageIdentity(value['turnId'], 'pending turn id');
  const modelId = usageIdentity(value['modelId'], 'pending model id');
  const providerId = usageIdentity(value['providerId'], 'pending provider id');
  const step = usageInteger(value['step'], 'pending step');
  const inputTokens = usageInteger(value['inputTokens'], 'pending input token count');
  const outputTokens = usageInteger(value['outputTokens'], 'pending output token count');
  const cachedTokens = usageInteger(value['cachedTokens'], 'pending cached token count');
  const actualCostMicros = usageInteger(value['actualCostMicros'], 'pending cost');
  const priceSnapshot = value['priceSnapshot'];
  if (!isRecord(priceSnapshot)) {
    throw new TranslationRuntimeError('conflict', 'Pending usage price snapshot is invalid');
  }
  const stage = value['stage'];
  if (
    stage !== 'coordinator'
    && stage !== 'translation-subagent'
    && stage !== 'context-maintenance'
  ) {
    throw new TranslationRuntimeError('conflict', 'Pending usage stage is invalid');
  }
  return {
    schemaVersion: 1,
    eventId,
    projectId,
    projectRoot,
    sessionId,
    agentId,
    turnId,
    step,
    modelId,
    providerId,
    inputTokens,
    outputTokens,
    cachedTokens,
    priceSnapshot,
    actualCostMicros,
    stage,
  };
}

interface UsageCostResult {
  readonly actualCostMicros: number;
  readonly priceSnapshot: Record<string, unknown>;
}

export function calculateUsageCost(
  usage: TranslationAgentUsageIncrement['usage'],
  pricing: ModelTokenPricing,
  identity: ModelPricingLookup,
): UsageCostResult {
  const prices = [
    pricing.inputUsdPerMillion,
    pricing.outputUsdPerMillion,
    pricing.cacheReadUsdPerMillion,
    pricing.cacheCreationUsdPerMillion,
  ].filter((price): price is number => price !== undefined);
  if (prices.some((price) => !Number.isFinite(price) || price < 0)) {
    throw new TranslationRuntimeError('invalid', 'Model token prices must be finite and non-negative');
  }
  const cacheReadPrice = pricing.cacheReadUsdPerMillion ?? pricing.inputUsdPerMillion;
  const cacheCreationPrice = pricing.cacheCreationUsdPerMillion ?? pricing.inputUsdPerMillion;
  // tokens × (USD / 1M tokens) × (1M micro-USD / USD) = micro-USD.
  const rawMicros =
    usage.inputOther * pricing.inputUsdPerMillion
    + usage.output * pricing.outputUsdPerMillion
    + usage.inputCacheRead * cacheReadPrice
    + usage.inputCacheCreation * cacheCreationPrice;
  const actualCostMicros = Math.round(rawMicros);
  if (!Number.isSafeInteger(actualCostMicros) || actualCostMicros < 0) {
    throw new TranslationRuntimeError('invalid', 'Calculated model cost is outside the safe integer range');
  }
  return {
    actualCostMicros,
    priceSnapshot: {
      availability: 'configured',
      currency: pricing.currency,
      unit: 'usd_per_million_tokens',
      source: 'user_model_configuration',
      provider_id: identity.providerId,
      model_id: identity.modelId,
      input_usd_per_million: pricing.inputUsdPerMillion,
      output_usd_per_million: pricing.outputUsdPerMillion,
      cache_read_usd_per_million: cacheReadPrice,
      cache_creation_usd_per_million: cacheCreationPrice,
      cache_read_fallback_to_input: pricing.cacheReadUsdPerMillion === undefined,
      cache_creation_fallback_to_input: pricing.cacheCreationUsdPerMillion === undefined,
    },
  };
}

function unavailableUsageCost(
  modelId: string,
  providerId: string,
  reason: string,
): UsageCostResult {
  return {
    actualCostMicros: 0,
    priceSnapshot: {
      availability: 'unavailable',
      reason,
      actual_cost_micros_is_placeholder: true,
      provider_id: providerId,
      model_id: modelId,
    },
  };
}

function formatBudgetUsd(micros: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000);
}

function budgetNotification(
  before: BudgetStatus,
  budget: BudgetStatus,
  reused: boolean,
): TranslationBudgetNotification | undefined {
  if (reused) return undefined;
  if (!before.hardExceeded && budget.hardExceeded) {
    return {
      code: 'translation-hard-budget-reached',
      message: `费用硬上限已达到：项目累计费用为 ${formatBudgetUsd(budget.actualCostMicros)}，硬上限为 ${formatBudgetUsd(budget.hardBudgetMicros!)}。不会启动新的付费工作；已开始的工作会继续运行。`,
    };
  }
  if (!before.softExceeded && budget.softExceeded) {
    return {
      code: 'translation-soft-budget-reached',
      message: `费用提醒：项目累计费用已达到 ${formatBudgetUsd(budget.actualCostMicros)}，提醒线为 ${formatBudgetUsd(budget.softBudgetMicros!)}。已开始的工作会继续运行。`,
    };
  }
  return undefined;
}

function normalizeProjectRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new TranslationRuntimeError('invalid', 'project_root must be an absolute path');
  }
  return resolve(value);
}

function assertPathWithin(root: string, child: string, label: string): void {
  const parent = resolve(root);
  const target = resolve(child);
  const rel = relative(parent, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TranslationRuntimeError('invalid', `${label} escapes project_root`);
  }
}

function samePath(left: string, right: string): boolean {
  return pathKey(resolve(left)) === pathKey(resolve(right));
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function projectNotFound(projectId: string): TranslationRuntimeError {
  return new TranslationRuntimeError('not_found', `Translation project not found: ${projectId}`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyBgeError(error: unknown): NonNullable<BgeRuntimeStatus['errorCode']> {
  const message = safeErrorText(error).toLowerCase();
  if (message.includes('disk space')) return 'disk_space';
  if (message.includes('permission') || message.includes('eacces') || message.includes('eperm')) return 'permission';
  if (message.includes('sha-256') || message.includes('checksum') || message.includes('fingerprint')) return 'checksum';
  if (message.includes('fetch') || message.includes('network') || message.includes('http')) return 'network';
  if (message.includes('model')) return 'invalid_model';
  return 'unknown';
}

function publicBgeError(
  error: unknown,
  code: NonNullable<BgeRuntimeStatus['errorCode']>,
): string {
  if (code === 'network') return 'BGE-M3 source is unreachable. Check the selected mirror or official source.';
  if (code === 'disk_space') return 'There is not enough disk space to install BGE-M3.';
  if (code === 'permission') return 'BGE-M3 files cannot be written in the managed model directory.';
  if (code === 'checksum') return 'BGE-M3 failed integrity verification.';
  if (code === 'service_unavailable') return 'The local authenticated RAG service could not start.';
  if (code === 'invalid_model') return 'The detected BGE-M3 directory is incomplete or invalid.';
  if (code === 'cancelled') return 'BGE-M3 download was cancelled.';
  return safeErrorText(error).slice(0, 240) || 'BGE-M3 setup failed.';
}

function safeErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, 'Bearer [redacted]')
    .replace(/([?&](?:token|api_key|key)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/gu, '[redacted]');
}
