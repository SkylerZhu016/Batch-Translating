/**
 * Explicit BGE-M3 discovery, download planning, resumable transfer, integrity, and fingerprint management.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type {
  CreateModelDownloadPlanOptions,
  DiscoveredModel,
  DownloadModelOptions,
  HardwareNotice,
  ModelDiscoveryOptions,
  ModelDiscoveryResult,
  ModelDownloadFile,
  ModelDownloadPlan,
  ModelDownloadProgress,
  ModelDownloadResult,
  ModelDownloadSource,
  ModelFileDigest,
  ModelFingerprint,
  RagFetch,
} from './types.ts';

export const DEFAULT_BGE_M3_MODEL_ID = 'BAAI/bge-m3';
export const DEFAULT_BGE_M3_REVISION = 'main';
export const DEFAULT_MODEL_DISK_RESERVE_BYTES = 512 * 1024 * 1024;

const MANAGED_MANIFEST = '.batch-translating-bge-m3.json';
const OFFICIAL_SOURCE: ModelDownloadSource = {
  id: 'huggingface-official',
  label: 'Hugging Face',
  kind: 'official',
  base_url: 'https://huggingface.co',
};
const MIRROR_SOURCE: ModelDownloadSource = {
  id: 'hf-mirror',
  label: 'HF-Mirror',
  kind: 'mirror',
  base_url: 'https://hf-mirror.com',
};

interface ManagedManifest extends ModelFingerprint {
  readonly format_version: 1;
}

interface HfTreeFile {
  readonly path: string;
  readonly size: number;
  readonly lfsSha256?: string;
}

export interface ModelSourceOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly prefer_mirror?: boolean;
}

export interface ModelManagerOptions {
  readonly fetch?: RagFetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ModelDiskSpace {
  readonly available_bytes: number;
  readonly required_bytes: number;
  readonly remaining_download_bytes: number;
  readonly reserve_bytes: number;
}

export type ModelProgressListener = (progress: ModelDownloadProgress) => void;

export function getModelDownloadSources(options: ModelSourceOptions = {}): readonly ModelDownloadSource[] {
  const env = options.env ?? process.env;
  const customEndpoint = env['BATCH_TRANSLATING_HF_ENDPOINT'] ?? env['HF_ENDPOINT'];
  const custom = customEndpoint
    ? [{
        id: 'configured-endpoint',
        label: 'Configured Hugging Face endpoint',
        kind: 'custom' as const,
        base_url: normalizeSourceBaseUrl(customEndpoint),
      }]
    : [];
  const builtins = options.prefer_mirror
    ? [MIRROR_SOURCE, OFFICIAL_SOURCE]
    : [OFFICIAL_SOURCE, MIRROR_SOURCE];
  return deduplicateSources([...custom, ...builtins]);
}

export function getBgeM3HardwareNotice(locale: 'zh-CN' | 'en' = 'zh-CN'): HardwareNotice {
  if (locale === 'en') {
    return {
      title: 'Install BGE-M3 to improve translation quality?',
      quality_message: 'Local semantic memory improves terminology, callbacks, and long-range consistency while reducing repeated context cost.',
      gpu_message: 'GPU acceleration is recommended and needs about 4 GB of available VRAM.',
      fallback_message: 'A GPU is optional: the service can use CPU fallback, but indexing and retrieval will be slower.',
      recommended_vram_gb: 4,
    };
  }
  return {
    title: '是否安装 BGE-M3 以提高翻译质量？',
    quality_message: '本地语义记忆可改善术语、前后照应与长距离一致性，并减少反复附加上下文的成本。',
    gpu_message: '推荐使用 GPU 加速，约需 4 GB 可用显存。',
    fallback_message: '没有 GPU 也能使用 CPU 回退，但建库和检索速度会更慢。',
    recommended_vram_gb: 4,
  };
}

export async function discoverBgeM3(options: ModelDiscoveryOptions = {}): Promise<ModelDiscoveryResult> {
  const env = options.env ?? process.env;
  const home = options.home_directory ?? homedir();
  const candidates = await collectCandidateDirectories(options.explicit_paths ?? [], env, home, options.signal);
  const checkedPaths: string[] = [];
  const discovered: DiscoveredModel[] = [];

  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    checkedPaths.push(candidate.path);
    const model = await inspectCandidate(
      candidate.path,
      candidate.source,
      options.verify_hashes ?? false,
      options.signal,
    );
    if (model) {
      discovered.push(model);
    }
  }

  return {
    found: discovered.length > 0,
    ...(discovered[0] ? { selected: discovered[0] } : {}),
    candidates: discovered,
    checked_paths: checkedPaths,
  };
}

export async function fingerprintModelDirectory(
  directory: string,
  modelId = DEFAULT_BGE_M3_MODEL_ID,
  revision = inferRevision(directory),
  signal?: AbortSignal,
): Promise<ModelFingerprint> {
  const files = await listModelFiles(directory, signal);
  if (files.length === 0) {
    throw new Error(`No model files found in ${directory}`);
  }
  const digests: ModelFileDigest[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    digests.push({
      path: file.relativePath,
      size: file.size,
      sha256: await sha256File(file.absolutePath, signal),
    });
  }
  digests.sort((left, right) => left.path.localeCompare(right.path));
  return buildFingerprint(modelId, revision, digests);
}

export async function createBgeM3DownloadPlan(
  options: CreateModelDownloadPlanOptions,
  fetchImpl: RagFetch = globalThis.fetch.bind(globalThis),
): Promise<ModelDownloadPlan> {
  const modelId = options.model_id ?? DEFAULT_BGE_M3_MODEL_ID;
  const requestedRevision = options.revision ?? DEFAULT_BGE_M3_REVISION;
  const baseUrl = normalizeSourceBaseUrl(options.source.base_url);
  const encodedModelId = modelId.split('/').map(encodeURIComponent).join('/');
  const metadataUrl = `${baseUrl}/api/models/${encodedModelId}/revision/${encodeURIComponent(requestedRevision)}`;
  const metadata = await fetchJson(fetchImpl, metadataUrl, options.signal);
  const resolvedRevision = readStringProperty(metadata, 'sha') ?? requestedRevision;
  const treeUrl = `${baseUrl}/api/models/${encodedModelId}/tree/${encodeURIComponent(resolvedRevision)}?recursive=true&expand=true&limit=1000`;
  const tree = await fetchJson(fetchImpl, treeUrl, options.signal);
  const manifest = selectRuntimeFiles(parseHfTree(tree));
  if (!manifest.some(isModelWeight)) {
    throw new Error(`No supported BGE-M3 model weights were listed by ${options.source.label}`);
  }

  const files: ModelDownloadFile[] = manifest.map((file) => ({
    path: file.path,
    size: file.size,
    ...(file.lfsSha256 ? { sha256: file.lfsSha256 } : {}),
    url: `${baseUrl}/${encodedModelId}/resolve/${encodeURIComponent(resolvedRevision)}/${encodePath(file.path)}?download=true`,
    lfs: file.lfsSha256 !== undefined,
  }));
  return {
    model_id: modelId,
    requested_revision: requestedRevision,
    resolved_revision: resolvedRevision,
    source: { ...options.source, base_url: baseUrl },
    destination: resolve(options.destination),
    files,
    total_bytes: files.reduce((total, file) => total + file.size, 0),
  };
}

export async function checkModelDownloadDiskSpace(
  plan: ModelDownloadPlan,
  reserveBytes = DEFAULT_MODEL_DISK_RESERVE_BYTES,
): Promise<ModelDiskSpace> {
  const remainingDownloadBytes = await calculateRemainingBytes(plan);
  const existingParent = await nearestExistingParent(plan.destination);
  const fs = await statfs(existingParent);
  const availableBytes = fs.bavail * fs.bsize;
  const requiredBytes = remainingDownloadBytes + reserveBytes;
  return {
    available_bytes: availableBytes,
    required_bytes: requiredBytes,
    remaining_download_bytes: remainingDownloadBytes,
    reserve_bytes: reserveBytes,
  };
}

export class BgeM3ModelManager {
  private readonly fetchImpl: RagFetch;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly listeners = new Set<ModelProgressListener>();
  private activeController: AbortController | undefined;

  constructor(options: ModelManagerOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.env = options.env ?? process.env;
  }

  sources(preferMirror = false): readonly ModelDownloadSource[] {
    return getModelDownloadSources({ env: this.env, prefer_mirror: preferMirror });
  }

  notice(locale: 'zh-CN' | 'en' = 'zh-CN'): HardwareNotice {
    return getBgeM3HardwareNotice(locale);
  }

  onProgress(listener: ModelProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async discover(options: Omit<ModelDiscoveryOptions, 'env'> = {}): Promise<ModelDiscoveryResult> {
    this.emit(progress('discovering', DEFAULT_BGE_M3_MODEL_ID, 'Scanning configured paths and Hugging Face caches'));
    return discoverBgeM3({ ...options, env: this.env });
  }

  async plan(options: CreateModelDownloadPlanOptions): Promise<ModelDownloadPlan> {
    this.emit(progress('planning', options.model_id ?? DEFAULT_BGE_M3_MODEL_ID, 'Reading the selected source manifest'));
    return createBgeM3DownloadPlan(options, this.fetchImpl);
  }

  async install(
    planOptions: CreateModelDownloadPlanOptions,
    downloadOptions: DownloadModelOptions = {},
  ): Promise<ModelDownloadResult> {
    return this.download(await this.plan(planOptions), downloadOptions);
  }

  cancelDownload(reason = 'Model download cancelled by user'): void {
    this.activeController?.abort(new Error(reason));
  }

  async download(plan: ModelDownloadPlan, options: DownloadModelOptions = {}): Promise<ModelDownloadResult> {
    if (this.activeController) {
      throw new Error('A model download is already active');
    }
    const controller = new AbortController();
    this.activeController = controller;
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    let networkBytes = 0;
    let resumed = false;

    try {
      this.emit(progress('checking_disk', plan.model_id, 'Checking free disk space', 0, plan.total_bytes));
      const disk = await checkModelDownloadDiskSpace(
        plan,
        options.reserve_bytes ?? DEFAULT_MODEL_DISK_RESERVE_BYTES,
      );
      if (disk.available_bytes < disk.required_bytes) {
        throw new Error(
          `Insufficient disk space for BGE-M3: need ${disk.required_bytes} bytes, have ${disk.available_bytes} bytes`,
        );
      }

      await mkdir(plan.destination, { recursive: true });
      let completedBytes = 0;
      for (const file of plan.files) {
        signal.throwIfAborted();
        const target = safeModelPath(plan.destination, file.path);
        const partial = `${target}.partial`;
        await mkdir(dirname(target), { recursive: true });

        if (await isCompleteTarget(target, file, signal)) {
          completedBytes += file.size;
          this.emit(fileProgress(plan, file, file.size, completedBytes, 'Already present and verified'));
          continue;
        }
        await preparePartialTarget(target, partial, file.size);
        const partialBytes = await fileSize(partial);
        resumed ||= partialBytes > 0;
        const result = await downloadOneFile(
          this.fetchImpl,
          file,
          partial,
          signal,
          (fileBytes, receivedBytes) => {
            networkBytes += receivedBytes;
            this.emit(fileProgress(plan, file, fileBytes, completedBytes + fileBytes, 'Downloading BGE-M3'));
          },
        );
        resumed ||= result.resumed;
        this.emit(fileProgress(plan, file, file.size, completedBytes + file.size, 'Verifying SHA-256'));
        if (file.sha256) {
          const digest = await sha256File(partial, signal);
          if (digest !== normalizeSha256(file.sha256)) {
            await unlinkIfExists(partial);
            throw new Error(`LFS SHA-256 mismatch for ${file.path}`);
          }
        }
        await renameReplacing(partial, target);
        completedBytes += file.size;
      }

      this.emit(progress('verifying', plan.model_id, 'Fingerprinting every installed model file', plan.total_bytes, plan.total_bytes));
      const fingerprint = await fingerprintModelDirectory(
        plan.destination,
        plan.model_id,
        plan.resolved_revision,
        signal,
      );
      const manifest: ManagedManifest = { format_version: 1, ...fingerprint };
      await writeFile(join(plan.destination, MANAGED_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      this.emit(progress('completed', plan.model_id, 'BGE-M3 is installed and verified', plan.total_bytes, plan.total_bytes));
      return { directory: plan.destination, fingerprint, resumed, downloaded_bytes: networkBytes };
    } catch (error) {
      const cancelled = signal.aborted;
      this.emit(progress(cancelled ? 'cancelled' : 'failed', plan.model_id, cancelled ? 'Download cancelled; partial files are kept for resume' : errorMessage(error), 0, plan.total_bytes));
      throw error;
    } finally {
      this.activeController = undefined;
    }
  }

  private emit(value: ModelDownloadProgress): void {
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        // Progress observers cannot interrupt a model transfer.
      }
    }
  }
}

async function collectCandidateDirectories(
  explicitPaths: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  signal?: AbortSignal,
): Promise<readonly { path: string; source: DiscoveredModel['source'] }[]> {
  const direct = [
    ...explicitPaths.map((path) => ({ path, source: 'explicit' as const })),
    ...['BATCH_TRANSLATING_BGE_M3_PATH', 'BGE_M3_MODEL_PATH', 'BGE_M3_PATH']
      .map((key) => env[key])
      .filter((path): path is string => Boolean(path))
      .map((path) => ({ path, source: 'environment' as const })),
  ];
  const cacheRoots = [
    env['HF_HUB_CACHE'],
    env['HUGGINGFACE_HUB_CACHE'],
    env['TRANSFORMERS_CACHE'],
    env['HF_HOME'] ? join(env['HF_HOME'], 'hub') : undefined,
    join(home, '.cache', 'huggingface', 'hub'),
    env['LOCALAPPDATA'] ? join(env['LOCALAPPDATA'], 'huggingface', 'hub') : undefined,
  ].filter((path): path is string => Boolean(path));

  const all: { path: string; source: DiscoveredModel['source'] }[] = [...direct];
  for (const root of cacheRoots) {
    signal?.throwIfAborted();
    const expanded = await expandCacheRoot(root);
    all.push(...expanded.map((path) => ({ path, source: 'huggingface_cache' as const })));
  }
  const seen = new Set<string>();
  return all
    .map((candidate) => ({ ...candidate, path: resolve(candidate.path) }))
    .filter((candidate) => {
      const key = process.platform === 'win32' ? candidate.path.toLowerCase() : candidate.path;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

async function expandCacheRoot(root: string): Promise<readonly string[]> {
  const normalized = resolve(root);
  const possibleModelRoot = basename(normalized).toLowerCase() === 'models--baai--bge-m3'
    ? normalized
    : join(normalized, 'models--BAAI--bge-m3');
  const snapshots = join(possibleModelRoot, 'snapshots');
  if (!(await pathExists(snapshots))) {
    return pathExists(normalized).then((exists) => exists ? [normalized] : []);
  }
  return (await readdir(snapshots, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(snapshots, entry.name));
}

async function inspectCandidate(
  directory: string,
  source: DiscoveredModel['source'],
  verifyHashes: boolean,
  signal?: AbortSignal,
): Promise<DiscoveredModel | undefined> {
  if (!(await isBgeM3Directory(directory, signal))) {
    return undefined;
  }
  const managed = await readManagedManifest(directory);
  let fingerprint: ModelFingerprint;
  if (managed && !verifyHashes && await manifestSizesMatch(directory, managed.files)) {
    fingerprint = managed;
  } else {
    fingerprint = await fingerprintModelDirectory(
      directory,
      managed?.model_id ?? DEFAULT_BGE_M3_MODEL_ID,
      managed?.revision ?? inferRevision(directory),
      signal,
    );
    if (managed && verifyHashes && fingerprint.fingerprint !== managed.fingerprint) {
      return undefined;
    }
  }
  return { ...fingerprint, directory, source: managed ? 'managed' : source };
}

async function isBgeM3Directory(directory: string, signal?: AbortSignal): Promise<boolean> {
  if (!(await pathExists(join(directory, 'config.json')))) {
    return false;
  }
  const files = await listModelFiles(directory, signal);
  return files.some((file) => isModelWeight({ path: file.relativePath }));
}

async function readManagedManifest(directory: string): Promise<ManagedManifest | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, MANAGED_MANIFEST), 'utf8')) as unknown;
    if (!isRecord(value) || value['format_version'] !== 1 || !Array.isArray(value['files'])) {
      return undefined;
    }
    return value as unknown as ManagedManifest;
  } catch {
    return undefined;
  }
}

async function manifestSizesMatch(directory: string, files: readonly ModelFileDigest[]): Promise<boolean> {
  for (const file of files) {
    const target = safeModelPath(directory, file.path);
    if (await fileSize(target) !== file.size) {
      return false;
    }
  }
  return files.length > 0;
}

function inferRevision(directory: string): string {
  const parent = dirname(directory);
  return basename(parent).toLowerCase() === 'snapshots' ? basename(directory) : 'local';
}

async function listModelFiles(
  root: string,
  signal?: AbortSignal,
): Promise<readonly { absolutePath: string; relativePath: string; size: number }[]> {
  const output: { absolutePath: string; relativePath: string; size: number }[] = [];
  async function visit(directory: string): Promise<void> {
    signal?.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === MANAGED_MANIFEST || entry.name.endsWith('.partial')) {
        continue;
      }
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        const info = await stat(absolutePath);
        if (info.isFile()) {
          output.push({
            absolutePath,
            relativePath: relative(root, absolutePath).split(sep).join('/'),
            size: info.size,
          });
        }
      }
    }
  }
  await visit(root);
  output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return output;
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function buildFingerprint(
  modelId: string,
  revision: string,
  files: readonly ModelFileDigest[],
): ModelFingerprint {
  const hash = createHash('sha256');
  hash.update(`model:${modelId}\nrevision:${revision}\n`);
  for (const file of files) {
    hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  return { model_id: modelId, revision, fingerprint: hash.digest('hex'), files };
}

async function fetchJson(fetchImpl: RagFetch, url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Model source returned HTTP ${response.status} for ${new URL(url).pathname}`);
  }
  return response.json() as Promise<unknown>;
}

function parseHfTree(value: unknown): readonly HfTreeFile[] {
  if (!Array.isArray(value)) {
    throw new Error('Hugging Face model tree response is not an array');
  }
  const files: HfTreeFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || entry['type'] !== 'file') {
      continue;
    }
    const path = readStringProperty(entry, 'path');
    const size = entry['size'];
    if (!path || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      continue;
    }
    const lfs = isRecord(entry['lfs']) ? entry['lfs'] : undefined;
    const oid = lfs ? readStringProperty(lfs, 'oid') : undefined;
    const lfsSha256 = oid ? normalizeSha256(oid) : undefined;
    files.push({ path, size, ...(lfsSha256 ? { lfsSha256 } : {}) });
  }
  return files;
}

function selectRuntimeFiles(files: readonly HfTreeFile[]): readonly HfTreeFile[] {
  const safe = files.filter((file) => {
    const path = file.path.toLowerCase();
    return !path.startsWith('.')
      && !path.startsWith('onnx/')
      && !path.startsWith('openvino/')
      && !path.startsWith('imgs/')
      && !path.startsWith('images/')
      && !path.startsWith('flax_')
      && !path.startsWith('tf_')
      && !path.endsWith('.md')
      && !path.endsWith('.jpg')
      && !path.endsWith('.jpeg')
      && !path.endsWith('.png');
  });
  const safetensors = safe.filter((file) => /(^|\/)model(?:-\d+-of-\d+)?\.safetensors$/.test(file.path));
  const safetensorsIndex = safe.filter((file) => file.path === 'model.safetensors.index.json');
  const pytorch = safe.filter((file) => /(^|\/)pytorch_model(?:-\d+-of-\d+)?\.bin$/.test(file.path));
  const pytorchIndex = safe.filter((file) => file.path === 'pytorch_model.bin.index.json');
  const selectedWeights = safetensors.length > 0
    ? [...safetensors, ...safetensorsIndex]
    : [...pytorch, ...pytorchIndex];
  const support = safe.filter((file) => {
    const path = file.path.toLowerCase();
    return path.startsWith('1_pooling/')
      || (!path.includes('/') && (
        path.endsWith('.json')
        || path.endsWith('.model')
        || path.endsWith('.txt')
        || path.endsWith('.py')
        || path === 'sparse_linear.pt'
        || path === 'colbert_linear.pt'
      ));
  });
  const byPath = new Map<string, HfTreeFile>();
  for (const file of [...support, ...selectedWeights]) {
    byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function isModelWeight(file: Pick<HfTreeFile, 'path'>): boolean {
  const path = file.path.toLowerCase();
  return path.endsWith('.safetensors')
    || /(^|\/)pytorch_model(?:-\d+-of-\d+)?\.bin$/.test(path);
}

async function calculateRemainingBytes(plan: ModelDownloadPlan): Promise<number> {
  let remaining = 0;
  for (const file of plan.files) {
    const target = safeModelPath(plan.destination, file.path);
    const targetSize = await fileSize(target);
    if (targetSize === file.size) {
      if (!file.sha256 || await sha256File(target) === normalizeSha256(file.sha256)) {
        continue;
      }
    }
    const partialSize = Math.min(
      Math.max(targetSize < file.size ? targetSize : 0, await fileSize(`${target}.partial`)),
      file.size,
    );
    remaining += file.size - partialSize;
  }
  return remaining;
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = resolve(path);
  while (!(await pathExists(current))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Cannot find an existing parent for ${path}`);
    }
    current = parent;
  }
  return current;
}

async function isCompleteTarget(target: string, file: ModelDownloadFile, signal: AbortSignal): Promise<boolean> {
  if (await fileSize(target) !== file.size) {
    return false;
  }
  if (!file.sha256) {
    return true;
  }
  return await sha256File(target, signal) === normalizeSha256(file.sha256);
}

async function preparePartialTarget(target: string, partial: string, expectedSize: number): Promise<void> {
  const targetSize = await fileSize(target);
  const partialSize = await fileSize(partial);
  if (targetSize > 0 && targetSize < expectedSize && partialSize === 0) {
    await rename(target, partial);
  } else if (targetSize !== expectedSize) {
    await unlinkIfExists(target);
  }
  if (await fileSize(partial) > expectedSize) {
    await unlinkIfExists(partial);
  }
}

async function downloadOneFile(
  fetchImpl: RagFetch,
  file: ModelDownloadFile,
  partial: string,
  signal: AbortSignal,
  onChunk: (fileBytes: number, receivedBytes: number) => void,
): Promise<{ resumed: boolean }> {
  let offset = await fileSize(partial);
  const requestedResume = offset > 0;
  const response = await fetchImpl(file.url, {
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    signal,
    redirect: 'follow',
  });
  if (response.status === 416 && offset === file.size) {
    return { resumed: true };
  }
  if (!response.ok) {
    throw new Error(`Model download returned HTTP ${response.status} for ${file.path}`);
  }
  if (offset > 0 && response.status !== 206) {
    await truncateFile(partial);
    offset = 0;
  }
  if (response.status === 206) {
    const contentRange = response.headers.get('content-range');
    if (!contentRange || !contentRange.startsWith(`bytes ${offset}-`)) {
      throw new Error(`Invalid Content-Range while resuming ${file.path}`);
    }
  }
  if (!response.body) {
    throw new Error(`Model source returned an empty body for ${file.path}`);
  }

  const handle = await open(partial, offset > 0 ? 'a' : 'w');
  let written = offset;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      await handle.writeFile(chunk);
      written += chunk.byteLength;
      if (written > file.size) {
        throw new Error(`Model source exceeded declared size for ${file.path}`);
      }
      onChunk(written, chunk.byteLength);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (written !== file.size) {
    throw new Error(`Incomplete model download for ${file.path}: ${written}/${file.size} bytes`);
  }
  return { resumed: requestedResume && offset > 0 };
}

async function truncateFile(path: string): Promise<void> {
  const handle = await open(path, 'w');
  await handle.close();
}

async function renameReplacing(source: string, target: string): Promise<void> {
  await unlinkIfExists(target);
  await rename(source, target);
}

function safeModelPath(root: string, manifestPath: string): string {
  if (!manifestPath || manifestPath.includes('\0') || manifestPath.replaceAll('\\', '/').split('/').includes('..')) {
    throw new Error(`Unsafe model manifest path: ${manifestPath}`);
  }
  const target = resolve(root, ...manifestPath.replaceAll('\\', '/').split('/'));
  const normalizedRoot = resolve(root);
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  const targetForCompare = process.platform === 'win32' ? target.toLowerCase() : target;
  const prefixForCompare = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  if (!targetForCompare.startsWith(prefixForCompare)) {
    throw new Error(`Model manifest path escapes destination: ${manifestPath}`);
  }
  return target;
}

function normalizeSourceBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Model source must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Model source URL must not contain credentials');
  }
  return url.toString().replace(/\/$/, '');
}

function deduplicateSources(sources: readonly ModelDownloadSource[]): readonly ModelDownloadSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const url = normalizeSourceBaseUrl(source.base_url);
    if (seen.has(url)) {
      return false;
    }
    seen.add(url);
    return true;
  });
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function normalizeSha256(value: string): string {
  const normalized = value.toLowerCase().replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('Model manifest contains an invalid SHA-256 digest');
  }
  return normalized;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
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

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isRecord(error) || error['code'] !== 'ENOENT') {
      throw error;
    }
  }
}

function progress(
  phase: ModelDownloadProgress['phase'],
  modelId: string,
  message: string,
  bytesDownloaded = 0,
  bytesTotal = 0,
): ModelDownloadProgress {
  return {
    phase,
    model_id: modelId,
    file_bytes_downloaded: 0,
    file_bytes_total: 0,
    bytes_downloaded: bytesDownloaded,
    bytes_total: bytesTotal,
    percent: bytesTotal > 0 ? Math.min(100, (bytesDownloaded / bytesTotal) * 100) : 0,
    message,
  };
}

function fileProgress(
  plan: ModelDownloadPlan,
  file: ModelDownloadFile,
  fileBytes: number,
  totalBytes: number,
  message: string,
): ModelDownloadProgress {
  return {
    phase: message.startsWith('Verifying') ? 'verifying' : 'downloading',
    model_id: plan.model_id,
    file: file.path,
    file_bytes_downloaded: fileBytes,
    file_bytes_total: file.size,
    bytes_downloaded: totalBytes,
    bytes_total: plan.total_bytes,
    percent: plan.total_bytes > 0 ? Math.min(100, (totalBytes / plan.total_bytes) * 100) : 0,
    message,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
