import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = join(repoRoot, 'apps', 'batch-translating-core');
const desktopRoot = join(repoRoot, 'apps', 'batch-translating-desktop');
const tauriRoot = join(desktopRoot, 'src-tauri');
const nativeEngine = join(
  coreRoot,
  'dist-native',
  'bin',
  'win32-x64',
  'batch-translating-engine.exe',
);
const stagedEngine = join(
  tauriRoot,
  'binaries',
  'batch-translating-engine-x86_64-pc-windows-msvc.exe',
);
const desktopExecutable = join(tauriRoot, 'target', 'release', 'batch-translating-desktop.exe');
const stagedRag = join(tauriRoot, 'resources', 'translation-rag-service');
const nsisRoot = join(tauriRoot, 'target', 'release', 'bundle', 'nsis');
const distRoot = join(repoRoot, 'dist-desktop');

if (process.platform !== 'win32') {
  throw new Error('The Batch Translating desktop release can only be built on Windows.');
}

runFile(process.execPath, ['scripts/ci/stage-rag-service.mjs'], repoRoot);
runShell('corepack pnpm batch:build', repoRoot);
runShell('corepack pnpm run build:native:release', coreRoot, {
  KIMI_CODE_EXECUTABLE_NAME: 'batch-translating-engine.exe',
});

await mkdir(dirname(stagedEngine), { recursive: true });
await copyFile(nativeEngine, stagedEngine);

const remapPaths = [process.env.USERPROFILE, repoRoot]
  .filter((value) => typeof value === 'string' && value.length > 0)
  .map((value) => `--remap-path-prefix=${value}=.`)
  .join('\u001f');
runShell('corepack pnpm exec tauri build', desktopRoot, {
  CARGO_ENCODED_RUSTFLAGS: remapPaths,
  RUSTFLAGS: undefined,
});

const installer = await newestInstaller(nsisRoot);
const scanTargets = [desktopExecutable, stagedEngine, stagedRag, installer];
if (commandExists('7z.exe')) {
  const scanRoot = await mkdtemp(join(tmpdir(), 'batch-translating-installer-scan-'));
  try {
    runFile('7z.exe', ['x', installer, `-o${scanRoot}`, '-y'], repoRoot);
    scanTargets.push(scanRoot);
    runFile(process.execPath, ['scripts/ci/scan-artifacts.mjs', ...scanTargets], repoRoot);
  } finally {
    await rm(scanRoot, { recursive: true, force: true });
  }
} else {
  process.stdout.write('7z.exe is unavailable; scanning the installer and staged payloads directly.\n');
  runFile(process.execPath, ['scripts/ci/scan-artifacts.mjs', ...scanTargets], repoRoot);
}

if (dirname(distRoot) !== repoRoot || basename(distRoot) !== 'dist-desktop') {
  throw new Error(`Refusing to replace unexpected output directory: ${distRoot}`);
}
await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });
const output = join(distRoot, basename(installer));
await copyFile(installer, output);
process.stdout.write(`Desktop release ready: ${output}\n`);

function runShell(command, cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const result = spawnSync(command, {
    cwd,
    env,
    shell: true,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${command}`);
}

function runFile(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(' ')}`);
  }
}

function commandExists(command) {
  const result = spawnSync('where.exe', [command], {
    shell: false,
    stdio: 'ignore',
  });
  return result.status === 0;
}

async function newestInstaller(directory) {
  const candidates = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.exe')) continue;
    const path = join(directory, entry.name);
    candidates.push({ path, modifiedAt: (await stat(path)).mtimeMs });
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const selected = candidates[0]?.path;
  if (!selected) throw new Error(`NSIS installer was not produced in ${directory}`);
  return selected;
}
