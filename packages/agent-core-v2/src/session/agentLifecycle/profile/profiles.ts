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
import TRANSLATION_CONFLICT_ARBITRATOR_ROLE from './translation-conflict-arbitrator.md?raw';
import TRANSLATION_CONSISTENCY_AUDITOR_ROLE from './translation-consistency-auditor.md?raw';
import TRANSLATION_MEMORY_CONSOLIDATOR_ROLE from './translation-memory-consolidator.md?raw';
import TRANSLATION_MEMORY_EXTRACTOR_ROLE from './translation-memory-extractor.md?raw';
import TRANSLATION_REPAIRER_ROLE from './translation-repairer.md?raw';
import TRANSLATION_REVIEWER_CONTINUITY_ROLE from './translation-reviewer-continuity.md?raw';
import TRANSLATION_REVIEWER_FIDELITY_ROLE from './translation-reviewer-fidelity.md?raw';
import TRANSLATION_REVIEWER_NATURALNESS_ROLE from './translation-reviewer-naturalness.md?raw';
import TRANSLATION_TRANSLATOR_ROLE from './translation-translator.md?raw';
import TRANSLATION_WORKER_SHARED from './translation-worker-shared.md?raw';

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

const TRANSLATION_COORDINATOR_TOOLS = [
  'Read',
  'Write',
  'Bash',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'Agent',
  'AgentSwarm',
  'AskUserQuestion',
  'GetGoal',
  'UpdateGoal',
] as const;

const TRANSLATION_WORKER_TOOLS = ['Read', 'Write', 'Bash'] as const;

const TRANSLATION_SUBAGENTS = [
  'memory-extractor',
  'memory-consolidator',
  'translator',
  'reviewer-fidelity',
  'reviewer-naturalness',
  'reviewer-continuity',
  'repairer',
  'conflict-arbitrator',
  'consistency-auditor',
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
  'You are the only translation scheduler. Delegate bounded semantic work only to the allowlisted translation profiles; those workers never delegate recursively, publish shared state, or decide task acceptance.',
  'Keep the provider and model pinned by the project. Never browse the web, call MCP, or silently switch models. Shared translation state is published only by deterministic ledger and merge tools after version, hash, and quality-gate validation.',
  'Never silently merge an artifact produced for stale source, context, prompt, or instruction versions. Never claim a quality gate passed when its evidence or required capability is missing.',
  'Do not replace the durable ledger with a fixed prompt-stage script. Use the available tools and subagents according to the current goal and ledger state, and report a genuine blocked state when safe progress is impossible.',
].join('\n\n');

const translationWorkerRole = (role: string): string =>
  `${TASK_AGENT_ROLE_PREFIX}\n\n${TRANSLATION_WORKER_SHARED}\n\n${role}`;

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
  tools: TRANSLATION_COORDINATOR_TOOLS,
  subagents: TRANSLATION_SUBAGENTS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(TRANSLATION_COORDINATOR_ROLE, context, {
      skillActive: skillActiveFor(TRANSLATION_COORDINATOR_TOOLS),
    }),
});

registerAgentProfile({
  name: 'memory-extractor',
  description: 'Extracts provenance-rich, spoiler-safe Story Memory from one bounded source range.',
  whenToUse:
    'Use for one ledger-assigned memory extraction task after deterministic source parsing. Supply stable paragraph IDs, hashes, chronology, schema, and a private artifact path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(translationWorkerRole(TRANSLATION_MEMORY_EXTRACTOR_ROLE), context, {
      skillActive: skillActiveFor(TRANSLATION_WORKER_TOOLS),
    }),
});

registerAgentProfile({
  name: 'memory-consolidator',
  description: 'Consolidates extracted memories into auditable canonical-state proposals without publishing them.',
  whenToUse:
    'Use for one ledger-assigned consolidation batch whose immutable memory inputs share a book, schema, and accepted source version.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(translationWorkerRole(TRANSLATION_MEMORY_CONSOLIDATOR_ROLE), context, {
      skillActive: skillActiveFor(TRANSLATION_WORKER_TOOLS),
    }),
});

registerAgentProfile({
  name: 'translator',
  description: 'Produces paragraph-ID-addressed literary translations from a minimal, spoiler-safe context.',
  whenToUse:
    'Use for exactly one ledger-assigned translation chunk. Supply immutable source/context, accepted constraints, task versions, schema, and a private artifact path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(translationWorkerRole(TRANSLATION_TRANSLATOR_ROLE), context, {
      skillActive: skillActiveFor(TRANSLATION_WORKER_TOOLS),
    }),
});

registerAgentProfile({
  name: 'reviewer-fidelity',
  description: 'Independently diagnoses source-to-target fidelity defects and emits issue records only.',
  whenToUse:
    'Use for one bounded fidelity review task with immutable source, current translation, hashes, and a private issue-artifact path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(translationWorkerRole(TRANSLATION_REVIEWER_FIDELITY_ROLE), context, {
      skillActive: skillActiveFor(TRANSLATION_WORKER_TOOLS),
    }),
});

registerAgentProfile({
  name: 'reviewer-naturalness',
  description: 'Reviews target-language literary naturalness and emits evidence-backed issue records only.',
  whenToUse:
    'Use for one bounded naturalness review task with the current accepted translation, source guardrails, voice context, and a private issue-artifact path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(translationWorkerRole(TRANSLATION_REVIEWER_NATURALNESS_ROLE), context, {
      skillActive: skillActiveFor(TRANSLATION_WORKER_TOOLS),
    }),
});

registerAgentProfile({
  name: 'reviewer-continuity',
  description: 'Checks bounded cross-passage continuity with spoiler-safe canonical and memory evidence.',
  whenToUse:
    'Use for one local continuity review task with explicit chapter bounds, stable IDs, canonical versions, memory IDs, and a private issue-artifact path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(translationWorkerRole(TRANSLATION_REVIEWER_CONTINUITY_ROLE), context, {
      skillActive: skillActiveFor(TRANSLATION_WORKER_TOOLS),
    }),
});

registerAgentProfile({
  name: 'repairer',
  description: 'Produces minimal hash-guarded patches for accepted issues without editing translations.',
  whenToUse:
    'Use for one bounded accepted-issue set with immutable evidence, the current translation and hash, schema, and a private patch-artifact path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(translationWorkerRole(TRANSLATION_REPAIRER_ROLE), context, {
      skillActive: skillActiveFor(TRANSLATION_WORKER_TOOLS),
    }),
});

registerAgentProfile({
  name: 'conflict-arbitrator',
  description: 'Arbitrates one competing-patch set into a unique auditable decision; never last-write-wins.',
  whenToUse:
    'Use only when deterministic merge detects multiple patches for the same stable ID. Supply the complete conflict set, evidence, current hash, schema, and a private decision-artifact path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(translationWorkerRole(TRANSLATION_CONFLICT_ARBITRATOR_ROLE), context, {
      skillActive: skillActiveFor(TRANSLATION_WORKER_TOOLS),
    }),
});

registerAgentProfile({
  name: 'consistency-auditor',
  description: 'Audits one whole-book consistency partition and emits review-compatible issues only.',
  whenToUse:
    'Use for one ledger-assigned entity, terminology, callback, item, relationship, or voice partition with bounded retrieval evidence and a private issue-artifact path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(translationWorkerRole(TRANSLATION_CONSISTENCY_AUDITOR_ROLE), context, {
      skillActive: skillActiveFor(TRANSLATION_WORKER_TOOLS),
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
