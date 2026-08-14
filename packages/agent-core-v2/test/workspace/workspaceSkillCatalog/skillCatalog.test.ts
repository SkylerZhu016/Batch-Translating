/**
 * Scenario: workspace skill-source discovery and merge.
 *
 * Exercises the real Workspace-scoped catalog and source services with
 * filesystem or in-memory discovery boundaries, including controlled
 * concurrent refreshes and the fs-watch-driven single-source rescan.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/workspaceSkillCatalog/skillCatalog.test.ts`.
 */

import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { beforeEach, describe, expect, it } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFsWatchService, type HostFsChange, type IHostFsWatchHandle } from '#/os/interface/hostFsWatch';
import { IAppStateService } from '#/app/state/appState';
import { AppStateService } from '#/app/state/appStateService';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IConfigService } from '#/app/config/config';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
} from '#/app/skillCatalog/configSection';
import { BuiltinSkillSource, IBuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { IUserFileSkillSource, UserFileSkillSource } from '#/app/skillCatalog/userFileSkillSource';
import { InMemorySkillDiscovery } from '#/app/skillCatalog/inMemorySkillDiscovery';
import { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
import {
  WorkspaceSkillCatalogService,
  workspaceSkillCatalogContributionsKey,
  workspaceSkillCatalogMergedKey,
} from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalogService';
import { ExplicitFileSkillSource, IExplicitFileSkillSource } from '#/workspace/workspaceSkillCatalog/explicitFileSkillSource';
import { ExtraFileSkillSource, IExtraFileSkillSource } from '#/workspace/workspaceSkillCatalog/extraFileSkillSource';
import { IWorkspaceRootSkillSource, WorkspaceRootSkillSource } from '#/workspace/workspaceSkillCatalog/rootFileSkillSource';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { FileSkillDiscovery } from '#/app/skillCatalog/fileSkillDiscovery';
import type { SkillRoot } from '#/app/skillCatalog/types';
import { ILogService } from '#/_base/log/log';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubSkill } from '../../app/skillCatalog/stubs';
import { stubLog } from '../../_base/log/stubs';

const bootstrapStub = stubBootstrap('/home');

function configStub(): IConfigService & {
  setExtraSkillDirs(dirs: readonly string[]): void;
  setMergeAllAvailableSkills(value: boolean): void;
  fireSectionChange(domain: string): void;
} {
  let extraSkillDirs: readonly string[] = [];
  let mergeAllAvailableSkills = true;
  const sectionChangeListeners: Array<(event: unknown) => void> = [];
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: (listener: (event: unknown) => void) => {
      sectionChangeListeners.push(listener);
      return { dispose: () => {} };
    },
    get: (domain: string) => {
      if (domain === EXTRA_SKILL_DIRS_SECTION) return [...extraSkillDirs];
      if (domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) return mergeAllAvailableSkills;
      return undefined;
    },
    inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: undefined }),
    getAll: () => ({}),
    set: async () => {},
    replace: async () => {},
    reload: async () => {},
    diagnostics: () => [],
    setExtraSkillDirs: (dirs: readonly string[]) => {
      extraSkillDirs = [...dirs];
    },
    setMergeAllAvailableSkills: (value: boolean) => {
      mergeAllAvailableSkills = value;
    },
    fireSectionChange: (domain: string) => {
      for (const listener of sectionChangeListeners) {
        listener({ domain, source: 'set', value: undefined, previousValue: undefined });
      }
    },
  } as unknown as IConfigService & {
    setExtraSkillDirs(dirs: readonly string[]): void;
    setMergeAllAvailableSkills(value: boolean): void;
    fireSectionChange(domain: string): void;
  };
}

function workspaceContextStub(workDir: string): IWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workspaceId: 'wd_test',
    cwd: workDir,
    source: 'local',
    meta: { id: 'wd_test', root: workDir, name: 'test', createdAt: 0, lastOpenedAt: 0 },
    persistenceScope: `sessions/wd_test`,
    osBackendId: 'local',
    persistenceBackendId: 'local',
  };
}

function fsWatchStub(): IHostFsWatchService {
  return {
    _serviceBrand: undefined,
    watch: (): IHostFsWatchHandle => ({
      onDidChange: Event.None as Event<HostFsChange>,
      dispose: () => {},
    }),
  };
}

