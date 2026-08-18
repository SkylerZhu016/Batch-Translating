/**
 * `sessionContext` domain — seeded per-session facts.
 *
 * Defines the `ISessionContext` carrying the session's identity, storage
 * addressing (`sessionId`, `workspaceId`, `sessionDir`, `metaScope`), the
 * session's working directory (`cwd`) — frozen at session creation — and a
 * `scope(subKey?)` helper that returns the session's persistence scope (or a
 * child under it, e.g. `scope('agents/main/cron')`). Seeded into the Session
 * scope when the session is created. Pure facts — no store, no IO.
 * Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface ISessionContext {
  readonly _serviceBrand: undefined;

  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly metaScope: string;
  readonly cwd: string;
  /** Initial metadata kept out of the index until session creation commits. */
  readonly metadataBootstrap?: {
    readonly title?: string;
    readonly custom: Readonly<Record<string, unknown>>;
    readonly deferMirror: boolean;
  };
  scope(subKey?: string): string;
}

export const ISessionContext: ServiceIdentifier<ISessionContext> =
  createDecorator<ISessionContext>('sessionContext');

export function sessionContextSeed(ctx: ISessionContext): ScopeSeed {
  return [[ISessionContext as ServiceIdentifier<unknown>, ctx]];
}

export function makeSessionContext(input: {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly sessionScope: string;
  readonly cwd: string;
  readonly metaScope?: string;
  readonly metadataBootstrap?: ISessionContext['metadataBootstrap'];
}): ISessionContext {
  const { sessionScope } = input;
  return {
    _serviceBrand: undefined,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    sessionDir: input.sessionDir,
    metaScope: input.metaScope ?? sessionScope,
    cwd: input.cwd,
    ...(input.metadataBootstrap !== undefined
      ? { metadataBootstrap: input.metadataBootstrap }
      : {}),
    scope: (subKey?: string): string =>
      subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
  };
}
