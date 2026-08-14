import type { GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

// ── `/goal` command grammar (headless subset) ──────────────────────────────
// The interactive TUI is not part of Batch Translating, but the headless
// prompt path still accepts `/goal <objective>` syntax. The parser below is
// the deterministic grammar from the removed TUI command module.

export type ParsedGoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'create';
      readonly objective: string;
      readonly replace: boolean;
    }
  | { readonly kind: 'next-add'; readonly objective: string }
  | { readonly kind: 'next-manage' }
  | { readonly kind: 'error'; readonly message: string; readonly severity?: 'error' | 'hint' };

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
const CONTROL_SUBCOMMANDS = new Set(['pause', 'resume', 'cancel']);

/**
 * Parses the deterministic `/goal` command grammar. Reserved subcommands
 * (`pause`/`resume`/`cancel`/`status`/`replace`) are only honored as the first
 * token; use `/goal -- <objective>` to start a goal whose text begins with one
 * of those words.
 */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return { kind: 'status' };

  const tokens = args.split(/\s+/);
  const first = tokens[0];
  if (first === 'next') {
    return parseNextGoalCommand(tokens);
  }
  if (first !== undefined && CONTROL_SUBCOMMANDS.has(first) && tokens.length === 1) {
    return { kind: first as 'pause' | 'resume' | 'cancel' };
  }

  let index = 0;
  let replace = false;
  if (tokens[index] === 'replace') {
    replace = true;
    index += 1;
  }
  // `--` ends subcommand parsing so an objective can begin with a reserved word
  // (e.g. `/goal -- pause the rollout`).
  if (tokens[index] === '--') {
    index += 1;
  }

  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    return {
      kind: 'error',
      severity: 'hint',
      message: 'Provide a goal objective, e.g. `/goal Ship feature X`.',
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      message: `Goal objective is too long (max ${MAX_GOAL_OBJECTIVE_LENGTH} characters). Reference long details by file path.`,
    };
  }
  return { kind: 'create', objective, replace };
}

function parseNextGoalCommand(tokens: readonly string[]): ParsedGoalCommand {
  if (tokens.length === 2 && tokens[1] === 'manage') return { kind: 'next-manage' };
  let index = 1;
  if (tokens[index] === '--') index += 1;
  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    return {
      kind: 'error',
      severity: 'hint',
      message:
        'Provide an upcoming goal objective, e.g. `/goal next Ship feature X`, or use `/goal next manage`.',
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      message: `Goal objective is too long (max ${MAX_GOAL_OBJECTIVE_LENGTH} characters). Reference long details by file path.`,
    };
  }
  return { kind: 'next-add', objective };
}

/**
 * Headless goal-mode support for the `kimi -p "/goal <objective>"` prompt path.
 *
 * The goal driver keeps the prompt's turn-run alive across continuation turns
 * until the goal reaches a terminal state, so the existing prompt-turn waiter
 * already blocks until then. This module adds the create-on-entry parsing, a
 * machine-readable summary, and the terminal-status → exit-code mapping.
 */

export interface HeadlessGoalCreate {
  readonly objective: string;
  readonly replace: boolean;
}

/**
 * Exit codes by final goal status. The lifecycle has only one success outcome
 * (`complete` → 0) and two resumable stopped states: `blocked` (the system
 * stopped pursuing — the model's UpdateGoal, a budget, or an error) and `paused`
 * (a turn abort / SIGINT). Both are non-zero — the goal did not complete. An absent goal
 * (should not happen on the create path) maps to success.
 */
export const GOAL_EXIT_CODES = {
  complete: 0,
  blocked: 3,
  paused: 6,
} as const;

export function goalExitCode(status: string | undefined): number {
  switch (status) {
    case 'blocked':
      return GOAL_EXIT_CODES.blocked;
    case 'paused':
      return GOAL_EXIT_CODES.paused;
    default:
      return GOAL_EXIT_CODES.complete;
  }
}

const GOAL_PREFIX = /^\/goal(\s|$)/;

/**
 * Parses a headless prompt into a goal-create request, or `undefined` when the
 * prompt is not a `/goal` create command (so the caller runs it as a normal
 * prompt). Non-create goal subcommands are not supported headless and fall
 * through to normal prompt handling. Malformed create commands throw instead of
 * falling through, so validation errors are reported before anything is sent to
 * the model.
 */
export function parseHeadlessGoalCreate(prompt: string): HeadlessGoalCreate | undefined {
  const trimmed = prompt.trim();
  if (!GOAL_PREFIX.test(trimmed)) return undefined;
  const args = trimmed.replace(/^\/goal/, '').trim();
  const parsed = parseGoalCommand(args);
  if (parsed.kind === 'error') {
    throw new Error(parsed.message);
  }
  if (parsed.kind !== 'create') return undefined;
  return { objective: parsed.objective, replace: parsed.replace };
}

export interface GoalSummary {
  readonly type: 'goal.summary';
  readonly goalId: string | null;
  readonly status: string | null;
  readonly reason: string | null;
  readonly turnsUsed: number | null;
  readonly tokensUsed: number | null;
  readonly wallClockMs: number | null;
}

export function goalSummaryJson(goal: GoalSnapshot | null): GoalSummary {
  if (goal === null) {
    return {
      type: 'goal.summary',
      goalId: null,
      status: null,
      reason: null,
      turnsUsed: null,
      tokensUsed: null,
      wallClockMs: null,
    };
  }
  return {
    type: 'goal.summary',
    goalId: goal.goalId,
    status: goal.status,
    reason: goal.terminalReason ?? null,
    turnsUsed: goal.turnsUsed,
    tokensUsed: goal.tokensUsed,
    wallClockMs: goal.wallClockMs,
  };
}

export function formatGoalSummaryText(goal: GoalSnapshot | null): string {
  if (goal === null) return 'Goal: no goal found.';
  const parts = [`Goal [${goal.status}]`];
  if (goal.terminalReason !== undefined) parts.push(goal.terminalReason);
  return `${parts.join(': ')} (turns: ${goal.turnsUsed}, tokens: ${goal.tokensUsed})`;
}
