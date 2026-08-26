# Changelog

本项目所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
