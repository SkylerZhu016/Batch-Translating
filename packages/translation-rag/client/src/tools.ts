/**
 * Framework-neutral Agent tool adapters backed by the real translation RAG HTTP client.
 */

import type { TranslationRagClient } from './client.ts';
import type {
  JsonValue,
  RagIndexName,
  RagMemoryRecord,
  RagSearchFilters,
  RagSearchRequest,
  RagSpoilerPolicy,
  RagToolContext,
  RagToolDefinition,
} from './types.ts';

const PROJECT_BOOK_PROPERTIES = {
  project_id: { type: 'string', minLength: 1 },
  book_id: { type: 'string', minLength: 1 },
} as const;

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['project_id', 'book_id', 'query'],
  properties: {
    ...PROJECT_BOOK_PROPERTIES,
    query: { type: 'string', minLength: 1 },
    top_k: { type: 'integer', minimum: 1, maximum: 100 },
    chapter_id: { type: 'string' },
    max_chapter: { type: 'integer', minimum: 0 },
    spoiler_policy: {
      type: 'string',
      enum: ['historical', 'retrospective_constraint', 'review_only'],
    },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source_hashes: { type: 'array', items: { type: 'string' } },
        instruction_versions: { type: 'array', items: { type: 'integer' } },
        provenance_ids: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' } },
        memory_types: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const;

export function createTranslationRagTools(client: TranslationRagClient): readonly RagToolDefinition[] {
  return [
    tool('rag_health', 'Read the real local RAG model and retrieval capability status.', {
      type: 'object',
      additionalProperties: false,
      properties: {},
    }, async (_input, context) => client.health(requestOptions(context))),
    tool('rag_index_status', 'Read point counts and active index versions for one translation book.', {
      type: 'object',
      additionalProperties: false,
      required: ['project_id', 'book_id'],
      properties: PROJECT_BOOK_PROPERTIES,
    }, async (input, context) => {
      const value = requireProjectBook(input);
      return client.indexStatus(value, requestOptions(context));
    }),
    tool('rag_story_search', 'Retrieve spoiler-filtered story memory for one book.', SEARCH_SCHEMA,
      async (input, context) => client.searchStory(parseSearch(input), requestOptions(context))),
    tool('rag_tm_search', 'Retrieve approved or final translation-memory examples for one book.', SEARCH_SCHEMA,
      async (input, context) => client.searchTranslationMemory(parseSearch(input), requestOptions(context))),
    tool('rag_source_search', 'Retrieve source paragraphs from one book by semantic similarity.', SEARCH_SCHEMA,
      async (input, context) => client.searchSource(parseSearch(input), requestOptions(context))),
    tool('rag_verify', 'Verify the actual embedding model, indexes, book isolation, and dense retrieval path.', {
      type: 'object',
      additionalProperties: false,
      required: ['project_id', 'book_id'],
      properties: {
        ...PROJECT_BOOK_PROPERTIES,
        query: { type: 'string' },
      },
    }, async (input, context) => {
      const value = requireRecord(input);
      const projectBook = requireProjectBook(value);
      const query = optionalString(value, 'query');
      return client.verify({ ...projectBook, ...(query === undefined ? {} : { query }) }, requestOptions(context));
    }),
    tool('rag_memory_upsert', 'Idempotently write immutable story, translation, or source records into one book index.', {
      type: 'object',
      additionalProperties: false,
      required: ['project_id', 'book_id', 'index', 'records'],
      properties: {
        ...PROJECT_BOOK_PROPERTIES,
        index: { type: 'string', enum: ['story_memory', 'translation_memory', 'source_paragraph'] },
        records: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'text'],
            properties: {
              id: { type: 'string', minLength: 1 },
              text: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    }, async (input, context) => {
      const value = requireRecord(input);
      const recordsValue = value['records'];
      if (!Array.isArray(recordsValue) || recordsValue.length === 0) {
        throw new TypeError('records must be a non-empty array');
      }
      const records = recordsValue.map(parseMemoryRecord);
      return client.upsertMemory(
        { ...requireProjectBook(value), index: requireIndex(value), records },
        requestOptions(context),
      );
    }),
    tool('rag_memory_delete', 'Delete selected records from one book index without crossing project boundaries.', {
      type: 'object',
      additionalProperties: false,
      required: ['project_id', 'book_id', 'index'],
      properties: {
        ...PROJECT_BOOK_PROPERTIES,
        index: { type: 'string', enum: ['story_memory', 'translation_memory', 'source_paragraph'] },
        ids: { type: 'array', items: { type: 'string' } },
        provenance_ids: { type: 'array', items: { type: 'string' } },
      },
    }, async (input, context) => {
      const value = requireRecord(input);
      const ids = optionalStringArray(value, 'ids');
      const provenanceIds = optionalStringArray(value, 'provenance_ids');
      if ((!ids || ids.length === 0) && (!provenanceIds || provenanceIds.length === 0)) {
        throw new TypeError('ids or provenance_ids must contain at least one value');
      }
      return client.deleteMemory({
        ...requireProjectBook(value),
        index: requireIndex(value),
        ...(ids ? { ids } : {}),
        ...(provenanceIds ? { provenance_ids: provenanceIds } : {}),
      }, requestOptions(context));
    }),
    tool('rag_index_rebuild', 'Create staging indexes and atomically move aliases after a model or schema change.', {
      type: 'object',
      additionalProperties: false,
      required: ['project_id', 'book_id'],
      properties: {
        ...PROJECT_BOOK_PROPERTIES,
        indexes: {
          type: 'array',
          items: { type: 'string', enum: ['story_memory', 'translation_memory', 'source_paragraph'] },
        },
        schema_version: { type: 'integer', minimum: 1 },
        force: { type: 'boolean' },
      },
    }, async (input, context) => {
      const value = requireRecord(input);
      const indexes = optionalIndexArray(value, 'indexes');
      const schemaVersion = optionalInteger(value, 'schema_version', 1);
      const force = optionalBoolean(value, 'force');
      return client.rebuildIndex({
        ...requireProjectBook(value),
        ...(indexes ? { indexes } : {}),
        ...(schemaVersion === undefined ? {} : { schema_version: schemaVersion }),
        ...(force === undefined ? {} : { force }),
      }, requestOptions(context));
    }),
    tool('rag_snapshot', 'Create a recoverable snapshot of one book RAG index.', {
      type: 'object',
      additionalProperties: false,
      required: ['project_id', 'book_id'],
      properties: {
        ...PROJECT_BOOK_PROPERTIES,
        destination: { type: 'string' },
      },
    }, async (input, context) => {
      const value = requireRecord(input);
      const destination = optionalString(value, 'destination');
      return client.snapshot({
        ...requireProjectBook(value),
        ...(destination === undefined ? {} : { destination }),
      }, requestOptions(context));
    }),
  ];
}

function tool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, JsonValue>>,
  run: (input: unknown, context?: RagToolContext) => Promise<unknown>,
): RagToolDefinition {
  return {
    name,
    description,
    input_schema: inputSchema,
    async execute(input, context) {
      return toJsonValue(await run(input, context));
    },
  };
}

function parseSearch(input: unknown): RagSearchRequest {
  const value = requireRecord(input);
  const topK = optionalInteger(value, 'top_k', 1, 100);
  const maxChapter = optionalInteger(value, 'max_chapter', 0);
  const chapterId = optionalString(value, 'chapter_id');
  const spoilerPolicy = optionalSpoilerPolicy(value, 'spoiler_policy');
  const filters = parseFilters(value['filters']);
  return {
    ...requireProjectBook(value),
    query: requireString(value, 'query'),
    ...(topK === undefined ? {} : { top_k: topK }),
    ...(chapterId === undefined ? {} : { chapter_id: chapterId }),
    ...(maxChapter === undefined ? {} : { max_chapter: maxChapter }),
    ...(spoilerPolicy === undefined ? {} : { spoiler_policy: spoilerPolicy }),
    ...(filters === undefined ? {} : { filters }),
  };
}

function parseFilters(input: unknown): RagSearchFilters | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = requireRecord(input);
  const sourceHashes = optionalStringArray(value, 'source_hashes');
  const instructionVersions = optionalIntegerArray(value, 'instruction_versions');
  const provenanceIds = optionalStringArray(value, 'provenance_ids');
  const entities = optionalStringArray(value, 'entities');
  const memoryTypes = optionalStringArray(value, 'memory_types');
  return {
    ...(sourceHashes ? { source_hashes: sourceHashes } : {}),
    ...(instructionVersions ? { instruction_versions: instructionVersions } : {}),
    ...(provenanceIds ? { provenance_ids: provenanceIds } : {}),
    ...(entities ? { entities } : {}),
    ...(memoryTypes ? { memory_types: memoryTypes } : {}),
  };
}

