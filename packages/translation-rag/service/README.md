# Batch Translating RAG service

这是 Batch Translating 的本机检索 sidecar。它使用真实的
[`BAAI/bge-m3`](https://huggingface.co/BAAI/bge-m3) / FlagEmbedding 推理和持久化
Qdrant，不包含 mock 检索路径。

## 安装与启动

Python 3.11 或更高版本：

```powershell
python -m pip install -e .
$env:BATCH_TRANSLATING_RAG_PORT = "0"
$env:BATCH_TRANSLATING_RAG_TOKEN = '<由桌面启动器为本次进程随机生成的 token>'
python -m translation_rag_service.server
```

服务只接受 `127.0.0.1`、`::1` 或 `localhost`，非 loopback 地址会直接拒绝启动。
端口可以设为 `0`；服务预绑定可用端口，并输出一行：

```text
BATCH_TRANSLATION_RAG_READY {"url":"http://127.0.0.1:49152","instance_id":"...","pid":1234,"capabilities":{...}}
```

ready 行不会包含 token。桌面启动器通过 `BATCH_TRANSLATING_RAG_TOKEN` 注入每次启动新生成的
token，并用 `BATCH_TRANSLATING_RAG_INSTANCE_ID` 核验进程。如果直接手工启动且未提供 token，
服务会自行生成，并写入用户应用数据目录下权限受限的 `instance.token`；进程退出时删除。
所有 API（包括 health）均要求 `Authorization: Bearer <token>`。

## 模型发现与镜像

默认模型是 `BAAI/bge-m3`。服务按以下顺序发现模型：

1. `BGE_M3_MODEL_PATH`、`BGE_M3_PATH` 或 `BATCH_TRANSLATING_BGE_M3_PATH`；
2. `HUGGINGFACE_HUB_CACHE`、`HF_HUB_CACHE`、`TRANSFORMERS_CACHE`、`HF_HOME`；
3. Hugging Face 默认缓存。

桌面应用的一键下载会先提示：BGE-M3 用于提高翻译一致性与质量，建议约 4 GB 可用显存；
没有 GPU 时可使用 CPU，只是速度较慢。国际用户使用 Hugging Face 官方源即可；需要镜像时在下载
设置中选择 HF-Mirror 或配置 `HF_ENDPOINT`。下载只由桌面端显式的模型管理器执行，支持进度、取消、
校验和续传；sidecar 启动本身永远不会暗中联网下载模型。

启动时优先使用 CUDA，其次 MPS，最后 CPU。也可设置
`BATCH_TRANSLATING_RAG_DEVICE=cpu|cuda|mps|auto`。GPU 初始化失败会自动重试 CPU。
FlagEmbedding 会分别探测 dense、sparse lexical weights 与 ColBERT vectors：dense 是硬要求；
sparse 或 ColBERT/Qdrant multivector 不可用时，health 与 search 会明确返回 `degraded` 和 warning，
并使用真实 dense 检索，不会把 dense 冒充 hybrid。

模型 fingerprint 由 revision 和模型配置、tokenizer、代码及权重文件 SHA-256 共同生成；未变化的
文件签名会复用本地 fingerprint 缓存。

## 存储与隔离

- SQLite `rag-canonical.sqlite3` 是可确定重放的 canonical state，包含原始 RAG records、检索消费
  日志、index generation，以及 characters、aliases、relationships、locations、items、terms、
  recurring_phrases、character_voice、retrospective_constraints 表。
- Qdrant 只保存可重建索引。默认使用数据目录内 embedded Qdrant；配置
  `BATCH_TRANSLATING_QDRANT_URL`（以及可选 API key）可连接持久化远端 Qdrant。
- collection 和 alias 带不可逆 project hash；每次查询仍强制同时使用 `project_id`、`book_id`
  payload filters，因此项目和书籍不会串库。
- point ID 是 project/book/index/logical record ID 的 UUIDv5，重复 upsert 幂等。
- schema 或模型 fingerprint 改变时，下一次使用该 index 会从 canonical records 创建 staging
  collection，核对数量后通过一次 alias transaction 原子切换。旧 collection 按保留策略清理。

## API

无 `/v1` 前缀：

- `GET /health`
- `GET /index/status?project_id=...&book_id=...`
- `POST /memory/upsert`
- `POST /memory/delete`
- `POST /story/search`
- `POST /tm/search`
- `POST /source/search`
- `POST /verify`
- `POST /index/rebuild`
- `POST /snapshot`

所有写入和查询都要求 `project_id` 与 `book_id`。检索支持 chapter/spoiler、source hash、
instruction version、provenance、entity 与 memory type filters；执行 dense top-k，可用时融合 sparse
和 ColBERT，之后进行 entity/importance boost、去重和 evidence budget 截断。响应中的
`consumed_memory_ids` 同时写入 SQLite retrieval log，供 Translator artifact 审计。

TM 只接受带 `approval: "approved" | "final"`（或等价布尔字段）的人工/流程批准译文；检索先做
规范化 exact match，再做 fuzzy/vector。

`/snapshot` 总会生成指定 project/book 的 canonical JSONL 与 manifest。远端 Qdrant 支持原生
snapshot 时会同时请求原生快照；embedded Qdrant 不支持原生 snapshot 的版本会明确 warning，
canonical export 仍可通过 `/index/rebuild` 完整重建索引。

## 主要环境变量

| 变量 | 默认值/用途 |
| --- | --- |
| `BATCH_TRANSLATING_RAG_DATA_ROOT` | 用户应用数据目录 |
| `BATCH_TRANSLATING_RAG_PORT` | `17349`；可设 `0` |
| `BATCH_TRANSLATING_RAG_TOKEN` | 启动器提供的本次启动 bearer token |
| `BATCH_TRANSLATING_RAG_INSTANCE_ID` | 启动器握手 ID |
| `BATCH_TRANSLATING_RAG_EMBEDDING_BATCH_SIZE` | `8` |
| `BATCH_TRANSLATING_RAG_SCHEMA_VERSION` | `1` |
| `BATCH_TRANSLATING_RAG_DEVICE` | `auto` |
| `BATCH_TRANSLATING_QDRANT_PATH` | embedded Qdrant 路径 |
| `BATCH_TRANSLATING_QDRANT_URL` | 可选远端 Qdrant URL |
| `BATCH_TRANSLATING_QDRANT_API_KEY` | 可选远端 API key |
