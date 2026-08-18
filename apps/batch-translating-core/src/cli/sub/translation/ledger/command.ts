import { runTranslationDomainCli } from '@batch-translating/translation-domain';
import type { Command } from 'commander';

import {
  resolveTranslationIo,
  setTranslationExitCode,
  type TranslationJsonCommandIo,
} from '../io';

export function registerTranslationLedgerCommand(
  parent: Command,
  io?: Partial<TranslationJsonCommandIo>,
): void {
  const output = resolveTranslationIo(io);
  parent
    .command('ledger')
    .description('SQLite/WAL 权威账本 / Authoritative SQLite/WAL translation ledger.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[ledger-args...]', '账本子命令和参数 / Ledger subcommand and arguments.')
    .addHelpText(
      'after',
      [
        '',
        '全局 / Global: --database <absolute.sqlite3>',
        'JSON: --input <file|->（- 从 stdin 读取）；也兼容 --input-file/--json。',
        '',
        '项目 / Project:',
        '  project init --input <json|->',
        '  project status|summary|report-data|integrity --project <id> [--skip-files]',
        '  project completion --project <id> [--input <options.json|->]',
        '源登记 / Source registration:',
        '  source register-item|register-paragraph --input <json|->',
        '任务 / Tasks:',
        '  task ensure|claim|start|complete|fail --input <json|->',
        '  task list|recover --project <id>; task retry --task <id>',
        '指令 / Instructions:',
        '  instruction analyze|apply --input <json|->',
        '  instruction list --project <id>',
        '成本 / Cost and budget:',
        '  cost record --input <json|->',
        '  budget status --project <id>',
        '  budget update --project <id> --input <json|->',
        '',
        '所有成功/失败均输出单行 JSON；失败仅设置退出码，不在库内调用 process.exit。',
        '',
      ].join('\n'),
    )
    .action(async (ledgerArgs: string[]) => {
      try {
        const args = await normalizeJsonInput(ledgerArgs);
        const code = await runTranslationDomainCli(args, {
          stdout: (text) => {
            output.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
          },
          stderr: (text) => {
            output.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
          },
        });
        setTranslationExitCode(output, code);
      } catch (error) {
        output.setExitCode(1);
        output.stderr.write(
          `${JSON.stringify({
            ok: false,
            error: {
              code: 'translation_ledger_bridge_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          })}\n`,
        );
      }
    });
}

async function normalizeJsonInput(args: readonly string[]): Promise<string[]> {
  const normalized = [...args];
  const inlineIndex = normalized.findIndex((value) => value.startsWith('--input='));
  if (inlineIndex >= 0) {
    const inputPath = normalized[inlineIndex]!.slice('--input='.length);
    normalized.splice(inlineIndex, 1, ...(await translatedInputArguments(inputPath)));
    return normalized;
  }

  const inputIndex = normalized.indexOf('--input');
  if (inputIndex < 0) return normalized;
  const inputPath = normalized[inputIndex + 1];
  if (!inputPath || inputPath.startsWith('--')) {
    throw new Error('--input requires a JSON file path or - for stdin');
  }
  normalized.splice(inputIndex, 2, ...(await translatedInputArguments(inputPath)));
  return normalized;
}

async function translatedInputArguments(inputPath: string): Promise<string[]> {
  if (inputPath !== '-') return ['--input-file', inputPath];
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const json = Buffer.concat(chunks).toString('utf8');
  if (!json.trim()) throw new Error('stdin JSON input is empty');
  // Parse once at the bridge so invalid stdin never reaches the ledger and so the
  // exact canonical JSON value is passed as a single SEA argv entry.
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid stdin JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ['--json', JSON.stringify(value)];
}
