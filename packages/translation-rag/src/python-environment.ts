import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { probeRagPython, resolveRagServiceDirectory } from './service.ts';

export type RagPythonPackageIndex = 'official' | 'mirror';
export type RagPythonPreparationPhase =
  | 'checking'
  | 'creating_venv'
  | 'bootstrapping_pip'
  | 'installing'
  | 'verifying'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface RagPythonPreparationProgress {
  readonly phase: RagPythonPreparationPhase;
  readonly message: string;
  readonly attempt?: number;
}

export interface PrepareRagPythonEnvironmentOptions {
  /** Product-owned home; the isolated environment is created below this directory. */
  readonly homeDirectory: string;
  /** System/bootstrap Python 3.11+. No global packages are modified. */
  readonly pythonExecutable?: string;
  readonly packageIndex?: RagPythonPackageIndex;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RagPythonPreparationProgress) => void;
  /** Total installation attempts. Defaults to two (one retry). */
  readonly maxAttempts?: number;
}

export interface PreparedRagPythonEnvironment {
  readonly pythonExecutable: string;
  readonly pythonVersion: string;
  readonly environmentDirectory: string;
  readonly serviceDirectory: string;
  readonly packageIndex: RagPythonPackageIndex;
  readonly packageIndexUrl: string;
  readonly dependenciesAvailable: true;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

const INDEX_URLS: Readonly<Record<RagPythonPackageIndex, string>> = {
  official: 'https://pypi.org/simple',
  mirror: 'https://pypi.tuna.tsinghua.edu.cn/simple',
};
const activePreparations = new Set<string>();

/**
 * Explicitly creates/repairs an application-owned Python environment and
 * installs the packaged sidecar. Importing this module never invokes Python,
 * creates files, or contacts a package index.
 */
export async function prepareRagPythonEnvironment(
  options: PrepareRagPythonEnvironmentOptions,
): Promise<PreparedRagPythonEnvironment> {
  if (!options.homeDirectory.trim()) throw new Error('homeDirectory is required');
  options.signal?.throwIfAborted();
  const home = resolve(options.homeDirectory);
  const environmentDirectory = join(home, 'translation-rag-python');
  const key = process.platform === 'win32'
    ? environmentDirectory.toLowerCase()
    : environmentDirectory;
  if (activePreparations.has(key)) {
    throw new Error('This RAG Python environment is already being prepared');
  }
  activePreparations.add(key);

  const emit = (
    phase: RagPythonPreparationPhase,
    message: string,
    attempt?: number,
  ): void => {
    try {
      options.onProgress?.({ phase, message, ...(attempt === undefined ? {} : { attempt }) });
    } catch {
      // UI observers cannot interrupt or corrupt environment preparation.
    }
  };

  try {
    const bootstrapPython = options.pythonExecutable
      ?? process.env['BATCH_TRANSLATING_RAG_PYTHON_BOOTSTRAP']
      ?? process.env['BATCH_TRANSLATING_PYTHON']
      ?? 'python';
    const packageIndex = options.packageIndex ?? 'official';
    if (packageIndex !== 'official' && packageIndex !== 'mirror') {
      throw new Error('packageIndex must be official or mirror');
    }
    const packageIndexUrl = INDEX_URLS[packageIndex];
    const serviceDirectory = await resolveRagServiceDirectory();
    const pythonExecutable = venvPythonPath(environmentDirectory);

    emit('checking', 'Checking the bootstrap Python runtime');
    const versionResult = await runCommand(bootstrapPython, ['--version'], options.signal);
    const bootstrapVersion = parsePythonVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    assertSupportedPython(bootstrapVersion);
    const bootstrapTorchVersion = await probeTorchVersion(bootstrapPython, options.signal);

    if (!(await pathExists(pythonExecutable))) {
      emit('creating_venv', 'Creating an isolated Python environment');
      await mkdir(home, { recursive: true });
      // Torch is several gigabytes. Let the product venv reuse a compatible
      // host installation instead of silently installing a second copy.
      await runCommand(
        bootstrapPython,
        [
          '-m',
          'venv',
          ...(bootstrapTorchVersion ? ['--system-site-packages'] : []),
          environmentDirectory,
        ],
        options.signal,
        (line) => emit('creating_venv', line),
      );
    } else if (bootstrapTorchVersion && !(await probeTorchVersion(pythonExecutable, options.signal))) {
      emit('creating_venv', 'Reusing the existing system Torch installation');
      await runCommand(
        bootstrapPython,
        ['-m', 'venv', '--upgrade', '--system-site-packages', environmentDirectory],
        options.signal,
        (line) => emit('creating_venv', line),
      );
    }

    emit('bootstrapping_pip', 'Preparing pip inside the isolated environment');
    await runCommand(
      pythonExecutable,
      ['-m', 'ensurepip', '--upgrade'],
      options.signal,
      (line) => emit('bootstrapping_pip', line),
    );

    const maxAttempts = options.maxAttempts ?? 2;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new RangeError('maxAttempts must be an integer from 1 to 5');
    }
    let installError: unknown;
    const torchConstraint = bootstrapTorchVersion
      ? join(environmentDirectory, 'batch-translating-constraints.txt')
      : undefined;
    if (torchConstraint) {
      // The resolver may use the visible host Torch, but it may not replace it
      // with a different copy inside the product environment.
      await writeFile(torchConstraint, `torch==${bootstrapTorchVersion}\n`, 'utf8');
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      options.signal?.throwIfAborted();
      emit('installing', `Installing the packaged RAG service (${attempt}/${maxAttempts})`, attempt);
      try {
        await runCommand(
          pythonExecutable,
          [
            '-m',
            'pip',
            'install',
            '--disable-pip-version-check',
            '--no-input',
            '--upgrade-strategy',
            'only-if-needed',
            ...(torchConstraint ? ['--constraint', torchConstraint] : []),
            '--index-url',
            packageIndexUrl,
            serviceDirectory,
          ],
          options.signal,
          (line) => emit('installing', line, attempt),
        );
        installError = undefined;
        break;
      } catch (error) {
        installError = error;
        if (options.signal?.aborted || attempt === maxAttempts) throw error;
        emit('installing', 'Installation failed; retrying without deleting the environment', attempt);
      }
    }
    if (installError) throw installError;

    emit('verifying', 'Verifying BGE-M3 and Qdrant runtime dependencies');
    const probe = await probeRagPython({ pythonExecutable });
    if (!probe.available || !probe.pythonVersion) {
      const missing = probe.missingPackages.length > 0
        ? ` Missing: ${probe.missingPackages.join(', ')}.`
        : '';
      throw new Error(`${probe.error ?? 'RAG Python dependency verification failed.'}${missing}`);
    }
    emit('completed', 'The isolated RAG Python environment is ready');
    return {
      pythonExecutable,
      pythonVersion: probe.pythonVersion,
      environmentDirectory,
      serviceDirectory,
      packageIndex,
      packageIndexUrl,
      dependenciesAvailable: true,
    };
  } catch (error) {
    emit(options.signal?.aborted ? 'cancelled' : 'failed', errorMessage(error));
    throw error;
  } finally {
    activePreparations.delete(key);
  }
}

