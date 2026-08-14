/**
 * `agentLifecycle` domain — builtin agent profile contributions.
 *
 * Registers the default `agent`, software task-agent, and batch-translation
 * profiles. Each profile is self-contained: its structured `renderSystemPrompt`
 * merges the shared base template or translation contract with its own role
 * text at call time, so a child agent never inherits its parent's prompt.
 */

import { collectGitContext } from './gitContext';
import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import {
  renderPromptTemplateResult,
  renderSystemPromptResult,
  skillActiveFor,
  TASK_AGENT_ROLE_PREFIX,
} from '#/app/agentProfileCatalog/profile-shared';

import EXPLORE_ROLE from './explore-overlay.md?raw';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';
import TRANSLATION_SHARED from './translation-shared.md?raw';
import TRANSLATION_MAIN_ROLE from './translation-main.md?raw';
import TRANSLATOR_ROLE from './translation-translator.md?raw';
import REVIEWER_ROLE from './translation-reviewer.md?raw';
import REPAIRER_ROLE from './translation-repairer.md?raw';
import CONTINUITY_AUDITOR_ROLE from './translation-continuity-auditor.md?raw';

const AGENT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'TaskList',
  'TaskOutput',
  'TaskStop',
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
] as const;

const CODER_TOOLS = [
  'Agent',
  'AgentSwarm',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'Read',
  'Skill',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TodoList',
  'WebSearch',
  'FetchURL',
  'Write',
] as const;

const EXPLORE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
] as const;

const TRANSLATION_ORCHESTRATOR_TOOLS = ['Read', 'Write', 'Bash', 'AgentSwarm'] as const;

const TRANSLATION_WORKER_TOOLS = ['Read', 'Write', 'Bash'] as const;

const TRANSLATION_SUBAGENTS = [
  'translator',
  'reviewer',
  'repairer',
  'continuity-auditor',
] as const;

const CODER_ROLE =
  `${TASK_AGENT_ROLE_PREFIX}\n\n` +
  'Your final message is the entire handoff - the parent sees nothing else from your run. ' +
  'Make it complete: what you translated or changed and why, the path of every file you touched, ' +
  'how you verified the result (spot-checks against the source, searches for terminology ' +
  'consistency, structure checks), and anything left undone or worth follow-up. ' +
  'A final message of only a sentence or two is treated as too brief and sent back to you ' +
  'for expansion, costing an extra turn.';

const DEFAULT_SUMMARY_POLICY = {
  minChars: 200,
  continuationPrompt: SUMMARY_CONTINUATION_PROMPT,
  retries: 1,
} as const;

const AGENT_ROLE =
  'You are the main workbench assistant of a batch translation application. ' +
  'The user works with book-length documents (EPUB/TXT) and expects faithful, ' +
  'natural, terminologically consistent translations. When the user asks for ' +
  'translation work, follow the project plan and pipeline state in the workspace ' +
  'instead of improvising; delegate bounded work units to subagents when the ' +
  'volume warrants it, and keep the user informed of progress in their language.';

registerAgentProfile({
  name: 'agent',
  description: 'Default agent - batch-translation workbench assistant',
  tools: AGENT_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(AGENT_ROLE, context, { skillActive: skillActiveFor(AGENT_TOOLS) }),
});

registerAgentProfile({
  name: 'coder',
  description:
    'General workbench agent with file tools - use it for any delegated task that must read or write files in the translation project.',
  whenToUse:
    'Use this agent for delegated translation-project work: reading source material, drafting or patching translation records, checking terminology consistency, and returning a compact but complete summary to the parent agent.',
  tools: CODER_TOOLS,
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(CODER_ROLE, context, { skillActive: skillActiveFor(CODER_TOOLS) }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'batch-translator',
  description:
    'Batch-translation orchestrator for resumable EPUB projects with application-locked stages and rounds.',
  whenToUse:
    'Use only as the main agent of the batch translation application. It parses EPUB containers, coordinates fixed translation and review passes, validates artifacts, and delegates bounded work through AgentSwarm.',
  tools: TRANSLATION_ORCHESTRATOR_TOOLS,
  subagents: TRANSLATION_SUBAGENTS,
  renderSystemPrompt: (context) =>
    renderPromptTemplateResult(`${TRANSLATION_SHARED}\n\n${TRANSLATION_MAIN_ROLE}`, context, {
      skillActive: false,
    }),
});

registerAgentProfile({
  name: 'translator',
  description:
    'EPUB novel translator that produces paragraph-ID-addressed Simplified Chinese records without editing shared files.',
  whenToUse:
    'Use for exactly one application-scheduled translation work unit in the declared translation pass. Supply the chapter or block inputs, constraints, pass identifier, and private output path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderPromptTemplateResult(`${TRANSLATION_SHARED}\n\n${TRANSLATOR_ROLE}`, context, {
      skillActive: false,
    }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'reviewer',
  description:
    'Independent translation reviewer that emits evidence-backed issue records and never edits translations.',
  whenToUse:
    'Use for one application-scheduled review work unit and only the declared review scopes, such as fidelity or Chinese naturalness. Supply immutable source and translation inputs plus a private issue output path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderPromptTemplateResult(`${TRANSLATION_SHARED}\n\n${REVIEWER_ROLE}`, context, {
      skillActive: false,
    }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'repairer',
  description:
    'Constrained translation repair and conflict-arbitration agent that emits paragraph patches only.',
  whenToUse:
    'Use after a selected review pass for one bounded issue set, or in explicit arbitration mode for conflicting patches. Supply all evidence and a private patch output path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderPromptTemplateResult(`${TRANSLATION_SHARED}\n\n${REPAIRER_ROLE}`, context, {
      skillActive: false,
    }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'continuity-auditor',
  description:
    'Story-memory extractor and optional retrieval-driven whole-book continuity auditor; never edits translations.',
  whenToUse:
    'Use in story-memory mode for application-scheduled pre-translation analysis, or in consistency-audit mode only when the run plan explicitly enables consistency review. Supply the declared mode, bounded inputs, provenance requirements, and private output path.',
  tools: TRANSLATION_WORKER_TOOLS,
  subagents: [],
  renderSystemPrompt: (context) =>
    renderPromptTemplateResult(`${TRANSLATION_SHARED}\n\n${CONTINUITY_AUDITOR_ROLE}`, context, {
      skillActive: false,
    }),
  summaryPolicy: DEFAULT_SUMMARY_POLICY,
});

registerAgentProfile({
  name: 'explore',
  description: 'Fast read-only file exploration for translation projects.',
  whenToUse:
    'Fast agent specialized for exploring the translation project. Use this when you need to quickly find files by patterns (e.g. "chapters/**/*.txt"), search translation records for keywords (e.g. a character name), or answer questions about the project structure and state. When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "thorough" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.',
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
