/**
 * `/api/v1` prompt routes — v1-compatible prompt surface backed directly by
 * the Agent-scoped `prompt` scheduler. This edge applies protocol conversion,
 * request overrides, and metadata updates while preserving the paths and wire
 * shapes from `packages/server/src/routes/prompts.ts`.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  IBootstrapService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentToolPolicyService,
  IAgentPromptService,
  IAuthSummaryService,
  IEventService,
  IFileService,
  ISessionMetadata,
  promptMetadataTextFromContentParts,
  ProfileError,
  type ContentPart,
  type PromptHandle,
  type PromptQueueSnapshot,
  ISessionContext,
  resumeSessionById,
  applyPromptMetadataUpdate,
  isError2,
  Error2,
  ErrorCodes,
  type GetResult,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import {
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
  type PromptSubmission,
} from '../protocol/rest-prompt';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

interface PromptRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const validationDetailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));
const authProviderDetailsSchema = z.object({ provider_id: z.string() });
const authModelDetailsSchema = z.object({ model_id: z.string(), provider_id: z.string() }).partial();

async function resolveSession(core: Scope, sessionId: string): Promise<ISessionScopeHandle> {
  // `resume` (not `get`) so a persisted-but-cold session — created by a previous
  // process, by v1, or closed in this one — is loaded from disk instead of
  // being reported as `session.not_found`. Mirrors the snapshot route. Returns
  // `undefined` only when the session is unknown or its workspace is gone.
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2('session.not_found', `session ${sessionId} does not exist`);
  }
  return session;
}

async function resolvePrompt(core: Scope, sessionId: string, agentId?: string) {
  return resolvePromptFromSession(await resolveSession(core, sessionId), agentId);
}

async function resolvePromptFromSession(session: ISessionScopeHandle, agentId?: string) {
  // A prompt may target a forked side-channel agent (e.g. `/btw`) via
  // `body.agent_id`. Default to `main` when absent; only `main` is
  // auto-created — any other id must already exist (forked beforehand), or it
  // is reported as `agent.not_found`.
  const agent =
    agentId === undefined || agentId === MAIN_AGENT_ID
      ? await ensureMainAgent(session)
      : session.accessor.get(IAgentLifecycleService).get(agentId);
  if (agent === undefined) {
    throw new Error2('agent.not_found', `agent ${agentId} does not exist`);
  }
  return {
    prompt: agent.accessor.get(IAgentPromptService),
    auth: agent.accessor.get(IAuthSummaryService),
    profile: agent.accessor.get(IAgentProfileService),
    toolPolicy: agent.accessor.get(IAgentToolPolicyService),
    permissionMode: agent.accessor.get(IAgentPermissionModeService),
  };
}

/**
 * Bind the resolved agent to the profile named by a prompt submission's
 * `profile` field. First-bind semantics live in the engine: a same-name
 * repeat is short-circuited here as a no-op, while an unknown name or a
 * post-bind switch is rejected by `AgentProfileService.bind` with a coded
 * `ProfileError` — this edge only maps it onto 40001. Checking anything
 * beyond the no-op shortcut here would re-introduce a check-then-act window
 * the engine guard has already closed.
 *
 * `model` falls back to the configured default inside the engine. `thinking`
 * rides along in the bind so an unsupported effort rejects atomically —
 * before any state mutation — instead of wedging the session's identity with
 * a successful bind followed by a failed `setThinking`.
 *
 * Returns true when a bind happened (i.e. `thinking` was consumed by it).
 */
async function applyProfileSelection(
  profile: IAgentProfileService,
  profileName: string,
  model: string | undefined,
  thinking: string | undefined,
): Promise<boolean> {
  if (profile.data().profileName === profileName) return false;
  try {
    await profile.bind({
      profile: profileName,
      model,
      thinking,
      strictThinking: thinking !== undefined,
    });
  } catch (error) {
    if (error instanceof ProfileError) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
    }
    throw error;
  }
  return true;
}

/**
 * Fail fast on stale or mis-kinded file references before anything
 * session-scoped happens: a bad `file_id` (unknown, or a real file used with
 * the wrong media kind, e.g. a PDF submitted as a video) must reject the
 * request without creating the prompt agent and without touching the
 * session's model/thinking/permission.
 */
async function assertPromptFileRefs(body: PromptSubmission, store: IFileService): Promise<void> {
  for (const part of body.content) {
    if (part.type === 'file') {
      await store.get(part.file_id);
    } else if ((part.type === 'image' || part.type === 'video') && part.source.kind === 'file') {
      const file = await store.get(part.source.file_id);
      assertMediaFile(file, part.type);
    }
  }
}

