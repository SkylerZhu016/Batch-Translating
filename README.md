# Batch Translating

> **定位提醒：这是「大批量」翻译工具。** 固定管线 + Agent Swarm 并行翻译整本书（EPUB/TXT），追求全书级速度与一致性，单句精修程度有限。
> 需要**小批量、精修**（少量章节、逐句打磨）时请使用 [Agentic-Translating](https://github.com/SkylerZhu016/Agentic-Translating) 的单书精修工作流。

把 Kimi Code 改造成的 **EPUB/TXT 批处理翻译工作台**：面向非技术用户的桌面式界面，翻译流水线轮次由应用锁定，Agent Swarm 并行执行，支持断点续跑、暂停/继续与随时纠偏。

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 这是什么

- **固定流水线，AI 不能自作主张**：解析 EPUB/TXT → 全书预分析 → 冒烟测试 → 第一轮翻译 → 第一轮独立审核 → 第一轮受约束修复（最低强制流程），可选第二轮翻译/审核与全书一致性审核，最后自动验收 + 导出成品（EPUB 或 TXT）。阶段推进、轮次数量只由应用代码决定；模型的任何输出都无法增加、删除、重复或重排阶段。TXT 源书按章节正则切分（默认支持「第X章/节/回/卷/部/篇」与 `Chapter N`，创建项目时可自定义）。
- **Agent Swarm 并行**：每阶段可配置 2–128 个 worker（默认 16），界面固定 4×4 一页展示，支持翻页；章节进度独立滚动。
- **随时纠偏**：底部固定输入框可随时修正 Agent 方向；纠偏带版本号排队，只在下一阶段边界生效，永不改变锁定流程。
- **断点续跑**：整个项目快照（阶段状态、问题台账、产物清单、纠偏记录）随会话元数据持久化；关闭窗口不影响任务继续运行，重开即恢复。
- **内置外观**：日间（纯白 / 枫叶）+ 夜间（墨黑 / 墨蓝）主题分别指定；内置完整 CJK 的霞鹜文楷（OFL-1.1）或跟随系统字体；主题与字体在首屏渲染前恢复，不闪烁。
- **Windows 一键启动**：双击 `Batch Translating.exe`（Tauri 桌面版）自动启动本地引擎（`batch-translating-engine.exe`，基于 Kimi Code 二改的 SEA 单文件）并在原生窗口打开工作台；关闭窗口不中断后台任务，再次双击即重连。
- **不绑定任何账号**：无登录流程。首次使用在工作台引导页填写模型接口 **Base URL** 与 **API Key**（OpenAI 兼容协议，兼容 NewAPI / OneAPI / Claude 等网关），一键「测试连接并自动获取模型列表」，保存即用。

## 快速开始（Windows）

**仅提供安装版**（GitHub Releases 下载 NSIS 安装包）：安装后双击 `Batch Translating.exe` 即可；安装包只含桌面壳与 `batch-translating-engine.exe` 引擎，不含源码、依赖、本地配置或密钥，引擎运行配置全部读取最终用户自己的主目录。

首次启动会在引导页提示配置模型服务（Base URL / API Key），保存后自动拉取上游模型列表，即可创建翻译项目。

**备用：VBS 启动器**（发布包或 `dist-native` 产物目录中的五个同级文件）：

```
batch-translating-engine.exe
Start Batch Translating.vbs
Start-BatchTranslating.ps1
Stop Batch Translating.vbs
Stop-BatchTranslating.ps1
```

双击 `Start Batch Translating.vbs` 即可。详见 [`apps/batch-translating-core/README.batch-translating.md`](apps/batch-translating-core/README.batch-translating.md)。

### 从源码开发

要求 Node.js ≥ 24.15、pnpm 10（仓库 `packageManager` 锁定 `10.33.0`）。

```powershell
pnpm install
pnpm --filter @moonshot-ai/kimi-web dev      # Web 工作台（开发服务器）
pnpm dev:server                               # 本地 kap-server（默认 127.0.0.1:58627）
```

Tauri 桌面壳的本地构建见 [`apps/batch-translating-desktop/README.md`](apps/batch-translating-desktop/README.md)（需要 Rust + MSVC，或直接使用 GitHub Actions 的 `desktop-build` 工作流）。

## 目录速览

| 位置 | 内容 |
| --- | --- |
| `apps/batch-translating-web/src/TranslationApp.vue` | 工作台入口（替代原 Kimi Code 的 Web 界面） |
| `apps/batch-translating-web/src/translation/` | 项目模型、固定阶段计划、阶段提示词、校验（含单元测试） |
| `apps/batch-translating-web/src/composables/useTranslationRunner.ts` | 阶段推进器：只由应用决定阶段转换，校验阶段结果 schema/版本/指纹 |
| `apps/batch-translating-web/src/components/translation/` | 项目、运行、问题汇总、成品、设置等视图组件 |
| `apps/batch-translating-web/public/fonts/lxgw-wenkai/` | 内置霞鹜文楷（完整 CJK，OFL-1.1） |
| `packages/agent-core-v2/.../profile/translation-*.md` | 五个翻译 Agent 档案的版本化角色合同 |
| `apps/batch-translating-core/src/cli/sub/translation/epub/` | 确定性 EPUB 解析/回装工具（`kimi translation epub …`） |
| `apps/batch-translating-core/src/cli/sub/translation/txt/` | 确定性 TXT 切分/组装工具（`kimi translation txt …`） |
| `apps/batch-translating-desktop/` | Tauri 桌面壳（单 exe 启动本地引擎 + 工作台窗口） |
| `apps/batch-translating-core/scripts/translation-launcher/` | Windows VBS 一键启动器（备用） |

## 迭代记录

第一轮迭代：Web 工作台、翻译 Agent 档案与项目生命周期协议、确定性 EPUB 工具与 Windows 启动器；第二轮迭代：TXT 源书支持与确定性章节切分、Tauri 桌面壳与打包流水线、定位提醒与打包卫生；第三轮迭代：仓库瘦身——移除与翻译功能无关的上游内容（TUI、vis/调试工具、文档站点、插件市场等），并将全部历史压为单个提交。开发记录文档保存在仓库之外，不随仓库分发。

## 许可

MIT。本项目基于 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)（MIT）改造，仅保留并扩展翻译工作流所需能力；内置霞鹜文楷字体遵循 OFL-1.1（见 `apps/batch-translating-web/public/fonts/lxgw-wenkai/OFL.txt`）。
