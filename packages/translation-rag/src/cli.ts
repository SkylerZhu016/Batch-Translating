#!/usr/bin/env node

import { resolve } from 'node:path';

import {
  BgeM3ModelManager,
  DEFAULT_BGE_M3_MODEL_ID,
  type ModelDownloadSource,
} from '../client/src/index.ts';
import { probeRagPython } from './service.ts';
import { prepareRagPythonEnvironment } from './python-environment.ts';

interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const [group, command] = parsed.positionals;

  if (group === 'python' && command === 'probe') {
    print(await probeRagPython({ pythonExecutable: stringFlag(parsed, 'python') }));
    return;
  }
  if (group === 'python' && command === 'prepare') {
    const index = stringFlag(parsed, 'index') ?? 'official';
    if (index !== 'official' && index !== 'mirror') {
      throw new Error('--index must be official or mirror');
    }
    print(await prepareRagPythonEnvironment({
      homeDirectory: requiredFlag(parsed, 'home'),
      pythonExecutable: stringFlag(parsed, 'python'),
      packageIndex: index,
      onProgress: (progress) => process.stderr.write(`${JSON.stringify(progress)}\n`),
    }));
    return;
  }

  const manager = new BgeM3ModelManager();
  if (group === 'model' && command === 'sources') {
    print({
      notice: manager.notice(localeFlag(parsed)),
      sources: manager.sources(booleanFlag(parsed, 'prefer-mirror')),
    });
    return;
  }
  if (group === 'model' && command === 'status') {
    const explicitPath = stringFlag(parsed, 'path');
    print(await manager.discover({
      ...(explicitPath ? { explicit_paths: [resolve(explicitPath)] } : {}),
      verify_hashes: booleanFlag(parsed, 'verify'),
    }));
    return;
  }
  if (group === 'model' && (command === 'plan' || command === 'download')) {
    const destination = requiredFlag(parsed, 'destination');
    const source = resolveSource(manager, stringFlag(parsed, 'source') ?? 'official');
    const plan = await manager.plan({
      model_id: stringFlag(parsed, 'model') ?? DEFAULT_BGE_M3_MODEL_ID,
      revision: stringFlag(parsed, 'revision') ?? 'main',
      source,
      destination: resolve(destination),
    });
    if (command === 'plan') {
      print({ notice: manager.notice(localeFlag(parsed)), plan });
      return;
    }

    // Reaching this branch requires an explicit `model download` command. Merely
    // importing the package, listing sources, planning, or discovering never
    // transfers model bytes.
    process.stderr.write(`${JSON.stringify({ notice: manager.notice(localeFlag(parsed)) })}\n`);
    const unsubscribe = manager.onProgress((progress) => {
      process.stderr.write(`${JSON.stringify(progress)}\n`);
    });
    const onInterrupt = (): void => manager.cancelDownload('Interrupted by user');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    try {
      print(await manager.download(plan));
    } finally {
      unsubscribe();
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
    }
    return;
  }

  usage();
  process.exitCode = group ? 2 : 0;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equal = value.indexOf('=');
    if (equal >= 0) {
      flags.set(value.slice(2, equal), value.slice(equal + 1));
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positionals, flags };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' && value ? value : undefined;
}

function requiredFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  const value = parsed.flags.get(name);
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

function localeFlag(parsed: ParsedArgs): 'zh-CN' | 'en' {
  return stringFlag(parsed, 'locale') === 'en' ? 'en' : 'zh-CN';
}

function resolveSource(manager: BgeM3ModelManager, requested: string): ModelDownloadSource {
  const sources = manager.sources(requested === 'mirror');
  if (requested === 'official') {
    const source = sources.find((candidate) => candidate.kind === 'official');
    if (source) return source;
  }
  if (requested === 'mirror') {
    const source = sources.find((candidate) => candidate.kind === 'mirror');
    if (source) return source;
  }
  const configured = sources.find((candidate) => candidate.id === requested);
  if (configured) return configured;
  if (/^https?:\/\//.test(requested)) {
    return { id: 'cli-custom', label: 'CLI custom endpoint', kind: 'custom', base_url: requested };
  }
  throw new Error(`Unknown model source: ${requested}`);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): void {
  process.stdout.write(`Batch Translating RAG\n\n`);
  process.stdout.write(`  model sources [--prefer-mirror] [--locale zh-CN|en]\n`);
  process.stdout.write(`  model status [--path PATH] [--verify]\n`);
  process.stdout.write(`  model plan --destination PATH [--source official|mirror|URL] [--revision REV]\n`);
  process.stdout.write(`  model download --destination PATH [--source official|mirror|URL] [--revision REV]\n`);
  process.stdout.write(`  python probe [--python PATH]\n`);
  process.stdout.write(`  python prepare --home PATH [--python PATH] [--index official|mirror]\n`);
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
