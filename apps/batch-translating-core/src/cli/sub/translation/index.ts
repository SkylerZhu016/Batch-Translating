import type { Command } from 'commander';

import {
  registerTranslationEpubSubcommands,
  type EpubCommandIo,
} from './epub/command';
import { registerTranslationLedgerCommand } from './ledger/command';
import type { TranslationJsonCommandIo } from './io';
import { registerTranslationProjectCommand } from './project/command';
import { registerTranslationRagCommand } from './rag/command';
import { registerTranslationToolsCommand } from './tools/command';
import { registerTranslationTxtCommand, type TxtCommandIo } from './txt/command';

export type TranslationCommandIo = Partial<
  EpubCommandIo & TxtCommandIo & TranslationJsonCommandIo
>;

export function registerTranslationCommand(
  parent: Command,
  io?: TranslationCommandIo,
): void {
  const translation = parent
    .command('translation')
    .description('批量翻译工程命令 / Auditable batch translation project commands.');
  registerTranslationEpubSubcommands(translation, io);
  registerTranslationTxtCommand(translation, io);
  registerTranslationLedgerCommand(translation, io);
  registerTranslationToolsCommand(translation, io);
  registerTranslationRagCommand(translation, io);
  registerTranslationProjectCommand(translation, io);
}