async function probeTorchVersion(executable: string, signal?: AbortSignal): Promise<string | undefined> {
  const script = [
    'import importlib.util,json',
    "spec=importlib.util.find_spec('torch')",
    "print(json.dumps({'version':None} if spec is None else {'version':__import__('torch').__version__.split('+',1)[0]}))",
  ].join(';');
  try {
    const result = await runCommand(executable, ['-c', script], signal);
    const parsed = JSON.parse(result.stdout) as { version?: unknown };
    const version = parsed.version;
    return typeof version === 'string' && /^\d+(?:\.\d+)+(?:[a-z0-9.!-]+)?$/iu.test(version)
      ? version
      : undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

function venvPythonPath(environmentDirectory: string): string {
  return process.platform === 'win32'
    ? join(environmentDirectory, 'Scripts', 'python.exe')
    : join(environmentDirectory, 'bin', 'python');
}

async function runCommand(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
  onLine?: (line: string) => void,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pendingStdout = '';
    let pendingStderr = '';
    let settled = false;

    const emitChunks = (stream: 'stdout' | 'stderr', text: string): void => {
      const combined = (stream === 'stdout' ? pendingStdout : pendingStderr) + text;
      const parts = combined.split(/\r?\n/);
      const pending = parts.pop() ?? '';
      if (stream === 'stdout') pendingStdout = pending;
      else pendingStderr = pending;
      for (const line of parts) {
        const safe = line.trim().slice(0, 2_000);
        if (safe) onLine?.(safe);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout = `${stdout}${text}`.slice(-64_000);
      emitChunks('stdout', text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = `${stderr}${text}`.slice(-64_000);
      emitChunks('stderr', text);
    });

    const abort = (): void => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      const finalStdout = pendingStdout.trim();
      const finalStderr = pendingStderr.trim();
      if (finalStdout) onLine?.(finalStdout.slice(0, 2_000));
      if (finalStderr) onLine?.(finalStderr.slice(0, 2_000));
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Python environment preparation was cancelled'));
      } else if (code === 0) {
        resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(
          `Python command failed (${code ?? exitSignal ?? 'unknown'}): ${stderr.trim().slice(-4_000)}`,
        ));
      }
    });
  });
}

function parsePythonVersion(output: string): string {
  const match = /Python\s+(\d+\.\d+\.\d+)/i.exec(output);
  if (!match?.[1]) throw new Error(`Unable to read Python version from: ${output}`);
  return match[1];
}

function assertSupportedPython(version: string): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major < 3 || (major === 3 && minor < 11)) {
    throw new Error(`Translation RAG requires Python 3.11 or newer; found ${version}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
