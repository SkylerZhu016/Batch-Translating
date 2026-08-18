import { readFileSync } from 'node:fs';

import { analyzeAffectedScope } from './affected-scope.ts';
import { canonicalJson } from './hash.ts';
import { TranslationProjectLedger } from './project-ledger.ts';
import type {
  AnalyzeAffectedScopeInput,
  ApplyInstructionInput,
  CanonicalEntityInput,
  CompleteAttemptInput,
  CompletionSnapshotOptions,
  CostEventInput,
  CreateProjectInput,
  CreateTaskInput,
  IndexVersionInput,
  MemoryRecordInput,
  MergeConflictInput,
  RegisterParagraphInput,
  RegisterSourceItemInput,
  RepairPatchInput,
  ReviewIssueInput,
  SyntheticUsageEventInput,
  TranslationMemoryInput,
} from './types.ts';

export interface TranslationDomainCliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: TranslationDomainCliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function takeOption(args: string[], option: string): string | undefined {
  const direct = args.findIndex((arg) => arg === option);
  if (direct >= 0) {
    const value = args[direct + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    args.splice(direct, 2);
    return value;
  }
  const prefix = `${option}=`;
  const inline = args.findIndex((arg) => arg.startsWith(prefix));
  if (inline >= 0) {
    const value = args[inline]!.slice(prefix.length);
    args.splice(inline, 1);
    return value;
  }
  return undefined;
}

function readPayload<T>(args: string[]): T {
  const inline = takeOption(args, '--json');
  const inputFile = takeOption(args, '--input-file');
  if (inline !== undefined && inputFile !== undefined) {
    throw new Error('Use either --json or --input-file, not both');
  }
  const raw = inline ?? (inputFile ? readFileSync(inputFile, 'utf8') : '{}');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CLI payload must be a JSON object');
  }
  return parsed as T;
}

function requiredOption(args: string[], option: string): string {
  const value = takeOption(args, option);
  if (!value) throw new Error(`${option} is required`);
  return value;
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`Unexpected arguments: ${args.join(' ')}`);
}

