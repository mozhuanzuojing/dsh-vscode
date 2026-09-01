# Changelog

本项目所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
