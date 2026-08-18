import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const sourceRoot = resolve(repositoryRoot, 'packages', 'translation-rag', 'service');
const destinationRoot = resolve(
  repositoryRoot,
  'apps',
  'batch-translating-desktop',
  'src-tauri',
  'resources',
  'translation-rag-service',
);
const resourcesRoot = resolve(
  repositoryRoot,
  'apps',
  'batch-translating-desktop',
  'src-tauri',
  'resources',
);
const requiredEntry = 'src/translation_rag_service/server.py';
const fixedTimestamp = new Date('2000-01-01T00:00:00.000Z');
const forbiddenSegments = new Set([
  '__pycache__',
  '.cache',
  'cache',
  '.venv',
  'venv',
  'env',
  'model',
  'models',
  'node_modules',
  'test',
  'tests',
]);
const forbiddenFilePatterns = [
  /(?:^|\/)(?:\.env(?:\..*)?|credentials?\.json|runtime\.json|.*\.token|.*\.secret)$/i,
  /\.(?:bin|ckpt|db|onnx|partial|pickle|pkl|pt|pth|safetensors|sqlite|sqlite3|wal|shm)$/i,
  /(?:^|\/)pytorch_model(?:-\d+-of-\d+)?\.bin$/i,
];
const privateContentPatterns = [
  /(?:^|["'\s=])(?:[A-Za-z]:[\\/]|\/(?:home|Users|private|tmp)\/)/m,
  /file:\/\//i,
  /-----BEGIN (?:OPENSSH |RSA )?PRIVATE KEY-----/,
  /(?:api[_-]?key|access[_-]?token|bearer[_-]?token|password|secret)\s*[=:]\s*["'][^"'\r\n]{16,}["']/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

await assertSafeRoots();
const files = await collectProductionFiles(sourceRoot);
if (!files.includes('pyproject.toml')) {
  throw new Error('RAG service staging refused: pyproject.toml is missing');
}
if (!files.includes(requiredEntry)) {
  throw new Error(`RAG service staging refused: ${requiredEntry} is missing`);
}
const pyproject = await readFile(resolve(sourceRoot, 'pyproject.toml'), 'utf8');
if (/\bREADME\.md\b/i.test(pyproject)) {
  throw new Error(
    'RAG service staging refused: pyproject.toml references README.md outside the production whitelist',
  );
}

await rm(destinationRoot, { recursive: true, force: true });
for (const relativePath of files) {
  const source = resolve(sourceRoot, ...relativePath.split('/'));
  const destination = resolve(destinationRoot, ...relativePath.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await utimes(destination, fixedTimestamp, fixedTimestamp);
}

const stagedFiles = await collectProductionFiles(destinationRoot);
if (JSON.stringify(stagedFiles) !== JSON.stringify(files)) {
  throw new Error('RAG service staging refused: staged file set differs from the validated source set');
}
process.stdout.write(`staged ${files.length} validated RAG service files\n`);

async function assertSafeRoots() {
  const repository = await realpath(repositoryRoot);
  const source = await realpath(sourceRoot).catch(() => undefined);
  if (!source) throw new Error('RAG service staging refused: source directory does not exist');
  if (!isWithin(repository, source)) {
    throw new Error('RAG service staging refused: source resolves outside the repository');
  }
  if (!isWithin(resourcesRoot, destinationRoot) || destinationRoot === resourcesRoot) {
    throw new Error('RAG service staging refused: unsafe destination directory');
  }
  const resourceParent = await realpath(dirname(resourcesRoot));
  if (!isWithin(repository, resourceParent)) {
    throw new Error('RAG service staging refused: resource parent resolves outside the repository');
  }
  const resourcesInfo = await lstat(resourcesRoot).catch(() => undefined);
  if (resourcesInfo?.isSymbolicLink()) {
    throw new Error('RAG service staging refused: resources directory is a symbolic link');
  }
  const resolvedResources = resourcesInfo ? await realpath(resourcesRoot) : undefined;
  if (resolvedResources && !isWithin(repository, resolvedResources)) {
    throw new Error('RAG service staging refused: resources directory resolves outside the repository');
  }
  const destinationInfo = await lstat(destinationRoot).catch(() => undefined);
  if (destinationInfo?.isSymbolicLink()) {
    throw new Error('RAG service staging refused: destination is a symbolic link');
  }
  if (destinationInfo) {
    const resolvedDestination = await realpath(destinationRoot);
    if (!resolvedResources || !isWithin(resolvedResources, resolvedDestination)) {
      throw new Error('RAG service staging refused: destination resolves outside resources');
    }
  }
}

async function collectProductionFiles(root) {
  const output = [];
  await walk(root, '');
  output.sort(comparePaths);
  return output;

  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const normalized = relativePath.replaceAll('\\', '/');
      const segments = normalized.toLowerCase().split('/');
      if (segments.some((segment) => forbiddenSegments.has(segment))) {
        throw new Error(`RAG service staging refused forbidden path: ${normalized}`);
      }
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error(`RAG service staging refused symbolic link: ${normalized}`);
      }
      if (entry.isDirectory()) {
        await walk(path, normalized);
        continue;
      }
      if (!entry.isFile()) continue;
      if (forbiddenFilePatterns.some((pattern) => pattern.test(normalized))) {
        throw new Error(`RAG service staging refused private/runtime file: ${normalized}`);
      }
      const allowed = normalized === 'pyproject.toml'
        || (normalized.startsWith('src/') && normalized.endsWith('.py'));
      if (!allowed) continue;
      const content = await readFile(path, 'utf8');
      for (const pattern of privateContentPatterns) {
        if (pattern.test(content)) {
          throw new Error(`RAG service staging refused private or absolute-path content: ${normalized}`);
        }
      }
      output.push(normalized);
    }
  }
}

function isWithin(parent, child) {
  const candidate = relative(parent, child);
  return candidate !== '' && candidate !== '..' && !candidate.startsWith(`..${sep}`);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