export function registerPromptsRoutes(app: PromptRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/prompts',
      params: sessionIdParamSchema,
      success: { data: promptListResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'List the active prompt and queued prompts for a session',
      tags: ['prompts'],
      operationId: 'listPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const result = projectPromptList((await resolvePrompt(core, session_id)).prompt.list());
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<PromptRouteHost['get']>[2]);

  const submitRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts',
      body: promptSubmissionSchema,
      params: sessionIdParamSchema,
      success: { data: promptSubmitResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema: validationDetailsSchema },
        [ErrorCode.AUTH_PROVISIONING_REQUIRED]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: { detailsSchema: authProviderDetailsSchema },
        [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: { detailsSchema: authModelDetailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      try {
        // Fail fast on stale file references before anything is resolved or
        // mutated: a bad `file_id` must not create the agent, register `main`
        // in session metadata, or touch the session's controls.
        await assertPromptFileRefs(req.body, core.accessor.get(IFileService));
        const resolved = await resolvePrompt(core, session_id, req.body.agent_id);
        await resolved.auth.ensureReady();

        // Media resolution runs BEFORE any control mutation, so a failed
        // submission leaves the session's controls untouched. Uploaded images
        // and videos are inlined as base64 parts (the provider-facing form the
        // engine's `image_url` / `video_url` parts accept); arbitrary file
        // attachments are materialized to a local copy and carried into
        // context as a path reference for the Read tool.
        const resolvedBody = await resolvePromptMediaFiles(
          req.body,
          core.accessor.get(IFileService),
          core.accessor.get(IBootstrapService).cacheDir,
          {
            resolveAttachmentsDir: async () => {
              const session = await resumeSessionById(core.accessor, session_id);
              if (session === undefined) return undefined;
              return join(session.accessor.get(ISessionContext).sessionDir, 'attachments');
            },
          },
        );

        // Media prepared successfully — only now do the overrides bind.
        let thinkingConsumed = false;
        if (req.body.profile !== undefined) {
          thinkingConsumed =
            (await applyProfileSelection(
              resolved.profile,
              req.body.profile,
              req.body.model,
              req.body.thinking,
            )) && req.body.thinking !== undefined;
        }
        if (req.body.model !== undefined) await resolved.profile.setModel(req.body.model);
        if (req.body.thinking !== undefined && !thinkingConsumed)
          resolved.profile.setThinking(req.body.thinking);
        if (req.body.permission_mode !== undefined) resolved.permissionMode.setMode(req.body.permission_mode);
        if (req.body.disabled_tools !== undefined) {
          // A session denylist before bind throws `profile.not_bound` — map it
          // onto 40001 like the profile-selection errors above.
          try {
            await resolved.toolPolicy.setSessionDisabledTools(req.body.disabled_tools);
          } catch (error) {
            if (error instanceof ProfileError) {
              throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
            }
            throw error;
          }
        }
        const parts = contentToCoreParts(resolvedBody.content);
        const session = await resolveSession(core, session_id);
        await applyPromptMetadataUpdate({
          metadata: session.accessor.get(ISessionMetadata),
          eventService: core.accessor.get(IEventService),
          sessionId: session_id,
        }, promptMetadataTextFromContentParts(parts));
        const handle = await resolved.prompt.enqueue({ message: {
          role: 'user',
          content: parts,
          toolCalls: [],
          origin: { kind: 'user' },
        } });
        reply.send(okEnvelope(projectPromptHandle(handle), req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(submitRoute.path, submitRoute.options, submitRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const steerManyRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts::steer',
      body: promptSteerRequestSchema,
      params: sessionIdParamSchema,
      success: { data: promptSteerResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
      },
      description: 'Steer queued prompts into the active turn',
      tags: ['prompts'],
      operationId: 'steerPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const resolved = await resolvePrompt(core, session_id);
        await resolved.prompt.steer(req.body.prompt_ids);
        reply.send(okEnvelope({ steered: true, prompt_ids: [...req.body.prompt_ids] }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(steerManyRoute.path, steerManyRoute.options, steerManyRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts/{tail}',
      success: { data: z.union([promptAbortResponseSchema, promptSteerResultSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Abort a running prompt or steer a queued prompt',
      tags: ['prompts'],
      operationId: 'promptAction',
    },
    async (req, reply) => {
      try {
        const { session_id, tail } = req.params as { session_id: string; tail: string };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['abort', 'steer'] as const,
          resourceLabel: 'prompt',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const resolved = await resolvePrompt(core, session_id);
        if (parsed.action === 'abort') {
          resolved.prompt.abort(parsed.id);
          requestLog(req)?.info({ session_id, prompt_id: parsed.id }, 'prompt aborted');
          reply.send(okEnvelope({ aborted: true }, req.id));
        } else {
          await resolved.prompt.steer([parsed.id]);
          reply.send(okEnvelope({ steered: true, prompt_ids: [parsed.id] }, req.id));
        }
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as Parameters<PromptRouteHost['post']>[2]);
}

function projectPromptList(snapshot: PromptQueueSnapshot) {
  return {
    active: snapshot.active === undefined ? null : projectPromptSnapshot(snapshot.active),
    queued: snapshot.pending.map(projectPromptSnapshot),
  };
}

function projectPromptHandle(handle: PromptHandle) {
  return projectPromptSnapshot(handle);
}

function projectPromptSnapshot(prompt: PromptQueueSnapshot['pending'][number]) {
  const status = prompt.state === 'running' || prompt.state === 'steered'
    ? 'running'
    : prompt.state === 'blocked' ? 'blocked' : 'queued';
  return {
    prompt_id: prompt.id,
    user_message_id: prompt.userMessageId,
    status,
    content: corePartsToProtocol(prompt.message.content),
    created_at: prompt.createdAt,
  };
}

function corePartsToProtocol(content: readonly ContentPart[]): PromptSubmission['content'] {
  const parts: PromptSubmission['content'] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.imageUrl.url);
      parts.push(match === null
        ? { type: 'image', source: { kind: 'url', url: part.imageUrl.url, id: part.imageUrl.id } }
        : { type: 'image', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    } else if (part.type === 'video_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.videoUrl.url);
      parts.push(match === null
        ? { type: 'video', source: { kind: 'url', url: part.videoUrl.url, id: part.videoUrl.id } }
        : { type: 'video', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    }
  }
  return parts;
}

function contentToCoreParts(content: PromptSubmission['content']): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image' && part.source.kind === 'url') parts.push({ type: 'image_url', imageUrl: { url: part.source.url, id: part.source.id } });
    else if (part.type === 'image' && part.source.kind === 'base64') parts.push({ type: 'image_url', imageUrl: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
    else if (part.type === 'video' && part.source.kind === 'url') parts.push({ type: 'video_url', videoUrl: { url: part.source.url, id: part.source.id } });
    else if (part.type === 'video' && part.source.kind === 'base64') parts.push({ type: 'video_url', videoUrl: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
  }
  return parts;
}

interface ResolvePromptMediaOptions {
  /**
   * Lazily resolve the session's attachments dir for materializing arbitrary
   * file uploads into a path the model can open with the Read tool. A failure
   * or undefined result falls back to the shared cache dir.
   */
  readonly resolveAttachmentsDir?: () => Promise<string | undefined>;
}

async function resolvePromptMediaFiles(
  body: PromptSubmission,
  store: IFileService,
  cacheDir: string,
  options: ResolvePromptMediaOptions = {},
): Promise<PromptSubmission> {
  let changed = false;
  let attachmentsDir: string | undefined;
  let attachmentsDirResolved = false;
  const resolveAttachmentsDir = async (): Promise<string> => {
    if (!attachmentsDirResolved) {
      attachmentsDirResolved = true;
      attachmentsDir = await options.resolveAttachmentsDir?.().catch(() => undefined);
    }
    return attachmentsDir ?? cacheDir;
  };
  const content: PromptSubmission['content'] = [];
  for (const part of body.content) {
    // Inline base64 image and remote image URL: no edge-side handling — the
    // part passes through to the engine unchanged.
    if (part.type === 'image' && part.source.kind !== 'file') {
      content.push(part);
      continue;
    }

    // Arbitrary file attachment: materialize the uploaded bytes next to the
    // session and replace the part with a path reference — the model opens it
    // with the Read tool instead of receiving it as a media part.
    if (part.type === 'file') {
      const file = await store.get(part.file_id);
      const attachedPath = await materializeAttachmentToDir(file, await resolveAttachmentsDir());
      content.push({
        type: 'text',
        text: buildAttachedFileNotice(file.meta.name, file.meta.media_type, file.meta.size, attachedPath),
      });
      changed = true;
      continue;
    }

    // Uploaded image / video: inline the stored bytes as a base64 part — the
    // provider-facing form the engine's `image_url` / `video_url` parts accept.
    if (part.type !== 'image' && part.type !== 'video') {
      content.push(part);
      continue;
    }
    if (part.source.kind !== 'file') {
      content.push(part);
      continue;
    }
    const file = await store.get(part.source.file_id);
    assertMediaFile(file, part.type);
    const bytes = await readFileOrStream(file);
    content.push({
      type: part.type,
      source: {
        kind: 'base64',
        media_type: file.meta.media_type,
        data: Buffer.from(bytes).toString('base64'),
      },
    });
    changed = true;
  }
  return changed ? { ...body, content } : body;
}

const ATTACHMENT_NAME_MAX = 100;

/**
 * Attachment file names are untrusted (the multipart filename / a wire field):
 * strip path separators, control chars, and leading dots so the materialized
 * file can never escape its directory or land as a hidden file, and cap the
 * length so the path stays manageable.
 */
function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .replaceAll(/[\\/]/g, '_')
    .replaceAll(/[\u0000-\u001F\u007F]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, ATTACHMENT_NAME_MAX);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/** Stream an uploaded file into `dir` as `<fileId>-<sanitized name>`. */
async function materializeAttachmentToDir(file: GetResult, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${file.meta.id}-${sanitizeAttachmentName(file.meta.name)}`);
  const info = await stat(target).catch(() => undefined);
  if (info?.size === file.meta.size) return target;

  await pipeline(file.stream(), createWriteStream(target));
  return target;
}

// This notice's exact shape is a client contract: kimi-web's messagesToTurns
// parses it (ATTACHED_FILE_NOTICE_RE) to rebuild the attachment chip after a
// resync — change the wording there too.
function buildAttachedFileNotice(name: string, mediaType: string, size: number, path: string): string {
  return `Attached file "${name}" (${mediaType}, ${size} bytes): ${path} — open it with the Read tool`;
}

async function readFileOrStream(file: GetResult): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream()) {
    chunks.push(Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks);
}

function assertMediaFile(file: GetResult, expected: 'image' | 'video'): void {
  const prefix = expected === 'video' ? 'video/' : 'image/';
  if (file.meta.media_type.toLowerCase().startsWith(prefix)) return;
  throw new Error2(
    'validation.failed',
    `file ${file.meta.id} is ${file.meta.media_type}, not ${expected === 'video' ? 'a video' : 'an image'}`,
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'file.not_found':
        reply.send(errEnvelope(ErrorCode.FILE_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'prompt.not_found':
        reply.send(errEnvelope(ErrorCode.PROMPT_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'session.busy':
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId, err.stack));
        return;
      case 'prompt.already_completed':
        reply.send({
          code: ErrorCode.PROMPT_ALREADY_COMPLETED,
          msg: err.message,
          data: { aborted: false },
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case 'request.invalid':
      case 'validation.failed':
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
      case 'auth.provisioning_required':
        reply.send({
          code: ErrorCode.AUTH_PROVISIONING_REQUIRED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details: null,
        });
        return;
      case 'auth.token_missing': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          log?.error({ err }, 'prompt request failed');
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_MISSING,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details,
        });
        return;
      }
      case 'auth.token_unauthorized': {
        const details = authProviderDetails(err);
        if (details === undefined) {
          log?.error({ err }, 'prompt request failed');
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              `auth error ${err.code} missing provider_id`,
              requestId,
            ),
          );
          return;
        }
        reply.send({
          code: ErrorCode.AUTH_TOKEN_UNAUTHORIZED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details,
        });
        return;
      }
      case 'auth.model_not_resolved':
        reply.send({
          code: ErrorCode.AUTH_MODEL_NOT_RESOLVED,
          msg: err.message,
          data: null,
          request_id: requestId,
          stack: err.stack,
          details: authModelDetails(err),
        });
        return;
    }
  }
  log?.error({ err }, 'prompt request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}

function authProviderDetails(err: Error2): { provider_id: string } | undefined {
  const providerId = err.details?.['provider_id'];
  if (typeof providerId !== 'string') return undefined;
  return { provider_id: providerId };
}

function authModelDetails(err: Error2): { model_id?: string; provider_id?: string } | null {
  const details: { model_id?: string; provider_id?: string } = {};
  const modelId = err.details?.['model_id'];
  const providerId = err.details?.['provider_id'];
  if (typeof modelId === 'string') details.model_id = modelId;
  if (typeof providerId === 'string') details.provider_id = providerId;
  return Object.keys(details).length === 0 ? null : details;
}
