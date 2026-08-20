# Batch Translating

**English** | [中文](README.zh-CN.md)

A Windows desktop workbench for long-form **EPUB/TXT literary translation**, built on top of the Kimi Code agent runtime. Translation is scheduled and steered by a single Coordinator agent; everything else — project state, retry/recovery, retrieval, quality gates, cost accounting and final EPUB rebuild — is backed by persistent, auditable infrastructure instead of prompt promises.

**Version 0.2.0** · Windows (NSIS installer) · Node 24.15.0 · pnpm 10.33.0

Batch Translating can run a complete novel-length translation project with persistent recovery, local retrieval, multi-round review, context compaction, cost tracking, and deterministic EPUB reconstruction.

```
用户消息 ─▶ Kimi Web Session ─▶ Coordinator Agent ─▶ 翻译/记忆/审校 Agent Swarm
                                              │
                                              ▼
                    SQLite/WAL 项目账本 · BGE-M3/Qdrant RAG · 确定性 EPUB 重建
```

## Highlights

- **Agent-native control plane** — the Coordinator drives the whole book through the same Kimi Code session, goal, prompt and tool/event path used for normal coding agents. User messages (including mid-run corrections) steer the Coordinator immediately and are persisted as versioned instruction events; Stop/Cancel/Pause/Resume/retry have distinct semantics.
- **Durable project ledger** — SQLite/WAL keeps projects, immutable sources, paragraphs, a task DAG with claim/lease/attempt, idempotent content-addressed reruns, immutable artifacts, a single fencing-merger lease, and a fail-closed completion gate. A restarted or retried successful task never re-bills.
- **Real retrieval (no mock RAG)** — a locally hosted Python service runs FlagEmbedding **BGE-M3** (dense + sparse + ColBERT/rerank) with a **Qdrant** vector store, per-project index isolation, canonical character/entity/timeline state, Story Memory, approved-only Translation Memory, spoiler-aware retrieval, and CPU fallback. BGE-M3 is optional; without it the pipeline degrades to a clearly more expensive two-chapter-context + double-review strategy.
- **Full quality pipeline** — memory extraction/consolidation, translation, three review tracks (fidelity / naturalness / continuity), repair with hash-verified patches, conflict arbitration, and a consistency audit that must resolve all high/critical issues. The final book is rebuilt deterministically from the immutable source, structure-validated, and byte-receipted.
- **Cost control** — soft/hard project budgets enforced in the ledger, per-request usage accounting keyed to the project, token/cache/price snapshots, and explicit `unavailable` pricing instead of fake zero cost.
- **Long-running session control** — automatic and manual context compaction keeps novel-length projects manageable; system reminders, reasoning and tool results stay collapsed by default while remaining available on demand.
- **Desktop polish** — bilingual (中文/English) UI, one-click project creation with your own configured provider/model pinned per project (never silently switched), in-app diagnostics export, and a supervised engine/sidecar process tree under a Windows Job Object.

## Getting started (development)

Requirements: **Node.js exactly 24.15.0** (newer 24.x releases hit a confirmed libuv `fs.watch` crash on Windows — the repo, CI and SEA build all reject wrong versions), pnpm 10.33.0, Rust stable (desktop only).

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm batch:dev:web      # web workbench (UI)
corepack pnpm batch:dev:server   # local engine (API + agents)
```

Common checks:

```sh
corepack pnpm batch:typecheck
corepack pnpm batch:test
corepack pnpm batch:style
corepack pnpm batch:build
```

## Building the Windows installer

The NSIS installer is produced by Tauri. Local acceptance builds go to the ignored `dist-desktop/` directory:

```sh
corepack pnpm batch:desktop:release
# → dist-desktop/Batch Translating_0.2.0_x64-setup.exe
```

The release helper stages only whitelisted RAG service sources and checks that models, virtual environments, caches, credentials, databases, tests, and local project data do not enter the installer. A local `signtool` warning does not affect SEA injection or startup. The final installer is copied to `dist-desktop/`.

## Repository layout

| Path | Role |
|---|---|
| `apps/batch-translating-web` | Bilingual web workbench: project creation, BGE status/download, budgets, progress and diagnostics |
| `apps/batch-translating-core` | Native engine (KAP server + translation CLI), bundled into the desktop sidecar |
| `apps/batch-translating-desktop` | Tauri Windows shell, engine/sidecar supervision, RAG staging |
| `packages/translation-domain` | Durable SQLite/WAL project ledger, idempotency, leases, cost events, completion gate |
| `packages/translation-rag` | Python RAG service (BGE-M3 + Qdrant + canonical SQLite) and its TypeScript client |
| `packages/translation-tools` | Deterministic EPUB/TXT parsing, unique merger, rebuild, validation and reports |
| `packages/kap-server` | Authenticated REST/WebSocket API, translation/RAG routes, agent-core-v2 hosting |
| `packages/agent-core-v2` | The DI×Scope agent engine hosting the Coordinator and translation agent profiles |

## License

MIT — see [LICENSE](LICENSE). The product branch keeps a traceable upstream ancestor at `@moonshot-ai/kimi-code@0.33.0`; upstream packages and notices remain with the source.
