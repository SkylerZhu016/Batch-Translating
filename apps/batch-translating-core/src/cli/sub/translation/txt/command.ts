import type { Command } from 'commander';

import { assembleTxt } from './assemble';
import { inspectTxt } from './inspect';
import { splitTxt } from './split';
import { TxtSplitError } from './types';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface TxtCommandIo {
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly setExitCode: (code: number) => void;
}

export function registerTranslationTxtCommand(parent: Command, io?: Partial<TxtCommandIo>): void {
  const output = resolveIo(io);
  const txt = parent
    .command('txt')
    .description('Deterministic TXT chapter splitting and assembly commands.');

  txt
    .command('inspect')
    .description('Decode a TXT book and emit a machine-readable chapter map without writing.')
    .argument('<source>', 'Source TXT path.')
    .action(async (source: string) => {
      await runJsonCommand(output, async () => {
        const result = await inspectTxt(source);
        if (!result.valid) output.setExitCode(1);
        return result;
      });
    });

  txt
    .command('split')
    .description('Split a TXT book into canonical per-chapter files and a manifest.')
    .argument('<source>', 'Source TXT path.')
    .argument('<output-directory>', 'New destination directory; it must not already exist.')
    .option(
      '--pattern <regex>',
      'Chapter-heading regular expression (applied to the trimmed line start).',
    )
    .option(
      '--manifest <relative-path>',
      'Manifest path inside the destination directory.',
    )
    .action(
      async (
        source: string,
        outputDirectory: string,
        options: { pattern?: string; manifest?: string },
      ) => {
        await runJsonCommand(output, () =>
          splitTxt(source, outputDirectory, {
            pattern: options.pattern,
            manifestPath: options.manifest,
          }),
        );
      },
    );

  txt
    .command('assemble')
    .description(
      'Assemble the final translated TXT from translation records with full coverage checking.',
    )
    .argument('<manifest>', 'Manifest previously written by TXT split.')
    .argument('<records-directory>', 'Directory containing translation records (JSON/JSONL).')
    .argument('<output>', 'New TXT output path; it must not already exist.')
    .action(
      async (manifestPath: string, recordsDirectory: string, outputPath: string) => {
        await runJsonCommand(output, () =>
          assembleTxt(manifestPath, recordsDirectory, outputPath),
        );
      },
    );

  txt
    .command('validate')
    .description('Decode and re-split a TXT, reporting chapter structure and issues.')
    .argument('<source>', 'Source TXT path.')
    .action(async (source: string) => {
      await runJsonCommand(output, async () => {
        const result = await inspectTxt(source);
        if (!result.valid) output.setExitCode(1);
        return { ...result, chapters: undefined };
      });
    });
}

async function runJsonCommand(io: TxtCommandIo, operation: () => Promise<unknown>): Promise<void> {
  try {
    const result = await operation();
    io.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    io.setExitCode(1);
    io.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: error instanceof TxtSplitError ? error.code : 'txt_command_failed',
          message: errorMessage(error),
        },
      })}\n`,
    );
  }
}

function resolveIo(overrides: Partial<TxtCommandIo> | undefined): TxtCommandIo {
  return {
    stdout: overrides?.stdout ?? process.stdout,
    stderr: overrides?.stderr ?? process.stderr,
    setExitCode: overrides?.setExitCode ?? ((code) => {
      process.exitCode = code;
    }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
