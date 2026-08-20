# Batch Translating Core

Batch Translating Core 是桌面应用随附的本地翻译引擎。它在 loopback 地址提供工作台 API，承载长期 Coordinator 会话、Agent/AgentSwarm、项目台账、BGE-M3/Qdrant 检索、费用统计、上下文压缩与确定性 EPUB/TXT 重建。

## 面向用户的运行方式

安装 Windows 版后直接启动 Batch Translating。桌面壳会验证并启动同版本的 `batch-translating-engine.exe`，连接本机工作台，并监督引擎及 RAG sidecar 的完整进程树。关闭窗口会让长任务留在托盘继续运行；使用应用内“退出应用”或托盘退出可以安全停止由桌面端创建的全部相关进程。

模型、API 密钥、BGE-M3 与价格均在应用界面配置。项目固定使用创建时选定的模型，费用提醒线只发出提醒，费用硬上限会阻止领取新的付费任务。会话支持主动压缩上下文，暂停、恢复和用户即时纠偏均保留在同一长期任务中。

## 数据与恢复

用户配置和会话默认保存在 `%USERPROFILE%\\.batch-translating`，每个翻译项目保存在用户选择的项目目录。项目内的 SQLite/WAL 台账负责断点续跑、任务去重、租约、尝试次数、费用、问题、补丁和成品回执；Coordinator 只通过随附的 `translation ledger` 命令访问台账，不直接查询数据库文件。

BGE-M3 模型、Python 虚拟环境、Qdrant 数据、API 密钥和本地翻译项目不会进入安装包或源码仓库。BGE-M3 可由应用显式准备，GPU 不可用时可以回退 CPU。

## 开发

要求 Node.js 24.15.0 与 pnpm 10.33.0。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm batch:dev:server
corepack pnpm batch:dev:web
```

构建产品 Web 资源与引擎：

```sh
corepack pnpm batch:build
```

桌面安装包的完整构建说明见 [`../batch-translating-desktop/README.md`](../batch-translating-desktop/README.md)。
