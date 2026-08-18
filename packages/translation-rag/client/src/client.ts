/**
 * Typed, token-authenticated HTTP client for the loopback translation RAG sidecar.
 */

import type {
  RagClientOptions,
  RagFetch,
  RagHealthResponse,
  RagIndexRebuildRequest,
  RagIndexRebuildResponse,
  RagIndexStatusRequest,
  RagIndexStatusResponse,
  RagMemoryDeleteRequest,
  RagMemoryUpsertRequest,
  RagMutationResponse,
  RagRequestOptions,
  RagSearchRequest,
  RagSearchResponse,
  RagSnapshotRequest,
  RagSnapshotResponse,
  RagVerifyRequest,
  RagVerifyResponse,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

export class RagHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'RagHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class TranslationRagClient {
  readonly baseUrl: URL;

  private readonly bearerToken: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: RagFetch;

  constructor(options: RagClientOptions) {
    const baseUrl = normalizeBaseUrl(options.base_url);
    if (!options.allow_remote && !isLoopbackHostname(baseUrl.hostname)) {
      throw new Error(`RAG sidecar URL must be loopback unless allow_remote is explicit: ${baseUrl.origin}`);
    }
    if (baseUrl.username || baseUrl.password) {
      throw new Error('RAG sidecar URL must not contain credentials');
    }
    if (!options.bearer_token.trim()) {
      throw new Error('RAG sidecar bearer token is required');
    }

    this.baseUrl = baseUrl;
    this.bearerToken = options.bearer_token;
    this.defaultTimeoutMs = options.default_timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  health(options?: RagRequestOptions): Promise<RagHealthResponse> {
    return this.request<RagHealthResponse>('GET', '/health', undefined, options);
  }

  indexStatus(
    request: RagIndexStatusRequest,
    options?: RagRequestOptions,
  ): Promise<RagIndexStatusResponse> {
    const query = new URLSearchParams({ project_id: request.project_id, book_id: request.book_id });
    return this.request<RagIndexStatusResponse>('GET', `/index/status?${query.toString()}`, undefined, options);
  }

  upsertMemory(
    request: RagMemoryUpsertRequest,
    options?: RagRequestOptions,
  ): Promise<RagMutationResponse> {
    return this.request<RagMutationResponse>('POST', '/memory/upsert', request, options);
  }

  deleteMemory(
    request: RagMemoryDeleteRequest,
    options?: RagRequestOptions,
  ): Promise<RagMutationResponse> {
    return this.request<RagMutationResponse>('POST', '/memory/delete', request, options);
  }

  searchStory(request: RagSearchRequest, options?: RagRequestOptions): Promise<RagSearchResponse> {
    return this.request<RagSearchResponse>('POST', '/story/search', request, options);
  }

  searchTranslationMemory(
    request: RagSearchRequest,
    options?: RagRequestOptions,
  ): Promise<RagSearchResponse> {
    return this.request<RagSearchResponse>('POST', '/tm/search', request, options);
  }

  searchSource(request: RagSearchRequest, options?: RagRequestOptions): Promise<RagSearchResponse> {
    return this.request<RagSearchResponse>('POST', '/source/search', request, options);
  }

  verify(request: RagVerifyRequest, options?: RagRequestOptions): Promise<RagVerifyResponse> {
    return this.request<RagVerifyResponse>('POST', '/verify', request, options);
  }

  rebuildIndex(
    request: RagIndexRebuildRequest,
    options?: RagRequestOptions,
  ): Promise<RagIndexRebuildResponse> {
    return this.request<RagIndexRebuildResponse>('POST', '/index/rebuild', request, options);
  }

  snapshot(
    request: RagSnapshotRequest,
    options?: RagRequestOptions,
  ): Promise<RagSnapshotResponse> {
    return this.request<RagSnapshotResponse>('POST', '/snapshot', request, options);
  }

  async request<TResponse>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
    options?: RagRequestOptions,
  ): Promise<TResponse> {
    const url = new URL(assertRelativeSidecarPath(path), this.baseUrl);
    const timeoutMs = options?.timeout_ms ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeout_ms must be a positive finite number');
    }

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error('RAG request timed out')), timeoutMs);
    const signals = options?.signal
      ? [options.signal, timeoutController.signal]
      : [timeoutController.signal];
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.bearerToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        const error = extractError(payload, response.statusText);
        throw new RagHttpError(error.message, response.status, error.code, error.details);
      }
      return payload as TResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('RAG sidecar URL must use HTTP or HTTPS');
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  url.search = '';
  url.hash = '';
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHostname(normalized.slice('::ffff:'.length));
  }
  const octets = normalized.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every(isIpv4Octet);
}

function isIpv4Octet(value: string): boolean {
  if (!/^\d{1,3}$/.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return parsed >= 0 && parsed <= 255;
}

function assertRelativeSidecarPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('RAG request path must be an absolute sidecar path');
  }
  return path.slice(1);
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new RagHttpError('RAG sidecar returned non-JSON data', response.status, 'invalid_response');
    }
    return { message: text };
  }
}

function extractError(
  payload: unknown,
  fallbackMessage: string,
): { message: string; code?: string; details?: unknown } {
  if (!isRecord(payload)) {
    return { message: fallbackMessage || 'RAG sidecar request failed', details: payload };
  }
  const nested = isRecord(payload['error']) ? payload['error'] : payload;
  const message =
    typeof nested['message'] === 'string'
      ? nested['message']
      : typeof payload['detail'] === 'string'
        ? payload['detail']
        : fallbackMessage || 'RAG sidecar request failed';
  const code = typeof nested['code'] === 'string' ? nested['code'] : undefined;
  return { message, ...(code ? { code } : {}), details: payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