function makeHost(
  store: ISkillDiscovery,
  ws: IWorkspaceContext,
  explicitDirs?: readonly string[],
) {
  const config = configStub();
  const host = createScopedTestHost([
    stubPair(ISkillDiscovery, store),
    stubPair(IBootstrapService, stubBootstrap('/home', {}, { skillDirs: explicitDirs })),
    stubPair(IConfigService, config),
    stubPair(IHostFsWatchService, fsWatchStub()),
  ]);
  const workspace = host.child(LifecycleScope.Workspace, 'w1', [stubPair(IWorkspaceContext, ws)]);
  return { host, workspace, config };
}

function waitForEvents(event: Event<unknown>, count: number): Promise<void> {
  return new Promise((resolve) => {
    let received = 0;
    const disposable = event(() => {
      received += 1;
      if (received === count) {
        disposable.dispose();
        resolve();
      }
    });
  });
}

async function withSkillCatalogWorkspace(
  run: (fixture: { readonly workDir: string; readonly skillRoot: string }) => Promise<void>,
): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'skill-catalog-'));
  const skillRoot = join(workDir, '.kimi-code', 'skills');
  await mkdir(skillRoot, { recursive: true });
  try {
    await run({ workDir, skillRoot: await realpath(skillRoot) });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

describe('WorkspaceSkillCatalogService', () => {
  beforeEach(() => {
    // Keep the scoped registry limited to the catalog chain these tests
    // exercise so unrelated OnScopeCreated registrations do not run; every
    // other dependency arrives as a seeded stub via `createScopedTestHost`.
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IBuiltinSkillSource, BuiltinSkillSource);
    registerScopedService(LifecycleScope.App, IUserFileSkillSource, UserFileSkillSource);
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceSkillCatalog,
      WorkspaceSkillCatalogService,
    );
    registerScopedService(LifecycleScope.Workspace, IExplicitFileSkillSource, ExplicitFileSkillSource);
    registerScopedService(LifecycleScope.Workspace, IExtraFileSkillSource, ExtraFileSkillSource);
    registerScopedService(LifecycleScope.Workspace, IWorkspaceRootSkillSource, WorkspaceRootSkillSource);
    registerScopedService(LifecycleScope.App, IAppStateService, AppStateService);
    registerScopedService(LifecycleScope.Workspace, IWorkspaceStateService, WorkspaceStateService);
  });

  it('merges global and project skills; project wins on name collision', async () => {
    const store = new InMemorySkillDiscovery();
    store.setUserSkills([
      stubSkill('global-only'),
      stubSkill('shared', { description: 'from user' }),
    ]);
    store.setProjectSkills([
      stubSkill('project-only'),
      stubSkill('shared', { description: 'from project' }),
    ]);
    const ws = workspaceContextStub('/work');
    const { host, workspace } = makeHost(store, ws);

    const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
    await catalog.load();

    const names = catalog.catalog.listSkills().map((s) => s.name);
    expect(names).toContain('global-only');
    expect(names).toContain('project-only');
    expect(names).toContain('shared');
    expect(catalog.catalog.getSkill('shared')?.description).toBe('from project');
    host.dispose();
  });

  it('registers contributions and the merged view into the workspace state container', async () => {
    const store = new InMemorySkillDiscovery();
    store.setProjectSkills([stubSkill('project-only')]);
    const ws = workspaceContextStub('/work');
    const { host, workspace } = makeHost(store, ws);

    const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
    await catalog.load();

    const states = workspace.accessor.get(IWorkspaceStateService);
    const contributions = states.get(workspaceSkillCatalogContributionsKey);
    expect([...contributions.keys()]).toContain('workspace');
    expect(states.get(workspaceSkillCatalogMergedKey)).toBe(catalog.catalog);
    // A class instance collapses to a marker in the JSON-safe snapshot.
    expect(states.snapshot()['workspaceSkillCatalog.merged']).toBe('(InMemorySkillCatalog)');
    host.dispose();
  });

  it('orders project, user and extra skills as project > user > extra', async () => {
    const store = new InMemorySkillDiscovery();
    store.setUserSkills([
      stubSkill('shared', { description: 'from user' }),
      stubSkill('user-plugin', { description: 'from user' }),
    ]);
    store.setProjectSkills([stubSkill('shared', { description: 'from project' })]);
    store.setExtraSkills([
      stubSkill('shared', { description: 'from extra', source: 'extra' }),
      stubSkill('user-plugin', { description: 'from extra', source: 'extra' }),
      stubSkill('extra-plugin', { description: 'from extra', source: 'extra' }),
    ]);
    const ws = workspaceContextStub('/work');
    const { host, workspace, config } = makeHost(store, ws);
    config.setExtraSkillDirs(['/']);

    const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
    await catalog.load();

    expect(catalog.catalog.getSkill('shared')?.description).toBe('from project');
    expect(catalog.catalog.getSkill('user-plugin')?.description).toBe('from user');
    expect(catalog.catalog.getSkill('extra-plugin')?.description).toBe('from extra');
    host.dispose();
  });

  it('replaces default user and project discovery with explicitDirs', async () => {
    const store = new InMemorySkillDiscovery();
    store.setUserSkills([stubSkill('from-explicit', { description: 'from explicit' })]);
    store.setProjectSkills([stubSkill('project-only', { description: 'from project' })]);
    store.setExtraSkills([stubSkill('extra-only', { description: 'from extra', source: 'extra' })]);
    const ws = workspaceContextStub('/work');
    const { host, workspace, config } = makeHost(store, ws, ['/']);
    config.setExtraSkillDirs(['/']);

    const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
    await catalog.load();

    expect(catalog.catalog.getSkill('from-explicit')?.description).toBe('from explicit');
    expect(catalog.catalog.getSkill('project-only')).toBeUndefined();
    expect(catalog.catalog.getSkill('extra-only')?.description).toBe('from extra');
    host.dispose();
  });

  it('waits for config ready before loading extra skill dirs', async () => {
    let markReady!: () => void;
    let ready = false;
    const configReady = new Promise<void>((resolve) => {
      markReady = () => {
        ready = true;
        resolve();
      };
    });
    const config = {
      ...configStub(),
      ready: configReady,
      get: (domain: string) => {
        if (domain === EXTRA_SKILL_DIRS_SECTION) return ready ? ['/'] : [];
        if (domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) return true;
        return undefined;
      },
    } as unknown as IConfigService;
    const store = new InMemorySkillDiscovery();
    store.setExtraSkills([stubSkill('extra-only', { description: 'from extra', source: 'extra' })]);
    const ws = workspaceContextStub('/work');
    const host = createScopedTestHost([
      stubPair(ISkillDiscovery, store),
      stubPair(IBootstrapService, bootstrapStub),
      stubPair(IConfigService, config),
      stubPair(IHostFsWatchService, fsWatchStub()),
    ]);
    const workspace = host.child(LifecycleScope.Workspace, 'w1', [stubPair(IWorkspaceContext, ws)]);

    const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
    let settled = false;
    const loading = catalog.load().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    markReady();
    await loading;

    expect(catalog.catalog.getSkill('extra-only')?.description).toBe('from extra');
    host.dispose();
  });

  it('reloads user and workspace sources when mergeAllAvailableSkills changes', async () => {
    class CountingDiscovery implements ISkillDiscovery {
      declare readonly _serviceBrand: undefined;
      calls = 0;
      async discover() {
        this.calls++;
        return { skills: [], skipped: [], scannedRoots: [] };
      }
    }
    const store = new CountingDiscovery();
    const config = configStub();
    const ws = workspaceContextStub('/work');
    const host = createScopedTestHost([
      stubPair(ISkillDiscovery, store),
      stubPair(IBootstrapService, bootstrapStub),
      stubPair(IConfigService, config),
      stubPair(IHostFsWatchService, fsWatchStub()),
    ]);
    const workspace = host.child(LifecycleScope.Workspace, 'w1', [stubPair(IWorkspaceContext, ws)]);

    const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
    await catalog.load();
    const afterLoad = store.calls;

    const reloaded = waitForEvents(catalog.onDidChange, 2);
    config.fireSectionChange(MERGE_ALL_AVAILABLE_SKILLS_SECTION);
    await reloaded;

    expect(store.calls).toBe(afterLoad + 2);
    host.dispose();
  });

  it('reload re-scans every source and replaces the merged view', async () => {
    const store = new InMemorySkillDiscovery();
    store.setUserSkills([stubSkill('global-only')]);
    store.setProjectSkills([stubSkill('first')]);
    const ws = workspaceContextStub('/work1');
    const { host, workspace } = makeHost(store, ws);

    const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
    await catalog.load();
    expect(catalog.catalog.getSkill('first')).toBeDefined();

    store.setProjectSkills([stubSkill('second')]);
    const changes: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => changes.push(sourceId));
    await catalog.reload();

    expect(catalog.catalog.getSkill('first')).toBeUndefined();
    expect(catalog.catalog.getSkill('second')).toBeDefined();
    expect(catalog.catalog.getSkill('global-only')).toBeDefined();
    expect(changes).toEqual(['catalog']);
    subscription.dispose();
    host.dispose();
  });

  it('does not rescan on subsequent load calls without change events', async () => {
    const store = new InMemorySkillDiscovery();
    store.setProjectSkills([stubSkill('first')]);
    const ws = workspaceContextStub('/work');
    const { host, workspace } = makeHost(store, ws);

    const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
    await catalog.load();

    store.setProjectSkills([stubSkill('second')]);
    await catalog.load();

    expect(catalog.catalog.getSkill('first')).toBeDefined();
    expect(catalog.catalog.getSkill('second')).toBeUndefined();
    host.dispose();
  });

  it('feeds scanned roots from file sources into the merged catalog', async () => {
    await withSkillCatalogWorkspace(async ({ workDir, skillRoot }) => {
      class RootDiscovery implements ISkillDiscovery {
        declare readonly _serviceBrand: undefined;
        async discover(roots: readonly SkillRoot[]) {
          return {
            skills: [],
            skipped: [],
            scannedRoots: roots
              .filter((root) => root.source === 'project')
              .map((root) => root.path),
          };
        }
      }
      const ws = workspaceContextStub(workDir);
      const { host, workspace } = makeHost(new RootDiscovery(), ws);

      try {
        const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
        await catalog.load();

        expect(catalog.catalog.getSkillRoots()).toEqual([skillRoot]);
      } finally {
        host.dispose();
      }
    });
  });

  it('feeds skipped skills from file sources into the merged catalog', async () => {
    await withSkillCatalogWorkspace(async ({ workDir }) => {
      const skippedEntry = {
        path: join(workDir, '.kimi-code', 'skills', 'bad', 'SKILL.md'),
        type: 'nope',
        reason: 'unsupported skill type "nope"',
      };
      class SkippingDiscovery implements ISkillDiscovery {
        declare readonly _serviceBrand: undefined;
        async discover(roots: readonly SkillRoot[]) {
          const isProject = roots.some((root) => root.source === 'project');
          return {
            skills: [],
            skipped: isProject ? [skippedEntry] : [],
            scannedRoots: [],
          };
        }
      }
      const ws = workspaceContextStub(workDir);
      const { host, workspace } = makeHost(new SkippingDiscovery(), ws);

      try {
        const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
        await catalog.load();

        expect(catalog.catalog.getSkippedByPolicy()).toEqual([skippedEntry]);
      } finally {
        host.dispose();
      }
    });
  });

  it('rescans the workspace-root source when a project skill file changes on disk', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'skill-watch-'));
    const host = createScopedTestHost([
      stubPair(IBootstrapService, bootstrapStub),
      stubPair(IConfigService, configStub()),
      stubPair(ILogService, stubLog()),
      stubPair(ISkillDiscovery, new FileSkillDiscovery(stubLog())),
      stubPair(IHostFsWatchService, new HostFsWatchService()),
    ]);
    const workspace = host.child(LifecycleScope.Workspace, 'w1', [
      stubPair(IWorkspaceContext, workspaceContextStub(workDir)),
    ]);

    try {
      const catalog = workspace.accessor.get(IWorkspaceSkillCatalog);
      await catalog.load();
      expect(catalog.catalog.getSkill('watched-skill')).toBeUndefined();

      const refreshed = new Promise<string>((resolvePromise) => {
        const d = catalog.onDidChange((sourceId) => {
          d.dispose();
          resolvePromise(sourceId);
        });
      });
      const timedOut = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('watch-driven refresh timed out')), 10000);
      });
      await mkdir(join(workDir, '.agents', 'skills', 'watched-skill'), { recursive: true });
      await writeFile(
        join(workDir, '.agents', 'skills', 'watched-skill', 'SKILL.md'),
        '---\nname: watched-skill\ndescription: from watch\n---\nbody',
        'utf8',
      );

      await expect(Promise.race([refreshed, timedOut])).resolves.toBe('workspace');
      expect(catalog.catalog.getSkill('watched-skill')?.description).toBe('from watch');
    } finally {
      host.dispose();
      await rm(workDir, { recursive: true, force: true });
    }
  }, 15000);
});
