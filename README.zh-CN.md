# Batch Translating

[English](README.md) | **中文**

面向长篇 **EPUB/TXT 文学翻译**的 Windows 桌面工作台，构建在 Kimi Code Agent 运行时之上。整本书的翻译由单个 Coordinator Agent 统一调度与纠偏；其余一切 —— 项目状态、重试/恢复、检索、质量门、成本核算、最终 EPUB 重建 —— 都由持久、可审计的基础设施兜底，而不是只靠 prompt 里宣称。

**0.2.0 版** · Windows（NSIS 安装包）· Node 24.15.0 · pnpm 10.33.0

Batch Translating 已能稳定运行小说级完整翻译项目，支持持久恢复、本地检索、多轮审校、上下文压缩、费用统计与确定性 EPUB 重建。

```
用户消息 ─▶ Kimi Web Session ─▶ Coordinator Agent ─▶ 翻译/记忆/审校 Agent 集群
                                              │
                                              ▼
                  SQLite/WAL 项目账本 · BGE-M3/Qdrant RAG · 确定性 EPUB 重建
```

## 核心特性

- **原生 Agent 控制面** —— Coordinator 通过与普通编程 Agent 完全相同的 Kimi Code session/goal/prompt 工具/事件路径驱动整本书。运行中的用户消息（包括即时纠正）会立刻传给 Coordinator，并持久化为带版本的 instruction event；Stop / Cancel / Pause / Resume / 重试各自有独立语义。
- **持久项目账本** —— SQLite/WAL 承载项目、不可变源、段落、任务 DAG（claim/lease/attempt）、内容寻址幂等、不可变 artifact、单一 merger 的 fencing lease 和 fail-closed 完成门。重启或重试后的成功任务绝不再计费重跑。
- **真实检索（不 mock RAG）** —— 本地 Python 服务运行 FlagEmbedding **BGE-M3**（dense + sparse + ColBERT/rerank），以 **Qdrant** 做向量存储：按项目隔离索引、canonical 角色/实体/时间线状态、Story Memory、仅采纳 approved 译文的 Translation Memory、防剧透检索、CPU fallback。BGE-M3 可选；缺失时明确降级为更贵的“两章上下文 + 双轮审校”策略。
- **完整质量闭环** —— 记忆抽取/整合、翻译、三类审校（忠实度/自然度/连续性）、哈希校验的修复 patch、冲突仲裁，以及必须清零所有高/严重问题的一致性审计。最终成书从不可变源确定性重建、结构校验、并给出字节级收据。
- **成本控制** —— soft/hard 项目预算由账本强制执行；按项目归账的逐请求 usage、token/缓存/价格快照；价格不可得时明确标记 `unavailable`，绝不伪造零成本。
- **长任务会话控制** —— 自动与手动上下文压缩让小说级项目可以持续推进；系统提醒、思考过程与工具结果默认折叠，需要时仍可展开查看。
- **桌面体验** —— 中英双语 UI、一键创建项目（使用你自己的已配置/默认模型，项目内固定、绝不静默换模）、脱敏诊断导出、Windows Job Object 监督的 engine/sidecar 进程树。

## 开发起步

要求：**Node.js 必须为 24.15.0**（更新的 24.x 在 Windows 上有已确认的 libuv `fs.watch` 原生崩溃；仓库、CI 与 SEA 构建统一拒绝错误版本）、pnpm 10.33.0、Rust stable（仅桌面端需要）。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm batch:dev:web      # Web 工作台（界面）
corepack pnpm batch:dev:server   # 本地引擎（API + Agent）
```

常用检查：

```sh
corepack pnpm batch:typecheck
corepack pnpm batch:test
corepack pnpm batch:style
corepack pnpm batch:build
```

## 构建 Windows 安装包

NSIS 安装包由 Tauri 产出，本地验收构建放入已忽略的 `dist-desktop/`：

```sh
corepack pnpm batch:desktop:release
# → dist-desktop/Batch Translating_0.2.0_x64-setup.exe
```

发布辅助脚本只暂存白名单内的 RAG 服务源码，并检查模型、虚拟环境、缓存、凭据、数据库、测试和本地项目数据不会进入安装包。本机缺少 `signtool` 只会产生签名提示，不影响 SEA 注入与启动。最终安装包会复制到 `dist-desktop/`。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `apps/batch-translating-web` | 双语 Web 工作台：项目创建、BGE 状态/下载、预算、进度与诊断 |
| `apps/batch-translating-core` | 原生引擎（KAP server + 翻译 CLI），作为桌面 sidecar 打包 |
| `apps/batch-translating-desktop` | Tauri Windows 壳、engine/sidecar 监督、RAG 暂存 |
| `packages/translation-domain` | 持久 SQLite/WAL 项目账本：幂等、租约、成本事件、完成门 |
| `packages/translation-rag` | Python RAG 服务（BGE-M3 + Qdrant + canonical SQLite）与 TypeScript 客户端 |
| `packages/translation-tools` | 确定性 EPUB/TXT 解析、唯一 merger、重建、验证与报告 |
| `packages/kap-server` | 鉴权 REST/WebSocket API、翻译/RAG 路由、agent-core-v2 宿主 |
| `packages/agent-core-v2` | 承载 Coordinator 与翻译 Agent profiles 的 DI×Scope Agent 引擎 |

## 许可证

MIT —— 见 [LICENSE](LICENSE)。产品分支以 `@moonshot-ai/kimi-code@0.33.0` 为可追溯上游祖先；上游包与 notice 保留在源码中。
