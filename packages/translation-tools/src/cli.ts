#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { detectSourceFormat } from './hash.js';
import { writeImmutableJson } from './immutable.js';
import { mergeTranslationArtifacts } from './merge/deterministic-merger.js';
import { writeDeterministicReport } from './report.js';
import { renderTranslationSource } from './render.js';
import { copySourceImmutable, parseTranslationSource, writeBookManifest } from './source.js';
import type { DeterministicReportInput, MergeInput, RenderSourceOptions } from './types.js';
import { validateEpubStructure } from './epub/validate.js';

export interface TranslationToolsCliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly stdin?: () => Promise<string>;
}

const PROCESS_IO: TranslationToolsCliIo = {
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
  stdin: readProcessStdin,
};

export async function runTranslationToolsCli(args: string[], io: TranslationToolsCliIo = PROCESS_IO): Promise<number> {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case 'parse':
        return await parseCommand(rest, io);
      case 'copy-source':
        return await copySourceCommand(rest, io);
      case 'merge':
        return await mergeCommand(rest, io);
      case 'render':
        return await renderCommand(rest, io);
      case 'validate':
        return await validateCommand(rest, io);
      case 'report':
        return await reportCommand(rest, io);
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        printJson(io, { usage: usage() });
        return 0;
      default:
        throw new Error(`Unknown translation-tools command: ${command}`);
    }
  } catch (error) {
    io.stderr(
      `${JSON.stringify({
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`,
    );
    return 1;
  }
}

async function parseCommand(args: string[], io: TranslationToolsCliIo): Promise<number> {
  const sourcePath = positional(args, 0, 'parse requires a source EPUB/TXT path');
  const outputPath = option(args, '--out', true);
  const parsed = await parseTranslationSource(sourcePath);
  const manifestHash = await writeBookManifest(outputPath, parsed.manifest);
  printJson(io, { output_path: outputPath, manifest_hash: manifestHash, manifest: parsed.manifest });
  return 0;
}

async function copySourceCommand(args: string[], io: TranslationToolsCliIo): Promise<number> {
  const sourcePath = positional(args, 0, 'copy-source requires a source EPUB/TXT path');
  const outputPath = option(args, '--out', true);
  const expected = option(args, '--expected-sha256', false);
  const receipt = await copySourceImmutable(sourcePath, outputPath, expected);
  printJson(io, receipt);
  return 0;
}

async function mergeCommand(args: string[], io: TranslationToolsCliIo): Promise<number> {
  const inputPath = option(args, '--input', true);
  const outputPath = option(args, '--out', true);
  const input = await readJson<MergeInput>(inputPath, io);
  const result = mergeTranslationArtifacts(input);
  await writeImmutableJson(outputPath, result);
  printJson(io, result.receipt);
  return 0;
}

async function renderCommand(args: string[], io: TranslationToolsCliIo): Promise<number> {
  const inputPath = option(args, '--input', true);
  const input = await readJson<RenderSourceOptions>(inputPath, io);
  const outputOverride = option(args, '--out', false);
  const receiptPath = option(args, '--receipt', false);
  const receipt = await renderTranslationSource({
    ...input,
    ...(outputOverride ? { output_path: outputOverride } : {}),
  });
  if (receiptPath) await writeImmutableJson(receiptPath, receipt);
  printJson(io, receipt);
  return 0;
}

async function validateCommand(args: string[], io: TranslationToolsCliIo): Promise<number> {
  const sourcePath = positional(args, 0, 'validate requires an EPUB/TXT path');
  const outputPath = option(args, '--out', false);
  const format = detectSourceFormat(sourcePath);
  const result =
    format === 'epub'
      ? await validateEpubStructure(await readFile(sourcePath))
      : await validateTxt(sourcePath);
  if (outputPath) await writeImmutableJson(outputPath, result);
  printJson(io, result);
  return result.valid ? 0 : 2;
}

async function reportCommand(args: string[], io: TranslationToolsCliIo): Promise<number> {
  const inputPath = option(args, '--input', true);
  const outputPath = option(args, '--out', true);
  const input = await readJson<DeterministicReportInput>(inputPath, io);
  const receipt = await writeDeterministicReport(outputPath, input);
  printJson(io, receipt);
  return 0;
}

async function validateTxt(sourcePath: string): Promise<{
  valid: boolean;
  checks: string[];
  warnings: string[];
  errors: string[];
}> {
  try {
    const parsed = await parseTranslationSource(sourcePath);
    return {
      valid: true,
      checks: [`TXT is valid UTF-8 and contains ${parsed.manifest.paragraph_count} stable paragraph(s)`],
      warnings: [],
      errors: [],
    };
  } catch (error) {
    return {
      valid: false,
      checks: [],
      warnings: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function readJson<T>(path: string, io: TranslationToolsCliIo): Promise<T> {
  const source = path === '-' ? await readInjectedStdin(io) : await readFile(path, 'utf8');
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new Error(`Invalid JSON input ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readInjectedStdin(io: TranslationToolsCliIo): Promise<string> {
  if (!io.stdin) throw new Error('--input - requires an injected stdin reader');
  return await io.stdin();
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function positional(args: string[], index: number, message: string): string {
  const values = args.filter((value, valueIndex) => valueIndex === 0 || !args[valueIndex - 1]?.startsWith('--'));
  const value = values.filter((entry) => !entry.startsWith('--'))[index];
  if (!value) throw new Error(message);
  return value;
}

function option(args: string[], name: string, required: true): string;
function option(args: string[], name: string, required: false): string | undefined;
function option(args: string[], name: string, required: boolean): string | undefined {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (required && (!value || value.startsWith('--'))) throw new Error(`${name} is required`);
  return value && !value.startsWith('--') ? value : undefined;
}

function printJson(io: TranslationToolsCliIo, value: unknown): void {
  io.stdout(`${JSON.stringify({ ok: true, result: value })}\n`);
}

function usage(): string {
  return [
    'Batch Translating deterministic translation tools',
    '',
    '  parse <source.epub|source.txt> --out <book_manifest.json>',
    '  copy-source <source> --out <immutable-copy> [--expected-sha256 <hash>]',
    '  merge --input <merge-input.json> --out <merge-result.json>',
    '  render --input <render-input.json> [--out <final.epub|final.txt>] [--receipt <receipt.json>]',
    '  validate <book.epub|book.txt> [--out <validation.json>]',
    '  report --input <report-input.json> --out <report.md>',
    '',
  ].join('\n');
}
