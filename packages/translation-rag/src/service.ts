import { randomBytes, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const READY_PREFIX = 'BATCH_TRANSLATION_RAG_READY ';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface RagServiceCapabilities {
  dense: boolean;
  sparse: boolean;
  hybrid: boolean;
  rerank: boolean;
  active_mode?: 'dense' | 'hybrid';
  /** Optional diagnostic aliases used by future service versions. */
  colbert?: boolean;
  qdrant?: boolean;
  cpuFallback?: boolean;
  degradedReasons?: string[];
}

export interface RagServiceReadyInfo {
  url: string;
  instanceId: string;
  pid: number;
  capabilities?: RagServiceCapabilities;
}

export interface StartRagServiceOptions {
  /** Python 3.10+ executable. Defaults to the configured runtime, then `python`. */
  pythonExecutable?: string;
  /** Persistent root for Qdrant data, snapshots and service state. */
  dataRoot: string;
  /** Explicit BGE-M3 snapshot. Discovery is used when omitted. */
  modelPath?: string;
  /** Optional remote Qdrant. Local persistent Qdrant is used when omitted. */
  qdrantUrl?: string;
  qdrantApiKey?: string;
  host?: '127.0.0.1' | '::1' | 'localhost';
  /** Zero asks the OS for an available port. */
  port?: number;
  token?: string;
  startupTimeoutMs?: number;
  embeddingBatchSize?: number;
  preferDevice?: 'auto' | 'cpu' | 'cuda' | 'mps';
  extraEnv?: Readonly<Record<string, string | undefined>>;
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface RagServiceHandle extends RagServiceReadyInfo {
  readonly token: string;
  readonly process: ChildProcessWithoutNullStreams;
  stop(timeoutMs?: number): Promise<void>;
}

export interface RagPythonProbe {
  available: boolean;
  pythonExecutable: string;
  pythonVersion?: string;
  missingPackages: string[];
  error?: string;
}

async function isServiceDirectory(candidate: string): Promise<boolean> {
  try {
    await access(join(candidate, 'src', 'translation_rag_service', 'server.py'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the packaged Python sidecar without assuming the TypeScript module's
 * final bundle layout. Desktop packaging should set the explicit environment
 * variable or copy the service beside the executable in one of these resource
 * locations.
 */
export async function resolveRagServiceDirectory(): Promise<string> {
  const configured = process.env['BATCH_TRANSLATING_RAG_SERVICE_DIR'];
  if (configured) {
    const explicit = resolve(configured);
    if (!(await isServiceDirectory(explicit))) {
      throw new Error(
        `BATCH_TRANSLATING_RAG_SERVICE_DIR is not a translation RAG service directory: ${explicit}`,
      );
    }
    return explicit;
  }

  const executableDirectory = dirname(process.execPath);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(executableDirectory, 'translation-rag-service'),
    join(executableDirectory, 'resources', 'translation-rag-service'),
    join(executableDirectory, 'resources', 'translation-rag', 'service'),
    resolve(moduleDirectory, '..', 'service'),
    resolve(moduleDirectory, '..', '..', 'service'),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = resolve(candidate);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await isServiceDirectory(normalized)) return normalized;
  }
  throw new Error(
    'Translation RAG Python service was not found. Set BATCH_TRANSLATING_RAG_SERVICE_DIR or install the packaged sidecar resources.',
  );
}

function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`RAG service may only listen on loopback; received ${host}`);
  }
}

function pythonExecutableFrom(options?: Pick<StartRagServiceOptions, 'pythonExecutable'>): string {
  return (
    options?.pythonExecutable ??
    process.env['BATCH_TRANSLATING_RAG_PYTHON'] ??
    process.env['BATCH_TRANSLATING_PYTHON'] ??
    'python'
  );
}

function appendPythonPath(current: string | undefined, entry: string): string {
  if (!current) return entry;
  const entries = current.split(delimiter);
  return entries.includes(entry) ? current : `${entry}${delimiter}${current}`;
}

function safeInteger(value: number, name: string, min: number, max: number): string {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return String(value);
}

function parseReadyLine(line: string): RagServiceReadyInfo | undefined {
  if (!line.startsWith(READY_PREFIX)) return undefined;
  const raw = JSON.parse(line.slice(READY_PREFIX.length)) as Record<string, unknown>;
  const url = raw['url'];
  const instanceId = raw['instance_id'];
  const pid = raw['pid'];
  if (typeof url !== 'string' || typeof instanceId !== 'string' || typeof pid !== 'number') {
    throw new Error('RAG service emitted an invalid readiness record');
  }
  const parsed = new URL(url);
  assertLoopback(parsed.hostname.replace(/^\[|\]$/g, ''));
  const capabilities = raw['capabilities'];
  return {
    url: parsed.origin,
    instanceId,
    pid,
    ...(capabilities && typeof capabilities === 'object'
      ? { capabilities: capabilities as unknown as RagServiceCapabilities }
      : {}),
  };
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolvePromise(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once('exit', onExit);
  });
}

