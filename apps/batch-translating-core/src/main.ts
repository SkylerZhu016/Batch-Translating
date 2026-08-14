/**
 * Batch Translating CLI entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, then delegates to
 * the requested runner: `kimi -p` runs one prompt headless, bare `kimi` prints
 * an orientation hint (no interactive terminal UI), and the subcommands
 * (`web`, `login`, `translation`) own their own flows.
 */

import {
  flushDiagnosticLogs,
  installGlobalProxyDispatcher,
  log,
  resolveGlobalLogPath,
  resolveKimiHome,
} from '@moonshot-ai/kimi-code-sdk';
import { installCrashHandlers } from '@moonshot-ai/kimi-telemetry';

import { createProgram } from './cli/commands';
import { finalizeHeadlessRun } from './cli/headless-exit';
import { startupTrace } from './utils/startup-trace';
import type { CLIOptions } from './cli/options';
import { OptionConflictError, validateOptions } from './cli/options';
import { runPrompt } from './cli/run-prompt';
import { formatStartupError } from './cli/startup-error';
import { getVersion } from './cli/version';
import { PROCESS_NAME } from './constant/app';
import { cleanupStaleNativeCacheForCurrent } from './native/native-assets';
import { installMinidbTextBuildWorker } from './native/minidb-worker';
import { runNativeAssetSmokeIfRequested } from './native/smoke';

/**
 * Outcome of a CLI command run, reported back to the process entrypoint.
 *
 * `handleMainCommand` is a reusable, unit-tested handler — it must not terminate
 * the process itself. It reports here whether a headless (`kimi -p`) run
 * completed so the entrypoint (the only place that owns the process) can arm the
 * force-exit fallback.
 */
export interface MainCommandOutcome {
  readonly headlessCompleted: boolean;
}

export async function handleMainCommand(
  opts: CLIOptions,
  version: string,
): Promise<MainCommandOutcome> {
  let validated: ReturnType<typeof validateOptions>;
  startupTrace('main:enter');
  try {
    validated = validateOptions(opts);
  } catch (error) {
    if (error instanceof OptionConflictError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  if (validated.uiMode === 'print') {
    await runPrompt(validated.options, version);
    return { headlessCompleted: true };
  }

  // Batch Translating ships no interactive terminal UI: a bare `kimi` run
  // prints a short orientation hint instead of starting a chat shell.
  process.stdout.write(
    `${PROCESS_NAME} — 批量翻译工作台（Batch Translating）\n` +
      `用法：\n` +
      `  kimi web          启动本地工作台（桌面版会自动完成）\n` +
      `  kimi translation  EPUB/TXT 批量翻译管线（见 kimi translation --help）\n`,
  );
  return { headlessCompleted: false };
}

export function main(): void {
  process.title = PROCESS_NAME;
  installCrashHandlers();
  // Route all outbound fetch through HTTP_PROXY/HTTPS_PROXY (honoring NO_PROXY)
  // before any client is constructed. No-op when no proxy variable is set; an
  // invalid proxy URL is reported and ignored rather than aborting startup.
  installGlobalProxyDispatcher();
  // Best-effort SEA worker installation. Diagnostics are trace-only and avoid
  // exposing the user's cache path; failure keeps MiniDb's bounded inline mode.
  const workerInstall = installMinidbTextBuildWorker();
  startupTrace(
    workerInstall.status === 'installed'
      ? `minidb-worker:installed basename=${workerInstall.basename} sha256=${workerInstall.assetSha256}`
      : workerInstall.status === 'failed'
        ? `minidb-worker:failed code=${workerInstall.errorCode} sha256=${workerInstall.assetSha256 ?? 'unknown'}`
        : `minidb-worker:${workerInstall.status}`,
  );
  if (runNativeAssetSmokeIfRequested()) return;

  // Start the background cleanup of stale native cache. Fire-and-forget; must not block startup or throw.
  queueMicrotask(() => {
    try {
      cleanupStaleNativeCacheForCurrent();
    } catch {
      // ignore: cache GC must never affect process startup
    }
  });

  const version = getVersion();

  const program = createProgram(version, (opts) => {
    void handleMainCommand(opts, version)
      .then(async (outcome) => {
        // Only the process entrypoint disposes of the process. Print mode
        // relies on the event loop draining to exit; flush any buffered output
        // and then arm an unref'd fallback so a stray ref'd handle left over
        // from the run can't wedge a completed `kimi -p` until an external
        // timeout. A healthy run drains and exits before the fallback fires.
        if (outcome.headlessCompleted) {
          await finalizeHeadlessRun(
            process,
            [process.stdout, process.stderr],
            () => Number(process.exitCode) || 0,
          );
        }
      })
      .catch(async (error: unknown) => {
        // Set the failure exit code synchronously, before any `await`. The
        // terminal `process.exit(1)` below is our intended exit, but it sits
        // behind `await logStartupFailure(...)`; by the time we reach that
        // await, the failed run's `finally` cleanup has already torn down its
        // ref'd handles (sockets, timers, background tasks). If the event loop
        // drains during the await, Node exits on its own with the DEFAULT code
        // 0 and `process.exit(1)` never runs — headless (`kimi -p`) failures
        // would then exit 0 nondeterministically. Setting `process.exitCode`
        // up front makes that drain-exit report failure too.
        process.exitCode = 1;
        const operation = opts.prompt !== undefined ? 'run prompt' : 'start shell';
        await logStartupFailure(operation, error);
        process.stderr.write(
          formatStartupError(error, {
            operation,
          }),
        );
        process.stderr.write(`See log: ${resolveGlobalLogPath(resolveKimiHome())}\n`);
        process.exit(1);
      });
  });

  program.parse(process.argv);
}

main();

async function logStartupFailure(operation: string, error: unknown): Promise<void> {
  log.error('startup failed', { operation, error });
  try {
    await flushDiagnosticLogs();
  } catch {
    // Best-effort diagnostic flush only.
  }
}
