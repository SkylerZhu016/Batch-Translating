import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTranslationToolsCli } from '@batch-translating/translation-tools';
import type { Command } from 'commander';

import {
  resolveTranslationIo,
  setTranslationExitCode,
  type TranslationJsonCommandIo,
} from '../io';
import { readJsonInput } from '../json-input';

export function registerTranslationToolsCommand(
  parent: Command,
  io?: Partial<TranslationJsonCommandIo>,
): void {
  const output = resolveTranslationIo(io);
  const tools = parent
    .command('tools')
    .description('确定性解析、合并、渲染与校验 / Deterministic source tools.');

  tools
    .command('contracts')
    .description('输出机器可读的 merge/render/report 输入契约 / Print machine-readable input contracts.')
    .action(async () => {
      await runTools(output, ['help']);
    });

  tools
    .command('parse')
    .description('解析 EPUB/TXT 并写出稳定清单 / Parse a source into a stable manifest.')
    .argument('<source>', '源 EPUB/TXT / Source EPUB or TXT.')
    .requiredOption('--out <manifest>', '输出 book_manifest.json / Output manifest.')
    .action(async (source: string, options: { out: string }) => {
      await runTools(output, ['parse', source, '--out', options.out]);
    });

  tools
    .command('copy-source')
    .description('制作只读源快照 / Create an immutable source snapshot.')
    .argument('<source>', '源文件 / Source file.')
    .requiredOption('--out <copy>', '只读副本路径 / Immutable copy path.')
    .option('--expected-sha256 <hash>', '预期源 SHA-256 / Expected source SHA-256.')
    .action(
      async (
        source: string,
        options: { out: string; expectedSha256?: string },
      ) => {
        await runTools(output, [
          'copy-source',
          source,
          '--out',
          options.out,
          ...(options.expectedSha256
            ? ['--expected-sha256', options.expectedSha256]
            : []),
        ]);
      },
    );

  tools
    .command('merge')
    .description('执行确定性译文/修复合并 / Merge audited artifacts deterministically.')
    .requiredOption('--input <json>', '合并输入 JSON / Merge input JSON.')
    .requiredOption('--out <json>', '合并结果 JSON / Merge output JSON.')
    .action(async (options: { input: string; out: string }) => {
      await runTools(output, ['merge', '--input', options.input, '--out', options.out]);
    });

  tools
    .command('render')
    .description('从合并结果重建 EPUB/TXT / Render the final EPUB or TXT.')
    .requiredOption('--input <json>', '渲染输入 JSON / Render input JSON.')
    .option('--out <path>', '覆盖输入中的输出路径 / Override output path.')
    .option('--receipt <json>', '写出产物回执 / Write artifact receipt.')
    .action(
      async (options: { input: string; out?: string; receipt?: string }) => {
        await runTools(output, [
          'render',
          '--input',
          options.input,
          ...(options.out ? ['--out', options.out] : []),
          ...(options.receipt ? ['--receipt', options.receipt] : []),
        ]);
      },
    );

  tools
    .command('validate')
    .description('校验最终 EPUB/TXT / Validate a rendered EPUB or TXT.')
    .argument('<source>', '待校验 EPUB/TXT / Artifact to validate.')
    .option('--out <json>', '写出校验结果 / Write validation result.')
    .action(async (source: string, options: { out?: string }) => {
      await runTools(output, [
        'validate',
        source,
        ...(options.out ? ['--out', options.out] : []),
      ]);
    });

  tools
    .command('report')
    .description('生成确定性技术报告 / Generate a deterministic technical report.')
    .requiredOption('--input <json>', '报告输入 JSON / Report input JSON.')
    .requiredOption('--out <markdown>', '报告输出 Markdown / Report output Markdown.')
    .action(async (options: { input: string; out: string }) => {
      await runTools(output, ['report', '--input', options.input, '--out', options.out]);
    });
}

async function runTools(io: TranslationJsonCommandIo, args: string[]): Promise<void> {
  let temporaryInputPath: string | undefined;
  try {
    const forwarded = [...args];
    const inputIndex = forwarded.indexOf('--input');
    if (inputIndex >= 0 && forwarded[inputIndex + 1] === '-') {
      temporaryInputPath = join(
        tmpdir(),
        `batch-translating-tools-${randomUUID()}.json`,
      );
      await writeFile(
        temporaryInputPath,
        JSON.stringify(await readJsonInput<unknown>('-')),
        { encoding: 'utf8', flag: 'wx' },
      );
      forwarded[inputIndex + 1] = temporaryInputPath;
    }
    setTranslationExitCode(
      io,
      await runTranslationToolsCli(forwarded, {
        stdout: (line) => {
          io.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
        },
        stderr: (line) => {
          io.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
        },
      }),
    );
  } catch (error) {
    io.setExitCode(1);
    io.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: 'translation_tools_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`,
    );
  } finally {
    if (temporaryInputPath) {
      await unlink(temporaryInputPath).catch(() => undefined);
    }
  }
}
