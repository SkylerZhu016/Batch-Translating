/**
 * `sessionInit` domain — `/init` brief and completion reminder.
 *
 * Verbatim brief handed to the `coder` subagent that orients itself in the
 * translation project (`DEFAULT_INIT_PROMPT`), and the system reminder
 * appended to the main agent once `/init` finishes (`initCompletionReminder`),
 * which carries the freshly loaded project summary content back into the main
 * conversation. Pure constants/functions — no scoped state.
 */

import initMd from './init.md?raw';

export const DEFAULT_INIT_PROMPT = initMd;

export function initCompletionReminder(agentsMd: string): string {
  const latest =
    agentsMd.trim().length === 0
      ? 'No project summary content was found after `/init` completed.'
      : agentsMd;
  return [
    'The user just ran the `/init` project-orientation pass.',
    'The system has explored the translation project and produced a summary.',
    '',
    'Latest project summary content:',
    latest,
  ].join('\n');
}
