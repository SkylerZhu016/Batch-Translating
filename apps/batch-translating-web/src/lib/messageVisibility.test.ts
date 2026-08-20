import { describe, expect, it } from 'vitest';
import type { AppMessage } from '../api/types';
import {
  isDisplayableConversationMessage,
  isDisplayableUserMessage,
} from './messageVisibility';

function message(
  role: AppMessage['role'],
  origin?: { kind?: string; trigger?: string },
): AppMessage {
  return {
    id: `${role}:${origin?.kind ?? 'none'}`,
    sessionId: 'session-1',
    role,
    content: [{ type: 'text', text: 'content' }],
    createdAt: '2026-08-21T00:00:00.000Z',
    ...(origin === undefined ? {} : { metadata: { origin } }),
  };
}

describe('conversation message visibility', () => {
  it('keeps real user and assistant messages', () => {
    expect(isDisplayableUserMessage(message('user'))).toBe(true);
    expect(isDisplayableUserMessage(message('user', { kind: 'user' }))).toBe(true);
    expect(isDisplayableConversationMessage(message('assistant'))).toBe(true);
  });

  it('hides Kimi runtime injections and system-triggered continuation prompts', () => {
    expect(isDisplayableConversationMessage(message('user', { kind: 'injection' }))).toBe(false);
    expect(isDisplayableConversationMessage(message('user', { kind: 'system_trigger' }))).toBe(false);
    expect(isDisplayableConversationMessage(message('system'))).toBe(false);
  });

  it('keeps only user-typed skill and plugin commands', () => {
    expect(isDisplayableUserMessage(message('user', {
      kind: 'skill_activation',
      trigger: 'user-slash',
    }))).toBe(true);
    expect(isDisplayableUserMessage(message('user', {
      kind: 'plugin_command',
      trigger: 'system',
    }))).toBe(false);
  });
});
