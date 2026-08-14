# Batch Translating：Windows 本地批处理翻译

> **定位提醒：这是一个「大批量」翻译工具。** 它用固定管线 + Agent Swarm 并行翻译整本书（EPUB/TXT），追求全书级的速度与一致性，代价是单句精修程度有限。
> 如果你的需求是**小批量、精修**（少量章节、逐句打磨、严格文学质量），请使用 [Agentic-Translating](https://github.com/SkylerZhu016/Agentic-Translating)，那里是单书精修工作流。
> 大批量翻译与精修是两个不同场景，不要混用。

## 一键启动（推荐）

**双击 `Batch Translating.exe`（Tauri 桌面版）**，应用会自动：

1. 检测本地 `127.0.0.1:58627` 是否已有翻译服务在运行；有则直接重连，没有则自动启动；
2. 在隐藏进程中启动 `batch-translating-engine.exe web --no-open --host 127.0.0.1 --port 58627`（该引擎基于 Kimi Code 二改的 SEA 单文件可执行，内置完整工作台）；
3. 等服务就绪后，在一个原生窗口中打开翻译工作台（无需浏览器，无需安装任何东西，Windows 11 / Win10 自带 WebView2）。

安装包由 GitHub Actions 自动构建（见仓库 `.github/workflows/desktop-build.yml`），产物只有两个程序：桌面壳 + `batch-translating-engine.exe` 引擎，**不包含任何源码、依赖目录、本地配置或密钥**。引擎的所有运行配置（账号、token、项目）都只读取最终用户自己主目录下的文件。

**关闭策略**：关闭工作台窗口不会停止翻译服务，长任务继续在后台跑；再次双击 `Batch Translating.exe` 即可重连。需要彻底退出时双击 `Stop Batch Translating.vbs`（或用任务管理器结束 `batch-translating-engine.exe`）。

## 备用启动方式（VBS 启动器）

这一层启动器把 `web` 命令包装成非技术用户可以双击使用的本地应用，功能与桌面版等价（只是用浏览器打开）。翻译引擎是项目自带的 SEA 可执行文件（发布包中名为 `batch-translating-engine.exe`，开发构建仍可能是 `kimi.exe`）；启动器不会改写 TOML、模型设置或任何翻译项目文件。

Windows 发布包中应把下列五个文件放在同一目录，并让引擎可执行文件与它们同级：

- `batch-translating-engine.exe`
- `Start Batch Translating.vbs`
- `Start-BatchTranslating.ps1`
- `Stop Batch Translating.vbs`
- `Stop-BatchTranslating.ps1`

用户双击 `Start Batch Translating.vbs` 即可。启动器会：

1. 在隐藏窗口中启动只监听 `127.0.0.1` 的本地服务；
2. 等待服务真正就绪；
3. 优先用 Edge、其次用 Chrome 的应用窗口模式打开；两者都不可用时改用系统默认浏览器；
4. 再次双击启动文件时，复用已有服务并重新打开窗口，不产生第二个翻译服务。

可选环境变量 `BATCH_TRANSLATING_BROWSER` 支持 `edge`、`chrome` 或 `default`；`BATCH_TRANSLATING_KIMI_EXE` 可指定引擎可执行文件的绝对路径。正常发布包不需要设置它们。

## 关闭策略（VBS 版）

关闭浏览器窗口不会停止本地翻译服务，因此长章节任务可以继续运行。再次双击启动文件会重新打开同一个应用。

需要完全退出时，双击 `Stop Batch Translating.vbs`。它通过只存在于当前 Windows 用户目录中的请求文件通知启动器，再由启动器携带内存中的凭据调用本地服务的正常关闭接口；凭据不会写入启动器状态文件或日志。正常关闭超时后，启动器只会终止自己创建且仍持有的服务进程。

Windows 注销或重启也会结束这一启动会话。

## 日志与隐私

启动器日志位于：

`%LOCALAPPDATA%\Batch Translating\logs\launcher-YYYYMMDD.log`

运行状态文件只记录管理进程、服务进程、本地地址和启动时间。启动 URL 中的令牌、Authorization 头和疑似令牌字段会在写日志前脱敏；完整令牌仅在启动器进程内存中用于首次打开窗口和正常关闭服务。

## 开发目录兼容

启动器不依赖固定安装目录。除同级引擎可执行文件（`batch-translating-engine.exe`，开发构建回退 `kimi.exe`）外，它还能识别本仓库的 `dist-native` 产物和 `apps/batch-translating-core/dist/main.mjs`；也可以通过 `BATCH_TRANSLATING_KIMI_EXE` 指向另一个位置。因此发布目录移动后仍可运行。
