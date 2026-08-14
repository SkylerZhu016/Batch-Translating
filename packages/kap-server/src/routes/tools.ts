/**
 * `/tools` REST route — server-v2 port.
 *
 * 1 endpoint (REST.md §3.8), mirroring the v1 server's wire contract
 * (`packages/server/src/routes/tools.ts`):
 *
 *   GET  /tools                                  query: {session_id?}    data: {tools: ToolDescriptor[]}
 *
 * **Thin wrapper over Agent-scoped services**: `IAgentToolRegistryService.list` /
 * `IAgentToolPolicyService.isToolActive` are already exposed on the
 * RPC dispatcher (`/api/v1/debug`). This
 * REST route borrows them by interface and projects the v2 models into the
 * protocol's `ToolDescriptor` shape.
 *
 * **Resolution**: v1 serves this from a global singleton that falls back to
 * the most-recent session. v2 has no global tool state — the service is
 * Agent-scoped — so we reproduce the fallback: `core` → `ISessionIndex` (pick
 * the newest session by `createdAt`, or the explicit `session_id`) →
 * the live handler registry → `IAgentLifecycleService` (the `main` agent) →
 * the service. When no session is live, or the main agent does not exist yet
 * (server-v2 gap G10), the endpoint answers an empty list, exactly like v1.
 *
 * **Model projection**:
 *   - Tool `source`: `user`→`skill` (wire name), `builtin`/`mcp` pass through.
 *   - Tool `input_schema`: always `null`, matching v1 (`packages/server`'s
 *     `ToolInfo` carries no JSON schema). v2's registry does expose
 *     `parameters`, but we keep byte-for-byte wire parity with v1.
 *   - Tool `active`: effective availability from `IAgentToolPolicyService.isToolActive`
 *     (bound profile policy ∩ global `[tools]` config ∩ session denylist).
 *     Deliberate v2 extension beyond the v1 wire shape — v1 had no tool gates.
 *
 * **Anti-corruption**: route resolves `IAgentToolRegistryService` via the
 * accessor; no SDK imports.
 */

import {
  ISessionIndex,
  IAgentToolRegistryService,
  IAgentToolPolicyService,
  getLiveSessionById,
  type Scope,
  type ToolInfo,
  type ToolSource,
} from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import {
  listToolsQuerySchema,
  listToolsResponseSchema,
} from '../protocol/rest-tool';
import type { ToolDescriptor } from '../protocol/tool';

interface ToolsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerToolsRoutes(app: ToolsRouteHost, core: Scope): void {
  // GET /tools ----------------------------------------------------------
  const listToolsRoute = defineRoute(
    {
      method: 'GET',
      path: '/tools',
      querystring: listToolsQuerySchema,
      success: { data: listToolsResponseSchema },
      description: 'List available tools',
      tags: ['tools'],
    },
    async (req, reply) => {
      const agent = await resolveEffectiveAgent(core, req.query.session_id);
      if (agent === undefined) {
        reply.send(okEnvelope({ tools: [] }, req.id));
        return;
      }
      const registry = agent.accessor.get(IAgentToolRegistryService);
      const policy = agent.accessor.get(IAgentToolPolicyService);
      const tools = registry
        .list()
        .map((info) => toProtocolTool(info, policy.isToolActive(info.name, info.source)));
      reply.send(okEnvelope({ tools }, req.id));
    },
  );
  app.get(
    listToolsRoute.path,
    listToolsRoute.options,
    listToolsRoute.handler as Parameters<ToolsRouteHost['get']>[2],
  );
}

// ---------------------------------------------------------------------------
// Resolution — walk core → newest session → main agent. Returns `undefined`
// when no session is live or the main agent has not been created yet (gap G10);
// the caller translates that into an empty list.
// ---------------------------------------------------------------------------

async function resolveEffectiveAgent(core: Scope, sessionId: string | undefined) {
  const sid = sessionId ?? (await mostRecentSessionId(core));
  if (sid === undefined) return undefined;
  const session = getLiveSessionById(core.accessor, sid);
  if (session === undefined) return undefined;
  return ensureMainAgent(session);
}

/** Pick the most-recently-created session id, mirroring v1's fallback. */
async function mostRecentSessionId(core: Scope): Promise<string | undefined> {
  const page = await core.accessor.get(ISessionIndex).listRecent({});
  const [first, ...rest] = page.items;
  if (first === undefined) return undefined;
  let newest = first;
  for (const item of rest) {
    if (item.createdAt > newest.createdAt) newest = item;
  }
  return newest.id;
}

// ---------------------------------------------------------------------------
// Projection — v2 models → protocol wire shapes (see module header).
// ---------------------------------------------------------------------------

function mapToolSource(source: ToolSource): ToolDescriptor['source'] {
  switch (source) {
    case 'builtin':
      return 'builtin';
    case 'user':
      return 'skill';
    case 'mcp':
      return 'mcp';
  }
}

function toProtocolTool(info: ToolInfo, active: boolean): ToolDescriptor {
  return {
    name: info.name,
    description: info.description,
    input_schema: null,
    source: mapToolSource(info.source),
    active,
  };
}
