# Batch Translating Desktop

这是 Batch Translating 的 Windows Tauri 桌面壳。它随安装包携带本机
`batch-translating-engine.exe`，自动启动本地工作台，并在 WebView2 窗口中打开。

## 运行与安全边界

1. 桌面壳优先请求 `127.0.0.1:58627`；若端口已占用，服务端可选择后续空闲端口，桌面壳以实际就绪地址为准。
2. 仅当 `runtime.json` 记录的 PID 仍存活、带本机 token 请求 `/api/v1/meta` 得到相同的 `server_id`、引擎版本和端口，并且记录的 SHA-256 与当前安装（或开发覆盖路径）中的引擎二进制完全一致时，才会复用已有引擎。这里比较的是引擎文件身份，不会把桌面壳的 `0.2.0` 与引擎自身版本错误对比。
3. 运行状态只保存 PID、服务身份、引擎版本、引擎文件指纹、origin、端口和时间，不保存 token、带 token 的 URL、RAG 资源路径或 CLI 路径。桌面壳仅在创建子进程时，把已验证引擎的绝对路径作为 `BATCH_TRANSLATING_CLI` 传给引擎，供 Coordinator 启动同一套 bundled CLI。token 继续由引擎保存在用户的 `.batch-translating/server.token`。旧版或缺少指纹的运行记录不会被复用。
4. 关闭窗口只隐藏到托盘，让长任务继续运行。桌面壳启动引擎后立即保留其 `Child` 句柄，并将它加入启用 `KILL_ON_JOB_CLOSE` 的 Windows Job Object；引擎后续启动的 RAG Python 服务也会继承同一个 Job。用户在托盘确认退出后，会先尝试受认证的 shutdown，让引擎优雅清理 Python 服务，再确保终止并回收自己启动的整个进程树。即使运行记录、token 缺失、HTTP 探测瞬时失败，或普通进程树终止命令失败，作业句柄关闭仍会兜底，避免自己启动的引擎或 Python 服务成为继续占用显存、产生模型成本的孤儿。
5. 对复用的外部引擎，桌面壳没有进程所有权，会保留启动时验证通过的身份快照；退出只向该快照中重新验证成功的服务发送认证关机请求，绝不按裸 PID 强杀外部进程。若外部服务未在期限内退出，其运行记录会保留供下次验证复用。运行期间替换 `runtime.json` 不能改变请求目标，身份不明时也不会按端口杀进程。
6. 引擎仅绑定 loopback，所有 HTTP 探测都有读写超时。

兼容开发构建时，程序旁的 `kimi.exe` 可作为内部 fallback；正式安装包使用产品名 sidecar。`BATCH_TRANSLATING_KIMI_EXE` 可在开发时覆盖路径。

## BGE-M3 与 RAG 资源

安装包只携带经过白名单校验的 RAG Python 服务源码，不携带 BGE-M3 模型、Python 虚拟环境、模型缓存、下载中的 `.partial` 文件或 RAG 数据库。应用只有在用户明确点击“下载/准备”后，才会从所选 Hugging Face 官方源或镜像下载模型并创建产品专用虚拟环境；这会占用数 GB 磁盘空间，使用 GPU 时建议约 4 GB 可用显存，GPU 不可用时可回退 CPU。

BGE-M3 用于检索术语、人物关系和跨章一致性证据，以提高长篇翻译质量。用户不安装时，翻译功能仍可使用，但工作流会强制加入额外审校与修订步骤，因此通常更慢，并增加模型调用成本。安装包不会静默联网下载模型或 Python 依赖。

## 本地构建

需要 Node.js 24.15.0、pnpm 10.33.0、Rust stable、MSVC 构建工具和 WebView2 Runtime。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm batch:build

Set-Location apps/batch-translating-core
$env:KIMI_CODE_EXECUTABLE_NAME = 'batch-translating-engine.exe'
corepack pnpm build:native:release
Set-Location ../..

New-Item -ItemType Directory -Force apps/batch-translating-desktop/src-tauri/binaries
Copy-Item apps/batch-translating-core/dist-native/bin/win32-x64/batch-translating-engine.exe `
  apps/batch-translating-desktop/src-tauri/binaries/batch-translating-engine-x86_64-pc-windows-msvc.exe

node scripts/ci/stage-rag-service.mjs

Set-Location apps/batch-translating-desktop
corepack pnpm exec tauri build
```

NSIS 安装包位于 `src-tauri/target/release/bundle/nsis/`。仓库的
`.github/workflows/batch-windows-build.yml` 执行相同构建、解包扫描并上传 CI artifact；它不会发布 GitHub Release。

安装包不得包含项目源码、`node_modules`、本机配置、API key 或 token；唯一例外是运行本地 RAG 必需、经确定性 staging 白名单选出的 Python 服务文件。CI 会扫描桌面可执行文件、sidecar、staged RAG 资源以及解包后的安装内容，最终只上传 NSIS 安装程序，不创建 GitHub Release。本地最终验收副本放在被 Git 忽略的 `dist-desktop/`。
