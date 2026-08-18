# Translation RAG

This workspace package provides the local retrieval backend used by Batch Translating. It has two deliberately separate parts:

- a TypeScript client/model manager for the desktop application;
- a loopback-only Python sidecar using the real `BAAI/bge-m3` model and persistent Qdrant storage.

Importing this package never starts the sidecar and never downloads a model. A download only begins after an explicit call to `BgeM3ModelManager.install()`/`download()` or the explicit `model download` CLI command.

## Runtime requirements

- Node.js as required by the parent workspace;
- Python 3.11+;
- the dependencies declared in `service/pyproject.toml`;
- a local BGE-M3 snapshot, installed through the app or discovered from an environment variable/Hugging Face cache.

GPU acceleration is optional. About 4 GB of available VRAM is recommended; the service reports its actual device and falls back to CPU when CUDA is unavailable. CPU indexing is slower but uses the same real embeddings.

Model discovery checks `BATCH_TRANSLATING_BGE_M3_PATH`, `BGE_M3_MODEL_PATH`, `BGE_M3_PATH`, the standard Hugging Face cache variables, and common user cache locations. The app may offer the official Hugging Face endpoint, `hf-mirror.com`, or an explicitly configured `HF_ENDPOINT`/`BATCH_TRANSLATING_HF_ENDPOINT`.

## Service lifecycle

```ts
import { TranslationRagService } from '@batch-translating/translation-rag';

const service = await TranslationRagService.start({
  dataRoot: projectRagDirectory,
  modelPath: discoveredModel.directory,
});

const client = service.client();
const health = await client.health();
await service.close();
```

The launcher selects an available port when `port` is omitted, generates a fresh bearer token and instance ID, and rejects non-loopback listeners. Project and book identifiers are mandatory on all index mutations and searches. Collection/alias names and payload filters provide defense-in-depth project isolation.

## Python environment

Install the sidecar dependencies into an application-owned virtual environment:

```text
python -m venv .venv
.venv/Scripts/python -m pip install ./service
```

Set `BATCH_TRANSLATING_RAG_PYTHON` to that environment's Python executable, or pass `pythonExecutable` to `TranslationRagService.start`. `probeRagPython()` reports missing optional runtime packages without installing or changing the environment.

The required authenticated API is: `GET /health`, `GET /index/status`, `POST /memory/upsert`, `POST /memory/delete`, `POST /story/search`, `POST /tm/search`, `POST /source/search`, `POST /verify`, `POST /index/rebuild`, and `POST /snapshot`.
