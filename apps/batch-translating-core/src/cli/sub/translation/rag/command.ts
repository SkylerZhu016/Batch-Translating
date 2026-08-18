import { readFile } from 'node:fs/promises';

import {
  TranslationRagClient,
  type RagIndexRebuildRequest,
  type RagIndexStatusRequest,
  type RagSearchRequest,
  type RagSnapshotRequest,
  type RagVerifyRequest,
} from '@batch-translating/translation-rag';
import type { Command } from 'commander';

import { resolveTranslationIo, runTranslationJsonCommand, type TranslationJsonCommandIo } from '../io';
import { readJsonInput } from '../json-input';

interface RuntimeDescriptor {
  readonly url?: string;
  readonly token?: string;
  readonly base_url?: string;
  readonly bearer_token?: string;
}

interface RagParentOptions {
  readonly runtime?: string;
}

interface JsonInputOptions {
  readonly input: string;
}

export function registerTranslationRagCommand(
  parent: Command,
  io?: Partial<TranslationJsonCommandIo>,
): void {
  const output = resolveTranslationIo(io);
  const rag = parent
    .command('rag')
    .description('连接本机 BGE-M3/RAG 服务 / Use an already-running local RAG service.')
    .option(
      '--runtime <descriptor.json>',
      '仅本机 runtime 描述文件；也可使用 BATCH_TRANSLATING_RAG_RUNTIME / Local runtime descriptor.',
    )
    .addHelpText(
      'after',
      '\n安全说明：该命令只连接已启动的本机服务，不下载或启动模型；输出永不包含 bearer token。\n' +
        'Security: this command never downloads/starts a model and never prints its bearer token.\n',
    );

  rag
    .command('health')
    .description('服务与模型健康状态 / Service and model health.')
    .action(async (_options: object, command: Command) => {
      await withRagClient(output, command, (client) => client.health());
    });

  rag
    .command('status')
    .description('三个索引的项目状态 / Project index status.')
    .requiredOption('--input <json|->', '请求 JSON；- 从 stdin 读取 / Request JSON; - reads stdin.')
    .action(async (options: JsonInputOptions, command: Command) => {
      await withRagClient(output, command, async (client) =>
        client.indexStatus(await readJsonInput<RagIndexStatusRequest>(options.input)),
      );
    });

  const search = rag
    .command('search')
    .description('检索故事记忆、翻译记忆或源段落 / Search story, TM, or source indexes.');
  registerSearchCommand(search, 'story', '故事记忆 / Story memory.', output, (client, request) =>
    client.searchStory(request),
  );
  registerSearchCommand(search, 'tm', '翻译记忆 / Translation memory.', output, (client, request) =>
    client.searchTranslationMemory(request),
  );
  registerSearchCommand(search, 'source', '源段落 / Source paragraphs.', output, (client, request) =>
    client.searchSource(request),
  );

  rag
    .command('verify')
    .description('校验模型指纹、能力和索引 / Verify model fingerprint, capabilities, and indexes.')
    .requiredOption('--input <json|->', '请求 JSON；- 从 stdin 读取 / Request JSON; - reads stdin.')
    .action(async (options: JsonInputOptions, command: Command) => {
      await withRagClient(output, command, async (client) => {
        const result = await client.verify(
          await readJsonInput<RagVerifyRequest>(options.input),
        );
        if (!result.ok) output.setExitCode(2);
        return result;
      });
    });

  rag
    .command('rebuild')
    .description('请求原子重建索引 / Request an atomic index rebuild.')
    .requiredOption('--input <json|->', '请求 JSON；- 从 stdin 读取 / Request JSON; - reads stdin.')
    .action(async (options: JsonInputOptions, command: Command) => {
      await withRagClient(output, command, async (client) =>
        client.rebuildIndex(await readJsonInput<RagIndexRebuildRequest>(options.input)),
      );
    });

  rag
    .command('snapshot')
    .description('创建本机索引快照 / Create a local index snapshot.')
    .requiredOption('--input <json|->', '请求 JSON；- 从 stdin 读取 / Request JSON; - reads stdin.')
    .action(async (options: JsonInputOptions, command: Command) => {
      await withRagClient(output, command, async (client) =>
        client.snapshot(await readJsonInput<RagSnapshotRequest>(options.input)),
      );
    });
}

function registerSearchCommand(
  parent: Command,
  name: 'story' | 'tm' | 'source',
  description: string,
  io: TranslationJsonCommandIo,
  operation: (client: TranslationRagClient, request: RagSearchRequest) => Promise<unknown>,
): void {
  parent
    .command(name)
    .description(description)
    .requiredOption('--input <json|->', '请求 JSON；- 从 stdin 读取 / Request JSON; - reads stdin.')
    .action(async (options: JsonInputOptions, command: Command) => {
      await withRagClient(io, command, async (client) =>
        operation(client, await readJsonInput<RagSearchRequest>(options.input)),
      );
    });
}

async function withRagClient(
  io: TranslationJsonCommandIo,
  command: Command,
  operation: (client: TranslationRagClient) => unknown | Promise<unknown>,
): Promise<void> {
  const secrets: string[] = [];
  await runTranslationJsonCommand(
    io,
    async () => {
      const descriptorPath =
        ((command.optsWithGlobals() as RagParentOptions).runtime ??
          process.env['BATCH_TRANSLATING_RAG_RUNTIME'])?.trim();
      if (!descriptorPath) {
        throw new Error(
          '--runtime or BATCH_TRANSLATING_RAG_RUNTIME must name a local runtime descriptor',
        );
      }
      const descriptor = await readRuntimeDescriptor(descriptorPath);
      secrets.push(descriptor.token);
      const client = new TranslationRagClient({
        base_url: descriptor.url,
        bearer_token: descriptor.token,
      });
      return await operation(client);
    },
    {
      errorCode: 'translation_rag_failed',
      secrets,
    },
  );
}

async function readRuntimeDescriptor(
  descriptorPath: string,
): Promise<{ url: string; token: string }> {
  const raw = await readFile(descriptorPath, 'utf8');
  let value: RuntimeDescriptor;
  try {
    value = JSON.parse(raw) as RuntimeDescriptor;
  } catch (error) {
    throw new Error(
      `Invalid RAG runtime descriptor: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const url = value.url ?? value.base_url;
  const token = value.token ?? value.bearer_token;
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('RAG runtime descriptor is missing url');
  }
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('RAG runtime descriptor is missing token');
  }
  return { url, token };
}
