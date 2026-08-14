import type { Command } from 'commander';

import { inspectEpub, repackEpub, unpackEpub, validateEpub } from './archive';
import { EpubArchiveError } from './types';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface EpubCommandIo {
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly setExitCode: (code: number) => void;
}

export function registerTranslationCommand(parent: Command, io?: Partial<EpubCommandIo>): void {
  const translation = parent.command('translation', { hidden: true });
  registerTranslationEpubSubcommands(translation, io);
}

/** Registers the EPUB subcommands on an already-created `translation` parent. */
export function registerTranslationEpubSubcommands(
  parent: Command,
  io?: Partial<EpubCommandIo>,
): void {
  const output = resolveIo(io);
  const epub = parent
    .command('epub')
    .description('Deterministic EPUB ZIP inspection and packaging commands.');

  epub
    .command('inspect')
    .description('Inspect EPUB ZIP structure and emit a machine-readable chapter map.')
    .argument('<source>', 'Source EPUB path.')
    .option('--verify-crc', 'Read and CRC-check every archive entry.', false)
    .action(async (source: string, options: { verifyCrc?: boolean }) => {
      await runJsonCommand(output, async () => {
        const result = await inspectEpub(source, { verifyCrc: options.verifyCrc === true });
        if (!result.valid) output.setExitCode(1);
        return result;
      });
    });

  epub
    .command('unpack')
    .description('Safely unpack a valid EPUB ZIP without modifying the source archive.')
    .argument('<source>', 'Source EPUB path.')
    .argument('<output-directory>', 'New destination directory; it must not already exist.')
    .option(
      '--manifest <relative-path>',
      'Inspection manifest path inside the destination directory.',
    )
    .action(
      async (
        source: string,
        outputDirectory: string,
        options: { manifest?: string },
      ) => {
        await runJsonCommand(output, () =>
          unpackEpub(source, outputDirectory, { manifestPath: options.manifest }),
        );
      },
    );

  epub
    .command('repack')
    .description('Repack an unpacked EPUB in source entry order and validate before publishing.')
    .argument('<input-directory>', 'Directory previously created by EPUB unpack.')
    .argument('<output>', 'New EPUB output path; it must not already exist or equal the source path.')
    .option('--manifest <path>', 'Inspection manifest path inside the input directory.')
    .action(
      async (inputDirectory: string, outputPath: string, options: { manifest?: string }) => {
        await runJsonCommand(output, () =>
          repackEpub(inputDirectory, outputPath, { manifestPath: options.manifest }),
        );
      },
    );

  epub
    .command('validate')
    .description('Fully validate EPUB ZIP integrity, container, OPF manifest, and spine order.')
    .argument('<source>', 'EPUB path to validate.')
    .action(async (source: string) => {
      await runJsonCommand(output, async () => {
        const result = await validateEpub(source);
        if (!result.valid) output.setExitCode(1);
        return result;
      });
    });
}

async function runJsonCommand(io: EpubCommandIo, operation: () => Promise<unknown>): Promise<void> {
  try {
    const result = await operation();
    io.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    io.setExitCode(1);
    io.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: error instanceof EpubArchiveError ? error.code : 'epub_command_failed',
          message: errorMessage(error),
        },
      })}\n`,
    );
  }
}

function resolveIo(overrides: Partial<EpubCommandIo> | undefined): EpubCommandIo {
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