function help(): Record<string, unknown> {
  return {
    usage: 'translation ledger --database <absolute.sqlite3> <group> <command> [options]',
    note: 'When the core already consumed "translation ledger", pass only the remaining args.',
    payload: 'Structured inputs use --json <object> or --input-file <path>. Output is one strict JSON line.',
    commands: [
      'project init|open|status|summary|report-data|integrity|completion',
      'source register-item|register-paragraph',
      'task ensure|list|claim|start|complete|fail|retry|recover',
      'instruction analyze|apply|list',
      'cost record|record-usage',
      'budget status|update',
      'memory record',
      'canonical record',
      'tm record',
      'review issue|resolve',
      'repair patch',
      'conflict create|resolve',
      'index record',
      'merge acquire|renew|release|validate',
    ],
    contracts: {
      'task ensure': {
        required: ['projectId', 'taskType', 'scopeHash', 'scope', 'promptVersion', 'instructionVersion', 'contextHash', 'modelId', 'decodingConfigHash'],
        optional: ['taskId', 'priority', 'dependencyIds', 'costClass=PAID|LOCAL', 'stage', 'maxAttempts'],
      },
      'task claim': {
        required: ['projectId', 'workerId', 'leaseDurationMs'],
        optional: ['taskTypes'],
      },
      'task start': { required: ['taskId', 'attemptId', 'workerId'] },
      'task complete': {
        required: ['projectId', 'taskId', 'attemptId', 'workerId', 'sourceHashes', 'payload', 'provenance'],
        provenanceRequired: ['providerId', 'modelId', 'promptVersion', 'instructionVersion', 'contextHash', 'sourceHashes'],
      },
      'task fail': {
        required: ['taskId', 'attemptId', 'workerId', 'errorCode', 'errorMessage', 'retryable'],
        optional: ['retryReason'],
      },
      'instruction apply': {
        required: ['projectId', 'sessionMessageId', 'message', 'affectedScope'],
        affectedScopeRequired: ['affectedTaskIds', 'affectedChapterIds', 'affectedEntities', 'global', 'reason'],
        optional: ['eventId', 'interruptMode=SOFT|HARD', 'replacementTasks'],
      },
      'cost record-usage': {
        required: ['projectId', 'eventId', 'sessionId', 'agentId', 'turnId', 'step', 'modelId', 'providerId', 'inputTokens', 'outputTokens', 'priceSnapshot', 'actualCostMicros'],
        optional: ['traceId', 'reasoningTokens', 'cachedTokens', 'latencyMs', 'stage', 'retryReason'],
      },
      'memory record': {
        required: ['projectId', 'memoryType', 'summary', 'importance', 'confidence', 'sourceProvenance', 'instructionVersion'],
        optional: ['memoryId', 'chapterId', 'paragraphIds', 'entities'],
      },
      'canonical record': {
        required: ['projectId', 'entityKey', 'entityType', 'canonicalValue', 'sourceProvenance', 'instructionVersion'],
        optional: ['canonicalRecordId', 'aliases'],
      },
      'tm record': {
        required: ['projectId', 'sourceHash', 'targetText', 'approval=APPROVED|FINAL', 'providerId', 'modelId', 'promptVersion', 'instructionVersion', 'provenance'],
        optional: ['tmRecordId', 'paragraphId'],
      },
      'review issue': {
        required: ['projectId', 'category', 'severity=LOW|MEDIUM|HIGH|CRITICAL', 'explanation', 'suggestedAction', 'instructionVersion'],
        optional: ['issueId', 'taskId', 'chapterId', 'paragraphIds', 'sourceEvidenceIds', 'targetEvidenceIds', 'storyMemoryIds'],
      },
      'repair patch': {
        required: ['projectId', 'issueId', 'paragraphId', 'oldTranslationHash', 'newTranslation', 'reason', 'instructionVersion', 'provenance'],
        optional: ['patchId', 'taskId'],
      },
      'conflict create': {
        required: ['conflict', 'mergerLease'],
        conflictRequired: ['projectId', 'paragraphId', 'patchIds', 'baseTranslationHash', 'instructionVersion'],
      },
      'index record': {
        required: ['projectId', 'indexKind', 'schemaFingerprint', 'modelFingerprint', 'state=STAGING|CURRENT|DEGRADED|STALE|FAILED'],
        optional: ['indexVersionId', 'pointCount', 'metadata'],
      },
      'merge acquire': { required: ['projectId', 'owner', 'leaseDurationMs'] },
      'merge renew': { required: ['lease', 'leaseDurationMs'] },
      'merge release': { payload: 'MergerLeaseToken itself: projectId, owner, generation, expiresAt' },
      'merge validate': { required: ['artifactId', 'projectId', 'expectedInstructionVersion'], optional: ['expectedPromptVersion', 'expectedContextHash', 'expectedSourceHashes', 'expectedParagraphIds', 'expectedOldTranslationHashes'] },
    },
  };
}

/**
 * Embeddable CLI entry. It never calls process.exit and always closes the SQLite handle.
 * It accepts args after `translation ledger`; a leading `ledger` is tolerated for direct use.
 */
