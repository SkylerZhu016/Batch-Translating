# Batch Translating

Batch Translating 是一个面向长篇 EPUB/TXT 文学翻译的 Windows 桌面工作台。它复用 Kimi Code 的 session、工具、任务和事件基础设施，并提供书籍导入、章节进度、翻译审校与产物导出界面。

当前仓库处于分阶段迁移期。已经存在的能力会按自动测试和真实 EPUB 验收结果逐项标记；尚未接通的 RAG、成本账本或恢复能力不会在本文中宣称可用。

## 当前可用范围

- EPUB/TXT 只读导入与项目工作区；
- 同一 Kimi Web session 中的对话、工具事件和翻译面板；
- 已迁移的翻译项目界面，以及 EPUB/TXT 本地解析与导出工具；
- Windows Tauri 桌面壳与本机 sidecar engine；
- 脱敏诊断包导出；
- 使用冻结依赖锁的 CI，以及 Windows 安装包、秘密与产物扫描工作流。

源文件不会被原地覆盖。输出写入独立项目目录；运行模型由本机 Batch Translating 配置决定，应用不会静默切换 provider/model。

完整的 Coordinator 翻译、审校、修复、RAG、成本账本与断点恢复仍在后续阶段接通；当前版本不把这些迁移中的链路视为可用能力。

## 开发

要求：Node.js 24.15.0 或更高版本、pnpm 10.33.0、Rust stable（构建桌面端时需要）。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm batch:dev:web
corepack pnpm batch:dev:server
```

常用检查：

```sh
corepack pnpm batch:typecheck
corepack pnpm batch:test
corepack pnpm batch:style
corepack pnpm batch:build
```

Windows 桌面安装包由 `.github/workflows/batch-windows-build.yml` 构建。工作流使用锁文件中精确固定的 Tauri CLI，并且只有构建成功后才会产生名为 `batch-translating-windows-<commit-sha>` 的 artifact。该 artifact 只包含已内置 sidecar engine 的 NSIS 安装包；Tauri 的裸桌面可执行文件不能脱离 sidecar 单独使用，也不会被上传。本地验收构建放入仓库忽略的 `dist-desktop/`。

`.github/workflows/batch-release.yml` 只能手动触发，并且只接受 Windows build 与同一提交的完整 `batch-ci` 都已通过的构建记录。它不会由 push 或 tag 自动发布。

## 上游与许可证

产品分支以 Kimi Code `@moonshot-ai/kimi-code@0.33.0`（`53c832dfdf9566afd59a8b3d54ebd36d3cb03d72`）为可追溯祖先，保留上游包、许可证和贡献历史。Batch Translating 的翻译界面、EPUB/TXT 工具与桌面品牌作为产品层维护。

项目按 [MIT License](LICENSE) 发布。上游贡献者信息和各依赖许可证随源码及构建时生成的第三方许可证清单保留。
