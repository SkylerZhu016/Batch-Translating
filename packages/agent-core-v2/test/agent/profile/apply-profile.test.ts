import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { BUILTIN_SKILL_SOURCE_ID } from '#/app/skillCatalog/skillSource';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { DEFAULT_PRODUCT_NAME } from '#/app/agentProfileCatalog/profile-shared';

import { stubAgentIdentity } from '../../app/agentIdentity/stubs';

import {
  appService,
  createTestAgent,
  execEnvServices,
  hostEnvironmentServices,
  sessionService,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

const profile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'agents-profile',
  systemPrompt: (context) =>
    typeof context['agentsMd'] === 'string' ? (context['agentsMd'] as string) : '',
  tools: [],
});

const skillsProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'skills-profile',
  systemPrompt: (context) => `skills:${context.skills ?? ''}`,
  tools: ['Skill'],
});

const exactProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'exact-profile',
  systemPrompt: (context) =>
    [
      `cwd:${context.cwd ?? ''}`,
      `os:${context.osKind ?? ''}`,
      `shell:${context.shellName ?? ''}:${context.shellPath ?? ''}`,
      `agents:${context.agentsMd ?? ''}`,
      `ls:${context.cwdListing ?? ''}`,
      `extra:${context.additionalDirsInfo ?? ''}`,
    ].join('\n'),
  tools: ['Read', 'Write'],
});

describe('AgentProfileService.applyProfile', () => {
  let ctx: TestAgentContext;
  let homeDir: string;
  let workDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-apply-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-apply-work-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  function buildContext(
    ...extra: readonly (TestAgentServiceOverride | TestAgentOptions)[]
  ): { ctx: TestAgentContext; profile: IAgentProfileService } {
    const fs = new HostFileSystem();
    ctx = createTestAgent(
      execEnvServices({ hostFs: fs }),
      hostEnvironmentServices(homeDir),
      { cwd: workDir },
      ...extra,
    );
    return { ctx, profile: ctx.get(IAgentProfileService) };
  }

  describe('custom identity', () => {
    // The default builtin profile opens with `You are ${product_name}`.
    const selfNaming: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'self-naming',
      systemPrompt: (context) => `You are ${context.productName ?? DEFAULT_PRODUCT_NAME}`,
      tools: [],
    });

    it('names the agent after the configured identity', async () => {
      const { profile: svc } = buildContext(
        appService(IAgentIdentity, stubAgentIdentity({ displayName: 'Acme Dev', slug: 'acme' })),
      );

      await svc.applyProfile(selfNaming);

      expect(svc.data().systemPrompt).toBe('You are Acme Dev');
    });

    it('keeps the built-in product name when no identity is configured', async () => {
      const { profile: svc } = buildContext(
        appService(IAgentIdentity, stubAgentIdentity()),
      );

      await svc.applyProfile(selfNaming);

      expect(svc.data().systemPrompt).toBe(`You are ${DEFAULT_PRODUCT_NAME}`);
    });
  });

  it('loads AGENTS.md into the rendered system prompt', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.data().systemPrompt).toContain('project instructions');
    expect(svc.data().systemPrompt).toContain(`<!-- From: ${join(workDir, 'AGENTS.md')} -->`);
    expect(svc.getAgentsMdWarning()).toBeUndefined();
  });

  it('renders the complete runtime context exactly', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(exactProfile);

    expect(svc.data().systemPrompt).toBe(exactSystemPrompt(workDir, 'project instructions'));
  });

  it('refreshes the active profile system prompt exactly without resetting active tools', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'old instructions', 'utf-8');
    const { profile: svc } = buildContext();
    await svc.applyProfile(exactProfile);
    svc.update({ activeToolNames: ['Read'] });
    await writeFile(join(workDir, 'AGENTS.md'), 'new instructions', 'utf-8');

    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe(exactSystemPrompt(workDir, 'new instructions'));
    expect(svc.getActiveToolNames()).toEqual(['Read']);
  });

  it('caches an agents-md warning when the content exceeds the 32 KB soft budget', async () => {
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');
    const { ctx: context, profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.data().systemPrompt).toContain(largeContent);
    const warning = svc.getAgentsMdWarning();
    expect(warning).toBeDefined();
    expect(warning).toContain('exceeds the recommended');

    const events = context.newEvents() as readonly {
      event: string;
      args?: { code?: string };
    }[];
    expect(
      events.some(
        (entry) => entry.event === 'warning' && entry.args?.code === 'agents-md-oversized',
      ),
    ).toBe(true);
  });

  it('does not cache a warning when the content is within the budget', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.getAgentsMdWarning()).toBeUndefined();
  });

  // The builtin source changes only when its config switch is toggled, so it
  // shares the plugin source's refresh. Subscribing to the catalog rather than
  // the config section is what makes the rebuilt prompt see the new listing:
  // the catalog fires after the contribution is replaced.
  it('refreshes the system prompt when the builtin skill source reloads', async () => {
    const change = new Emitter<string>();
    const listing = { value: 'before' };
    const catalog = {
      getModelSkillListing: () => listing.value,
    } as unknown as SkillCatalog;
    const { profile: svc } = buildContext(skillCatalogWithChange(change, catalog));
    await svc.applyProfile(skillsProfile);
    expect(svc.data().systemPrompt).toBe('skills:before');

    listing.value = 'after';
    change.fire(BUILTIN_SKILL_SOURCE_ID);

    await vi.waitFor(() => {
      expect(svc.data().systemPrompt).toBe('skills:after');
    });
    change.dispose();
  });
});

function skillCatalogWithChange(
  change: Emitter<string>,
  catalog: SkillCatalog = new InMemorySkillCatalog(),
): TestAgentServiceOverride {
  return sessionService(ISessionSkillCatalog, {
    _serviceBrand: undefined,
    catalog,
    ready: Promise.resolve(),
    onDidChange: change.event,
    load: async () => {},
    reload: async () => {},
    list: async () => [],
  });
}

function exactSystemPrompt(workDir: string, agentsMd: string): string {
  return [
    `cwd:${workDir}`,
    'os:Linux',
    'shell:bash:/bin/bash',
    `agents:<!-- From: ${join(workDir, 'AGENTS.md')} -->\n${agentsMd}`,
    'ls:\u2514\u2500\u2500 AGENTS.md',
    'extra:',
  ].join('\n');
}
