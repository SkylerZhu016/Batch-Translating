import type { Command } from 'commander';

import {
  registerTranslationEpubSubcommands,
  type EpubCommandIo,
} from './epub/command';
import { registerTranslationTxtCommand, type TxtCommandIo } from './txt/command';

export type TranslationCommandIo = Partial<EpubCommandIo & TxtCommandIo>;

export function registerTranslationCommand(
  parent: Command,
  io?: TranslationCommandIo,
): void {
  const translation = parent.command('translation', { hidden: true });
  registerTranslationEpubSubcommands(translation, io);
  registerTranslationTxtCommand(translation, io);
}