function parseMemoryRecord(input: unknown): RagMemoryRecord {
  const value = requireRecord(input);
  requireString(value, 'id');
  requireString(value, 'text');
  return value as unknown as RagMemoryRecord;
}

function requireProjectBook(input: unknown): { project_id: string; book_id: string } {
  const value = requireRecord(input);
  return { project_id: requireString(value, 'project_id'), book_id: requireString(value, 'book_id') };
}

function requireIndex(value: Record<string, unknown>): RagIndexName {
  const index = requireString(value, 'index');
  if (index !== 'story_memory' && index !== 'translation_memory' && index !== 'source_paragraph') {
    throw new TypeError('index must be story_memory, translation_memory, or source_paragraph');
  }
  return index;
}

function optionalIndexArray(value: Record<string, unknown>, key: string): readonly RagIndexName[] | undefined {
  const values = optionalStringArray(value, key);
  if (!values) {
    return undefined;
  }
  return values.map((entry) => requireIndex({ index: entry }));
}

function optionalSpoilerPolicy(
  value: Record<string, unknown>,
  key: string,
): RagSpoilerPolicy | undefined {
  const policy = optionalString(value, key);
  if (policy === undefined) {
    return undefined;
  }
  if (policy !== 'historical' && policy !== 'retrospective_constraint' && policy !== 'review_only') {
    throw new TypeError(`${key} has an unsupported spoiler policy`);
  }
  return policy;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('tool input must be an object');
  }
  return value as Record<string, unknown>;
}

