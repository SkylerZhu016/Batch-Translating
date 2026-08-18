import { TranslationRagClient } from '../client/src/client.ts';
import type { RagClientOptions } from '../client/src/types.ts';
import {
  startRagService,
  type RagServiceCapabilities,
  type RagServiceHandle,
  type StartRagServiceOptions,
} from './service.ts';

/**
 * Owns one authenticated local RAG sidecar process. Construction is async via
 * `start`; importing or constructing client utilities never starts a process,
 * downloads a model, or changes the user's environment.
 */
export class TranslationRagService {
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly capabilities: RagServiceCapabilities | undefined;

  private closed = false;

  private constructor(private readonly handle: RagServiceHandle) {
    this.url = handle.url;
    this.token = handle.token;
    this.pid = handle.pid;
    this.instanceId = handle.instanceId;
    this.capabilities = handle.capabilities;
  }

  static async start(options: StartRagServiceOptions): Promise<TranslationRagService> {
    return new TranslationRagService(await startRagService(options));
  }

  get isClosed(): boolean {
    return this.closed || this.handle.process.exitCode !== null || this.handle.process.signalCode !== null;
  }

  client(options?: Omit<RagClientOptions, 'base_url' | 'bearer_token'>): TranslationRagClient {
    if (this.isClosed) throw new Error('RAG service is closed');
    return new TranslationRagClient({
      ...options,
      base_url: this.url,
      bearer_token: this.token,
    });
  }

  async close(timeoutMs?: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.stop(timeoutMs);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
