# Changelog

本项目所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.7.16] - 2026-09-03

### 🔐 proxy 预取 launch-token 会话 cookie（修复 iframe 仍 authentication required）

0.7.15 修好 activate 崩溃后，iframe 仍偶发 `authentication required`——因为 VSCode webview 的 iframe 加载 `?token=` 时拿到 303 + set-cookie 但**不可靠地保存/发送跨源 cookie**，跟随到 `/` 时无 cookie → harness 401。

- **proxy 层预取**：`createProxy` 增加 `launchToken`，启动后 lazy 用 token 访问 `baseUrl/?token=` 换 `dsh-auth-*` 会话 cookie 缓存；**转发所有 Web 请求时带该 cookie**。iframe 发普通 `/` 请求即可认证（不再依赖 iframe 的 303/cookie 交换）。
- 端到端验证：proxy(launchToken) → iframe 普通 `/` → 200 + `__DSH_BOOT__`。
- `iframeSrc` 首次仍带 `/?token=`（换 cookie 兜底），但主路径由 proxy cookie 承载。

## [0.7.15] - 2026-09-03

### 🐛 修复 activate 崩溃：editor-context 的 getText 用 vscode.Range

此前 `src/editor-context.ts` 里 `doc.getText({ start: {line,character}, end: {line,character} })` 传的是**普通对象字面量**，而 `TextDocument.getText()` 需要真正的 `vscode.Range` 实例——VS Code 运行时抛 **`Invalid argument`**，导致 `activate()` 崩溃（`editor-context.js:68 refresh`）。这是"给了正确 token 仍 401 + 状态栏消失"的最终根因（activate 崩溃 → proxy 不启动 → iframe 401）。

- **修复**：`refresh` 里改用 `new vscode.Range(new vscode.Position(0,0), new vscode.Position(lastLine,0))` 传给 `doc.getText()`。
- `VscodeLike` 接口补充 `Position`/`Range` 构造器声明（运行时注入真实 vscode）。
- 此前该 bug 在无选区打开文件时触发（`!sel` 分支），activate 即崩；修复后正常。

## [0.7.14] - 2026-09-03

### 🐛 修复激活崩溃：打包遗漏 production 依赖 ws（状态栏消失）

此前 `vsce package --no-dependencies` 打包把 proxy 依赖的 Node 模块 **`ws` 排除了**，导致扩展激活时 `Cannot find module 'ws'` → activate() 崩溃 → **底部状态栏不创建（消失）**。

- **根因**：`vsce package --no-dependencies` 不打包 `node_modules`，而 `src/proxy.ts` 依赖 `ws`（WS 双向隧道）。
- **修复**：打包**不再**加 `--no-dependencies`（vsce 自动打包 production 依赖 `ws`），.vsix 含 `node_modules/ws`。
- 重新打包验证：0.7.13 修复后 .vsix 36 文件 / 88.91KB（含 ws）；`require('ws')` 在安装目录可解析。
- 注意：0.7.12 / 0.7.13（此前用 `--no-dependencies` 发）在 Marketplace 上缺 ws、本地装后激活崩溃，本版本修复。

## [0.7.13] - 2026-09-03

### 🔐 完整支持带 token 的 harness 地址解析（launch-token 认证）

把 token 解析从「restartProxy 一处兜底」提升为**系统性支持**——所有入口（配置 `awakening.dsh.baseUrl`、prompt 录入、自动检测）都统一走 `splitLaunchToken`，url 归一为干净 origin、token 单列，下游一致。

- **`resolveHarnessBaseUrl`**：返回前即用 `splitLaunchToken` 归一（干净 origin + `launchToken`），不再靠 `restartProxy` 二次处理；显式配置与自动检测两条路径统一。
- **`openInBrowser`**：浏览器直接打开改为拼 `/?token=<launchToken>`（此前用干净 proxy.baseUrl 打开会 401）。
- **`splitLaunchToken`**：兼容带 token + 其他 query（`?token=abc&x=1` 取 token、丢弃其余）、无协议补全（`127.0.0.1:3082?token=zzz`）、无 token 归一等。
- 已验证所有 URL 变体解析正确；token 只在 iframe 首次 / 浏览器打开时拼接，proxy baseUrl 始终干净。

> `awakening.dsh.baseUrl` 可直接填 `dsh web` 打印的完整地址（含 `?token=…`）。

## [0.7.12] - 2026-09-03

### 🔐 适配 DSH 0.1.2-rc.1 launch-token 认证（修复 "authentication required"）

DSH 0.1.2-rc.1 的 web 界面**强制 launch-token 认证**：进程启动时随机生成 `?token=…`，首次访问用它换 `dsh-auth-*` 会话 cookie，之后 cookie 认证；无 token 的请求一律 401（无 loopback 例外）。dsh-vscode 此前是透明转发、iframe 不带 token，导致 VSCode 里报 `dsh web authentication required; reopen the URL printed by dsh web`。

