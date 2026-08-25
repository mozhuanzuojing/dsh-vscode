# RELEASING — 发布流程（含强制 Review 门禁）

> 目标：每次改动在「验证 & 发布」之前，必须经过一次 Review 门禁。
> 硬顺序：编码 → Review → 修复 → 验证 → 版本/打包 → 安装 → 发布。

## 标准管线（严格按序）

| 步骤 | 动作 | 命令/方式 |
| --- | --- | --- |
| 1 | 编码/改动 | 编辑 src / package / README |
| 2 | Review 门禁（强制） | 派子代理只读评审（requesting-code-review 技能/模板）；按 Critical/Important/Minor 分级；Critical 必改、Important 改完再进下一步 |
| 3 | 修复 | 按评审改；重要项改后回到步骤 2 复核 |
| 4 | 验证 | node --check src/*.js scripts/*.cjs + npm run smoke（需运行中的 harness）；全绿才继续 |
| 5 | 版本 bump | npm version <ver> -m "..."（自动提交 + 打 tag） |
| 6 | 打包 | npx -y @vscode/vsce package --out dsh-awakening-<ver>.vsix |
| 7 | 安装到扩展宿主 | 解压到 ~/.vscode-server/extensions/guxgn.dsh-awakening-<ver>/（或 code --install-extension dsh-awakening-<ver>.vsix），删旧版本，更新 extensions.json |
| 8 | 发布 | ① VS Code 市场：vsce-publish 或 npx -y @vscode/vsce publish（VSCE_PAT）② 新建 GitHub Release（挂 vsix）+ 删旧 release（仅保留最新） |

> **发布凭据**：PAT 存于 `~/.dsh/vscode-marketplace.pat`（chmod 600）；发布用 `vsce-publish`（等价 `VSCE_PAT=$(cat ~/.dsh/vscode-marketplace.pat) npx @vscode/vsce publish`）。
> **市场版本历史**：VS Code Marketplace 会保留已发的每个版本，CLI 不支持「只删某个旧版本」。只发新版本；不要用 `vsce unpublish`（会下架整个扩展）。清旧版本指仓库里的旧 `.vsix` 与本地旧扩展目录。

## Review 门禁要点

- 读完整文件：不只 diff，src/extension.js / proxy.js / detect.js / package.json 全读。
- Check 字段：功能对齐、边界/并发/生命周期、VS Code API 正确性、安全（仅 127.0.0.1 绑定）、文档与实现一致。
- 严重度：Critical（崩/数据/功能坏）先修；Important（架构/错误处理/测试缺口）改完才进「验证」；Minor 记录可后补。
- 不盲从：子代理发现的问题，回到代码核实后再采纳。

## 验证判据（步骤 4）

- npm run build：tsc 编译（typescript 7.0.2，须 0 错误）。
- node --check：可选（编译产物由 tsc 保证）。
- npm test：构建 + 运行单元测试（编译后）（注入 fake，不依赖 VS Code）。
- npm run smoke：HTTP 转发 / openPath / pickDirectory（选中+取消+降级开关）/ WS 透传 —— 8 项全绿。
- package.json JSON 校验、已装副本 = git 提交源码一致。

## 约定

- 中/英文 README 与代码同步。
- 每次发布同步更新 CHANGELOG.md；README 安装命令 / 市场 ID / 版本保持一致。
- Release 只保留最新一个；tag 保留（可选清理）。
- bump 语义：feat/breaking → minor；fix/doc 为主 → patch；大重构 → major。
