import type { AppMessage } from '../api/types';

/**
 * Mirror agent-core replay visibility: only real user input (or an explicitly
 * typed slash command) belongs in the conversation transcript. Kimi's goal,
 * permission, interruption and continuation messages are runtime scaffolding.
 */
export function isDisplayableUserMessage(message: AppMessage): boolean {
  const origin = message.metadata?.['origin'] as
    | { kind?: string; trigger?: string }
    | undefined;
  const kind = origin?.kind;
  if (kind === undefined || kind === 'user') return true;
  if (kind === 'skill_activation') return origin?.trigger === 'user-slash';
  if (kind === 'plugin_command') return origin?.trigger === 'user-slash';
  return false;
}

export function isDisplayableConversationMessage(message: AppMessage): boolean {
  if (message.role === 'system') return false;
  return message.role !== 'user' || isDisplayableUserMessage(message);
}