function requireString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result.trim()) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  if (result === undefined) {
    return undefined;
  }
  if (typeof result !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }
  return result;
}

function optionalStringArray(value: Record<string, unknown>, key: string): readonly string[] | undefined {
  const result = value[key];
  if (result === undefined) {
    return undefined;
  }
  if (!Array.isArray(result) || !result.every((entry) => typeof entry === 'string')) {
    throw new TypeError(`${key} must be an array of strings`);
  }
  return result;
}

function optionalIntegerArray(value: Record<string, unknown>, key: string): readonly number[] | undefined {
  const result = value[key];
  if (result === undefined) {
    return undefined;
  }
  if (!Array.isArray(result) || !result.every((entry) => Number.isInteger(entry))) {
    throw new TypeError(`${key} must be an array of integers`);
  }
  return result as number[];
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const result = value[key];
  if (result === undefined) {
    return undefined;
  }
  if (!Number.isInteger(result) || (result as number) < minimum || (result as number) > maximum) {
    throw new TypeError(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return result as number;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const result = value[key];
  if (result !== undefined && typeof result !== 'boolean') {
    throw new TypeError(`${key} must be a boolean`);
  }
  return result as boolean | undefined;
}

function requestOptions(context?: RagToolContext): { signal: AbortSignal } | undefined {
  return context?.signal ? { signal: context.signal } : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
