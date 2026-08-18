/**
 * `agentLifecycle` domain — builtin agent profile contributions.
 *
 * Registers the default `agent` profile plus the `coder` / `explore` task-agent
 * profiles. Each profile is self-contained: its structured `renderSystemPrompt`
 * merges the shared base template with its own role text at call time, so a
 * child agent no longer inherits the parent's prompt through a runtime overlay.
 */

import { collectGitContext } from './gitContext';
import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import {
  renderSystemPromptResult,
  skillActiveFor,
  TASK_AGENT_ROLE_PREFIX,
} from '#/app/agentProfileCatalog/profile-shared';

import EXPLORE_ROLE from './explore-overlay.md?raw';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';

const AGENT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Bash',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'CronCreate',
  'CronList',
  'CronDelete',
  'ReadMediaFile',
  'TodoList',
  'Skill',
  'WebSearch',
  'Agent',
  'AgentSwarm',
  'FetchURL',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'mcp__*',
] as const;

const CODER_TOOLS = [
  'Agent',
  'AgentSwarm',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'Read',
  'ReadMediaFile',
  'Skill',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TodoList',
  'WebSearch',
  'FetchURL',
  'Write',
  'mcp__*',
] as const;

const EXPLORE_TOOLS = [
  'Bash',
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
] as const;

const CODER_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'Your final message is the entire handoff — the parent sees nothing else from your run. ' +
  'Make it technically complete: what you changed and why, the path of every file you touched, ' +
  'how you verified the change (tests or commands run, with results), and anything left undone ' +
  'or worth follow-up. A final message of only a sentence or two is treated as too brief and ' +
  'sent back to you for expansion, costing an extra turn.';

const DEFAULT_SUMMARY_POLICY = {
  minChars: 200,
  continuationPrompt: SUMMARY_CONTINUATION_PROMPT,
  retries: 1,
} as const;

const TRANSLATION_COORDINATOR_ROLE = [
  'You are the first-party translation coordinator for a long-running book translation project.',
  'The session goal, the user\'s latest instructions, the pinned model, the selected quality gates, the budget, and the durable project ledger are authoritative.',
  'Plan and delegate work autonomously, but keep a single Coordinator responsible for task ownership, artifact acceptance, and the final merge.',
  'An ordinary user message is live steering in this same session, not a cancellation signal. Acknowledge what changed, explain the affected scope and cost impact, preserve unrelated valid work, and continue the long-term goal without requiring another “continue” message.',
  'Only an explicit Stop or Cancel action authorizes hard cancellation. Otherwise finish the smallest safe atomic unit, stop assigning affected work, persist valid output, and re-plan.',
  'Never silently merge an artifact produced for stale source, context, prompt, or instruction versions. Never claim a quality gate passed when its evidence or required capability is missing.',
  'Do not replace the durable ledger with a fixed prompt-stage script. Use the available tools and subagents according to the current goal and ledger state, and report a genuine blocked state when safe progress is impossible.',
].join('\n\n');

registerAgentProfile({
  name: 'agent',
  description: 'Default agent',
  tools: AGENT_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult('', context, { skillActive: skillActiveFor(AGENT_TOOLS) }),
});

registerAgentProfile({
  name: 'translation-coordinator',
  description: 'Long-running translation Coordinator using the native session, goal, task, and event loop.',
  tools: AGENT_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(TRANSLATION_COORDINATOR_ROLE, context, {
      skillActive: skillActiveFor(AGENT_TOOLS),
    }),
});

registerAgentProfile({
  name: 'coder',
  description:
    'General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code.',
  whenToUse:
    'Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.',
  tools: CODER_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(CODER_ROLE, context, { skillActive: skillActiveFor(CODER_TOOLS) }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'explore',
  description: 'Fast codebase exploration with prompt-enforced read-only behavior.',
  whenToUse:
    'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. "src/**/*.yaml"), search code for keywords (e.g. "database connection"), or answer questions about the codebase (e.g. "how does the auth module work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "thorough" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.',
  tools: EXPLORE_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(EXPLORE_ROLE, context, { skillActive: skillActiveFor(EXPLORE_TOOLS) }),
  promptPrefix: async ({ cwd, runner, log }) => {
    try {
      return await collectGitContext(runner, cwd, log);
    } catch {
      return '';
    }
  },
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});
