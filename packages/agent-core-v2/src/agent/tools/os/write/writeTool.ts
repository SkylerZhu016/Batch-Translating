/**
 * `tools` domain — `WriteTool` implementation.
 *
 * Resolves path access policy before any filesystem I/O, creates missing
 * parent directories (`mkdir(recursive)`), and writes through
 * `IHostFileSystem.writeText` / `appendText`. Append uses a native
 * `O_APPEND`-style append, so existing content is never read or rewritten —
 * keeping appends atomic with respect to concurrent writers and safe against
 * mid-write crashes.
 *
 * Write access flows through the os `hostFs` domain (`IHostFileSystem`); path
 * semantics (home expansion, path class) come from the `hostEnvironment`
 * domain; the workspace and skill roots come from `ISessionWorkspaceContext`
 * / `ISessionSkillCatalog`.
 *
 * Ported from v1.
 * Bound at Agent scope; self-registers via `registerAgentToolService(...)` at module
 * load.
 */

import { dirname } from 'pathe';

import { abortable, createDeadlineAbortSignal } from '#/_base/utils/abort';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { type HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import {
  extendWorkspaceWithSkillRoots,
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { IWriteTool, WriteInputSchema, type WriteInput } from './write';
import WRITE_DESCRIPTION from './write.md?raw';

const WRITE_TIMEOUT_MS = 120_000;

export class WriteTool implements IWriteTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Write' as const;
  readonly description = WRITE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteInputSchema);

  constructor(
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {}

  private get workspaceConfig(): WorkspaceConfig {
    return extendWorkspaceWithSkillRoots(
      {
        workspaceDir: this.workspaceCtx.workDir,
        additionalDirs: this.workspaceCtx.additionalDirs,
      },
      this.skillCatalog?.catalog.getSkillRoots() ?? [],
      this.env.pathClass,
    );
  }

  resolveExecution(args: WriteInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      env: this.env,
      workspace: this.workspaceConfig,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.writeFile(path),
      description: `Writing ${args.path}`,
      display: { kind: 'file_io', operation: 'write', path, content: args.content },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspaceConfig.workspaceDir,
          pathClass: this.env.pathClass,
          homeDir: this.env.homeDir,
        }),
      execute: ({ signal }) => this.execution(args, path, signal),
    };
  }

  private async execution(
    args: WriteInput,
    safePath: string,
    parentSignal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    parentSignal.throwIfAborted();
    if (this.fs.supportsAbortableWrites !== true) {
      try {
        // This only keeps Pause/Stop responsive. A backend without the
        // capability may still complete its underlying remote write later.
        return await abortable(this.write(args, safePath, parentSignal), parentSignal);
      } catch (error) {
        parentSignal.throwIfAborted();
        return this.writeError(args.path, error);
      }
    }
    const deadline = createDeadlineAbortSignal(parentSignal, WRITE_TIMEOUT_MS);
    try {
      return await abortable(this.write(args, safePath, deadline.signal), deadline.signal);
    } catch (error) {
      parentSignal.throwIfAborted();
      if (deadline.timedOut()) {
        return {
          isError: true,
          output:
            `Write timed out after ${String(WRITE_TIMEOUT_MS / 1000)} seconds for ${args.path}. ` +
            'This is a retryable filesystem error: inspect the target, then retry the Write call (avoid duplicating content when appending).',
        };
      }
      return this.writeError(args.path, error);
    } finally {
      deadline.clear();
    }
  }

  private async write(
    args: WriteInput,
    safePath: string,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    const parentError = await this.ensureParentDirectory(safePath, signal);
    if (parentError !== undefined) {
      return { isError: true, output: parentError };
    }

    const mode = args.mode ?? 'overwrite';
    const options = this.fs.supportsAbortableWrites === true ? { signal } : undefined;
    if (mode === 'append' && options !== undefined) {
      await this.fs.appendText(safePath, args.content, options);
    } else if (mode === 'append') {
      await this.fs.appendText(safePath, args.content);
    } else if (options !== undefined) {
      await this.fs.writeText(safePath, args.content, options);
    } else {
      await this.fs.writeText(safePath, args.content);
    }
    signal.throwIfAborted();
    const bytesWritten = Buffer.byteLength(args.content, 'utf8');
    return {
      output: `${mode === 'append' ? 'Appended' : 'Wrote'} ${String(bytesWritten)} bytes to ${args.path}`,
    };
  }

  private writeError(path: string, error: unknown): ExecutableToolResult {
    const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') {
      return {
        isError: true,
        output: `Failed to write ${path}: parent directory does not exist.`,
      };
    }
    return {
      isError: true,
      output: error instanceof Error ? error.message : String(error),
    };
  }

  private async ensureParentDirectory(
    safePath: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    const parent = dirname(safePath);
    let stat: HostFileStat;
    try {
      stat = await this.fs.stat(parent);
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      if ((unwrapErrorCause(error) as { code?: unknown } | null)?.code === 'ENOENT') {
        try {
          await this.fs.mkdir(parent, { recursive: true });
          signal.throwIfAborted();
          return undefined;
        } catch (mkdirError) {
          signal.throwIfAborted();
          return mkdirError instanceof Error ? mkdirError.message : String(mkdirError);
        }
      }
      return undefined;
    }
    if (!stat.isDirectory) {
      return `Parent path is not a directory: ${parent}.`;
    }
    return undefined;
  }
}

registerAgentToolService(IWriteTool, WriteTool, { name: 'Write', domain: 'os/backends' });