export async function runTranslationDomainCli(
  inputArgs: readonly string[],
  io: TranslationDomainCliIO = defaultIo,
): Promise<number> {
  const args = [...inputArgs];
  if (args[0] === 'ledger') args.shift();
  if (args.includes('--help') || args[0] === 'help' || args.length === 0) {
    io.stdout(`${canonicalJson({ ok: true, data: help() })}\n`);
    return 0;
  }

  let ledger: TranslationProjectLedger | undefined;
  try {
    const databasePath = requiredOption(args, '--database');
    const group = args.shift();
    const command = args.shift();
    if (!group || !command) throw new Error('A command group and command are required');
    ledger = new TranslationProjectLedger({ databasePath });
    let data: unknown;

    if (group === 'project' && command === 'init') {
      const payload = readPayload<CreateProjectInput>(args);
      assertNoArgs(args);
      data = ledger.createProject(payload);
    } else if (group === 'project' && (command === 'open' || command === 'status')) {
      const projectId = requiredOption(args, '--project');
      assertNoArgs(args);
      data = ledger.requireProject(projectId);
    } else if (group === 'project' && command === 'summary') {
      const projectId = requiredOption(args, '--project');
      assertNoArgs(args);
      data = ledger.ledgerSummary(projectId);
    } else if (group === 'project' && command === 'report-data') {
      const projectId = requiredOption(args, '--project');
      assertNoArgs(args);
      data = ledger.getDeterministicReportData(projectId);
    } else if (group === 'project' && command === 'integrity') {
      const projectId = requiredOption(args, '--project');
      const skipFiles = args.includes('--skip-files');
      if (skipFiles) args.splice(args.indexOf('--skip-files'), 1);
      assertNoArgs(args);
      data = ledger.integrityCheck(projectId, !skipFiles);
    } else if (group === 'project' && command === 'completion') {
      const projectId = requiredOption(args, '--project');
      const options = readPayload<CompletionSnapshotOptions>(args);
      assertNoArgs(args);
      data = ledger.createCompletionSnapshot(projectId, options);
    } else if (group === 'source' && command === 'register-item') {
      const payload = readPayload<RegisterSourceItemInput>(args);
      assertNoArgs(args);
      data = ledger.registerSourceItem(payload);
    } else if (group === 'source' && command === 'register-paragraph') {
      const payload = readPayload<RegisterParagraphInput>(args);
      assertNoArgs(args);
      data = ledger.registerParagraph(payload);
    } else if (group === 'task' && command === 'ensure') {
      const payload = readPayload<CreateTaskInput>(args);
      assertNoArgs(args);
      data = ledger.ensureTask(payload);
    } else if (group === 'task' && command === 'list') {
      const projectId = requiredOption(args, '--project');
      const payload = readPayload<{ states?: Parameters<TranslationProjectLedger['listTasks']>[1] }>(args);
      assertNoArgs(args);
      data = ledger.listTasks(projectId, payload.states);
    } else if (group === 'task' && command === 'claim') {
      const payload = readPayload<Parameters<TranslationProjectLedger['claimNextTask']>[0]>(args);
      assertNoArgs(args);
      data = ledger.claimNextTask(payload) ?? null;
    } else if (group === 'task' && command === 'start') {
      const payload = readPayload<{ taskId: string; attemptId: string; workerId: string }>(args);
      assertNoArgs(args);
      data = ledger.markAttemptRunning(payload.taskId, payload.attemptId, payload.workerId);
    } else if (group === 'task' && command === 'complete') {
      const payload = readPayload<CompleteAttemptInput>(args);
      assertNoArgs(args);
      data = ledger.completeAttempt(payload);
    } else if (group === 'task' && command === 'fail') {
      const payload = readPayload<Parameters<TranslationProjectLedger['failAttempt']>[0]>(args);
      assertNoArgs(args);
      data = ledger.failAttempt(payload);
    } else if (group === 'task' && command === 'retry') {
      const taskId = requiredOption(args, '--task');
      assertNoArgs(args);
      data = ledger.retryTask(taskId, 'cli');
    } else if (group === 'task' && command === 'recover') {
      const projectId = requiredOption(args, '--project');
      assertNoArgs(args);
      data = ledger.recoverExpiredLeases(projectId);
    } else if (group === 'instruction' && command === 'analyze') {
      const payload = readPayload<AnalyzeAffectedScopeInput>(args);
      assertNoArgs(args);
      data = analyzeAffectedScope(payload);
    } else if (group === 'instruction' && command === 'apply') {
      const payload = readPayload<ApplyInstructionInput>(args);
      assertNoArgs(args);
      data = ledger.applyInstruction(payload);
    } else if (group === 'instruction' && command === 'list') {
      const projectId = requiredOption(args, '--project');
      assertNoArgs(args);
      data = ledger.listInstructionEvents(projectId);
    } else if (group === 'cost' && command === 'record') {
      const payload = readPayload<CostEventInput>(args);
      assertNoArgs(args);
      data = { costEventId: ledger.recordCostEvent(payload), budget: ledger.getBudgetStatus(payload.projectId) };
    } else if (group === 'cost' && command === 'record-usage') {
      const payload = readPayload<SyntheticUsageEventInput>(args);
      assertNoArgs(args);
      data = ledger.recordSyntheticUsageEvent(payload);
    } else if (group === 'budget' && command === 'status') {
      const projectId = requiredOption(args, '--project');
      assertNoArgs(args);
      data = ledger.getBudgetStatus(projectId);
    } else if (group === 'budget' && command === 'update') {
      const projectId = requiredOption(args, '--project');
      const payload = readPayload<Parameters<TranslationProjectLedger['updateBudgets']>[1]>(args);
      assertNoArgs(args);
      data = ledger.updateBudgets(projectId, payload, 'cli');
    } else if (group === 'memory' && command === 'record') {
      const payload = readPayload<MemoryRecordInput>(args);
      assertNoArgs(args);
      data = { memoryId: ledger.recordMemory(payload) };
    } else if (group === 'canonical' && command === 'record') {
      const payload = readPayload<CanonicalEntityInput>(args);
      assertNoArgs(args);
      data = { canonicalRecordId: ledger.recordCanonicalEntity(payload) };
    } else if (group === 'tm' && command === 'record') {
      const payload = readPayload<TranslationMemoryInput>(args);
      assertNoArgs(args);
      data = { tmRecordId: ledger.recordTranslationMemory(payload) };
    } else if (group === 'review' && command === 'issue') {
      const payload = readPayload<ReviewIssueInput>(args);
      assertNoArgs(args);
      data = { issueId: ledger.recordReviewIssue(payload) };
    } else if (group === 'review' && command === 'resolve') {
      const payload = readPayload<{
        projectId: string;
        issueId: string;
        resolutionEventId: string;
        status: 'RESOLVED' | 'ACCEPTED';
      }>(args);
      assertNoArgs(args);
      ledger.resolveReviewIssue(
        payload.projectId,
        payload.issueId,
        payload.resolutionEventId,
        payload.status,
        'cli',
      );
      data = { issueId: payload.issueId, status: payload.status };
    } else if (group === 'repair' && command === 'patch') {
      const payload = readPayload<RepairPatchInput>(args);
      assertNoArgs(args);
      data = { patchId: ledger.recordRepairPatch(payload) };
    } else if (group === 'conflict' && command === 'create') {
      const payload = readPayload<{
        conflict: MergeConflictInput;
        mergerLease: Parameters<TranslationProjectLedger['createMergeConflict']>[1];
      }>(args);
      assertNoArgs(args);
      data = { conflictId: ledger.createMergeConflict(payload.conflict, payload.mergerLease) };
    } else if (group === 'conflict' && command === 'resolve') {
      const payload = readPayload<Parameters<TranslationProjectLedger['resolveMergeConflict']>[0]>(args);
      assertNoArgs(args);
      ledger.resolveMergeConflict(payload);
      data = { conflictId: payload.conflictId, state: 'RESOLVED' };
    } else if (group === 'index' && command === 'record') {
      const payload = readPayload<IndexVersionInput>(args);
      assertNoArgs(args);
      data = { indexVersionId: ledger.recordIndexVersion(payload) };
    } else if (group === 'merge' && command === 'acquire') {
      const payload = readPayload<{ projectId: string; owner: string; leaseDurationMs: number }>(args);
      assertNoArgs(args);
      data = { lease: ledger.acquireMergerLease(payload.projectId, payload.owner, payload.leaseDurationMs) ?? null };
    } else if (group === 'merge' && command === 'renew') {
      const payload = readPayload<{
        lease: Parameters<TranslationProjectLedger['renewMergerLease']>[0];
        leaseDurationMs: number;
      }>(args);
      assertNoArgs(args);
      data = { lease: ledger.renewMergerLease(payload.lease, payload.leaseDurationMs) };
    } else if (group === 'merge' && command === 'release') {
      const payload = readPayload<Parameters<TranslationProjectLedger['releaseMergerLease']>[0]>(args);
      assertNoArgs(args);
      ledger.releaseMergerLease(payload);
      data = { released: true };
    } else if (group === 'merge' && command === 'validate') {
      const payload = readPayload<Parameters<TranslationProjectLedger['validateArtifactForMerge']>[0]>(args);
      assertNoArgs(args);
      data = ledger.validateArtifactForMerge(payload);
    } else {
      throw new Error(`Unknown translation ledger command: ${group} ${command}`);
    }

    io.stdout(`${canonicalJson({ ok: true, data })}\n`);
    return 0;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    io.stderr(
      `${canonicalJson({
        ok: false,
        error: { name: normalized.name, message: normalized.message },
      })}\n`,
    );
    return 1;
  } finally {
    ledger?.close();
  }
}