/**
 * Starts the real Python service. This never downloads a model: callers must
 * explicitly run the model download manager before starting when no local
 * snapshot is available.
 */
export async function startRagService(options: StartRagServiceOptions): Promise<RagServiceHandle> {
  const host = options.host ?? '127.0.0.1';
  assertLoopback(host);
  if (!options.dataRoot.trim()) throw new Error('dataRoot is required');

  const serviceRoot = await resolveRagServiceDirectory();
  const sourceRoot = join(serviceRoot, 'src');
  await access(sourceRoot);

  const token = options.token ?? randomBytes(32).toString('base64url');
  if (token.length < 32) throw new Error('RAG bearer token must be at least 32 characters');
  const instanceId = randomUUID();
  const port = options.port ?? 0;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.extraEnv,
    PYTHONPATH: appendPythonPath(process.env['PYTHONPATH'], sourceRoot),
    BATCH_TRANSLATING_RAG_DATA_ROOT: resolve(options.dataRoot),
    BATCH_TRANSLATING_RAG_HOST: host,
    BATCH_TRANSLATING_RAG_PORT: safeInteger(port, 'port', 0, 65_535),
    BATCH_TRANSLATING_RAG_TOKEN: token,
    BATCH_TRANSLATING_RAG_INSTANCE_ID: instanceId,
    BATCH_TRANSLATING_RAG_EMBEDDING_BATCH_SIZE: safeInteger(
      options.embeddingBatchSize ?? 8,
      'embeddingBatchSize',
      1,
      512,
    ),
    BATCH_TRANSLATING_RAG_DEVICE: options.preferDevice ?? 'auto',
    ...(options.modelPath ? { BATCH_TRANSLATING_BGE_M3_PATH: resolve(options.modelPath) } : {}),
    ...(options.qdrantUrl ? { BATCH_TRANSLATING_QDRANT_URL: options.qdrantUrl } : {}),
    ...(options.qdrantApiKey ? { BATCH_TRANSLATING_QDRANT_API_KEY: options.qdrantApiKey } : {}),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  const child = spawn(pythonExecutableFrom(options), ['-m', 'translation_rag_service.server'], {
    cwd: serviceRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  const timeoutMs = options.startupTimeoutMs ?? 120_000;
  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  let stderrTail = '';

  const ready = await new Promise<RagServiceReadyInfo>((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`RAG service did not become ready within ${timeoutMs} ms`));
    }, timeoutMs);

    const finish = (error?: Error, info?: RagServiceReadyInfo): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else if (info) resolvePromise(info);
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const suffix = stderrTail ? `: ${stderrTail}` : '';
      finish(new Error(`RAG service exited before readiness (${code ?? signal ?? 'unknown'})${suffix}`));
    };

    child.once('error', onError);
    child.once('exit', onExit);
    stdout.on('line', (line) => {
      try {
        const info = parseReadyLine(line);
        if (info) finish(undefined, info);
        else options.onLog?.('stdout', line);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    stderr.on('line', (line) => {
      stderrTail = `${stderrTail}\n${line}`.trim().slice(-4_096);
      options.onLog?.('stderr', line);
    });
  }).catch(async (error: unknown) => {
    child.kill();
    await waitForExit(child, 2_000);
    throw error;
  });

  if (ready.instanceId !== instanceId) {
    child.kill();
    throw new Error('RAG service instance identity mismatch');
  }

  return {
    ...ready,
    token,
    process: child,
    async stop(stopTimeoutMs = 10_000): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      if (!(await waitForExit(child, stopTimeoutMs))) child.kill('SIGKILL');
    },
  };
}

/** Checks the optional Python runtime without installing or changing anything. */
export async function probeRagPython(
  options?: Pick<StartRagServiceOptions, 'pythonExecutable'>,
): Promise<RagPythonProbe> {
  const executable = pythonExecutableFrom(options);
  const script = [
    'import importlib.util,json,platform',
    "mods=['fastapi','uvicorn','qdrant_client','FlagEmbedding','huggingface_hub']",
    "missing=[m for m in mods if importlib.util.find_spec(m) is None]",
    "print(json.dumps({'pythonVersion':platform.python_version(),'missingPackages':missing}))",
  ].join(';');
  return await new Promise<RagPythonProbe>((resolvePromise) => {
    const child = spawn(executable, ['-c', script], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', (error) => {
      resolvePromise({
        available: false,
        pythonExecutable: executable,
        missingPackages: [],
        error: error.message,
      });
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        resolvePromise({
          available: false,
          pythonExecutable: executable,
          missingPackages: [],
          error: stderr.trim() || `Python exited with code ${code}`,
        });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim()) as {
          pythonVersion: string;
          missingPackages: string[];
        };
        resolvePromise({
          available: result.missingPackages.length === 0,
          pythonExecutable: executable,
          pythonVersion: result.pythonVersion,
          missingPackages: result.missingPackages,
        });
      } catch (error) {
        resolvePromise({
          available: false,
          pythonExecutable: executable,
          missingPackages: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
}