- **C1（Critical）**：`detect.ts` 的 `probe` 适配认证——`fetch(…, {redirect:'manual'})` 拿 303 的 `set-cookie`，再带 cookie 请求干净 `/` 验证 `__DSH_BOOT__`；不再被 401 占位页误导为"不可用服务"。新增 `splitLaunchToken()`：从用户填的带 token 地址提取 launch token、把 baseUrl 归一为干净 origin。
- **C1（Critical）**：`extension.ts` 用 `splitLaunchToken` 归一 proxy 的 baseUrl（干净 origin，token 不残留——否则已认证请求会被 harness 反复 303 重定向），并保存 `currentLaunchToken`。
- **C1（Critical）**：`view.ts` 的 iframe 首次 `src` 带 `/?token=<launchToken>`（换 cookie），token 只出现在首次；后续 iframe 内部导航由浏览器带 cookie。
- 新增 `splitLaunchToken` 单测（test-units）。

> 若你在 DSH 0.1.2-rc.1 下报 "authentication required"，用 `dsh web` 打印的完整地址（含 `?token=…`）配置 `awakening.dsh.baseUrl` 即可自动认证。

## [0.7.11] - 2026-09-03

### 🔧 适配 DSH 0.1.2-rc.1（namespaced Remote RPC）

DSH 0.1.2 把 flat `/api/ns.method` RPC gateway 改为 namespaced Remote 协议，文件打开与目录选择接口更名。proxy 需同步拦截新端点，否则 VSCode 编辑器联动（点击 DSH 文件路径打开、目录选择器）失效。

- **C1（Critical）**：`host.openPath`（文件打开）→ `session.openWorkspacePath`。请求仍为 `{path}`，应答 `{opened:true}`，拦截逻辑不变，仅改端点匹配。
- **C1（Critical）**：`host.pickDirectory`（目录选择）→ `directoryPicker.pick`。应答 value 由 `{path: string|null}` 改为**裸字符串路径（或 null）**，拦截应答同步改为裸字符串。
- **次要**：WS 事件流测试引用 `/api/events.host` 改为 `/api/events.mux`（proxy 本就按 `events.mux` 透传，测试脚本同步）。
- proxy-smoke / probe 测试脚本端点与新契约同步。

## [0.7.10] - 2026-09-01

### 🐛 修复（Review 门禁：Critical/Important）

- **C1（Critical）**：顶部「全部应用」被误判为「全部忽略」——因批量项按 label 前缀匹配，codicon 前缀破坏匹配，导致点「全部应用」实际执行「全部忽略」。改为布尔标记（`applyAll`/`ignoreAll`）分发。
- **I1（Important）**：diff 快照临时文件仅用 basename，跨目录同名/中文名会碰撞；改为 basename + fsPath hash + 递增序号唯一后缀。
- **m5**：openviking-mcp `clientInfo` 版本同步到 0.7.10。

## [0.7.9] - 2026-09-01

### 🧹 界面精简

- **移除状态栏「DSH 回合中 / DSH 空闲」指示**：连同 `dsh.cancelSession` 命令一起移除（其唯一入口即该状态栏）；审批/澄清下沉、OpenViking 回忆等能力不变。
- README / CONTEXT 描述同步更新。

### ✨ 功能增强

- **应用 diff 改为确认制**：agent 写文件后不再直接同步到编辑器，而是弹「变更文件列表 → diff 预览 → 应用/忽略」确认流（沿用 30s 回合窗口 + isDirty 保护，绝不覆盖未保存修改）；支持**一键全部应用 / 全部忽略**。
- **上下文按需注入（A2a）**：`[User Input]` 上下文仅在编辑器右键「解释/修复/重构」时注入（带 `_dshEditorContext` 标记）；DSH 界面直接输入的普通 prompt 不再自动注入，避免会话历史堆积脏上下文。

## [0.7.8] - 2026-08-26

### ✨ 界面调整

- **移除编辑器标题栏「Awakening: 配置 harness 地址」齿轮按钮**：配置入口仅保留「DSH: 诊断」面板中的 quick-pick。
- **标题栏「Open DSH Sidebar」按钮缩短为「DSH」**：命令 title 由 `Open DSH Sidebar` 改为 `DSH`。
- README / README.en 命令表同步更新。

## [0.7.6] - 2026-08-25

### 🐛 修复（Review：遗漏 / 因果颠倒）

- **openSettings**：`@ext` 目标改为当前扩展 ID（`context.extension.id`），适配发布后的 `guxgn.dsh-awakening`（不再硬编码 `local.dsh-vscode`）。
- **openInBrowser**：改用实际解析到的 harness 地址（`proxy.baseUrl`），自动检测到非默认端口时不再开错地址。
- **editorContext**：`content (full)` 仅在文件行数 ≤200 且 ≤8000 字符时成立，避免把「前 200 行」误标为「全文」。
- **openSidebar**：遵循 `autoMoveToSecondarySidebar` 配置，不再无条件移入辅助侧边栏。
- **openviking-mcp**：MCP `clientInfo` 身份改为 `dsh-awakening / 0.7.6`（原 `dsh-vscode / 0.7.5`）。

### 🚀 发布

- 以 **`guxgn.dsh-awakening`** 发布到 VS Code Marketplace（`v0.7.6`）。
- README / README.en 安装命令、RELEASING 打包/发布流程同步为 `guxgn.dsh-awakening` / `dsh-awakening-<ver>.vsix`。

## [0.7.5] - 2026-08-25

### 🐛 修复

- OpenViking MCP review fixes：`mcpFind` 可中止（AbortController 3s）、会话缓存、ok/empty 语义、版本号同步。
