# DSH Client — 领域词表 (Domain Glossary)

## 核心概念

- **Harness** — DeepSeek Harness (DSH) 后端服务，运行在 `dsh web --port <port>`。提供 Web UI、`/api` RPC 端点、WebSocket 事件下行流。需要在 VSCode 扩展激活前/同时运行。
- **Proxy** — 本地反向代理（`src/proxy.js`），在 VSCode 扩展宿主内启动一个随机环回端口 HTTP 服务器，把 iframe 的请求转发到 Harness，拦截 `host.openPath` 和 `host.pickDirectory` RPC，并双向透传 WebSocket 事件流。
- **Config 模块** — 封装 `awakening.dsh.*` 配置命名空间的读取与校验（`src/config.js`），通过注入的 `getConfiguration` 函数访问 VS Code 配置。不包含编排/UI 逻辑。
- **Prompt 模块** — 交互式 Harness 地址补录（`src/prompt.js`），通过注入的适配器（`showInputBox`、`probe`、`persistUrl` 等）隔离 UI 副作用。流程逻辑可单测。

## 模块职责

| 模块 | 职责 | 测试入口 |
| --- | --- | --- |
| `src/config.ts` | 纯读配置，`createConfig(getConfiguration)` | 注入 fake `getConfiguration` |
| `src/prompt.ts` | 交互式补录流程，`createPrompt(deps)` | 注入 fake UI 适配器 |
| `src/proxy.ts` | HTTP 反向代理 + WS 透传 + RPC 拦截 | 完整冒烟 |
| `src/detect.ts` | Harness 端口探测，`probe`/`detectHarnessUrl` | 已可独立测试 |
| `src/proxy.ts` 可为扩展 tap mux 帧（onMuxFrame）→ 回合状态/审批/问题；editorContext.recall 走 ov find |
| `src/view.ts` | Webview iframe 视图（标题 `DSH Awakening :代理→真实`） | 需 VS Code 宿主 |
| `src/apply-diff.ts` | ② 应用 diff：agent 写文件后同步到编辑器（isDirty 保护 + 30s 窗口） | 需 VS Code 宿主 |
| `src/extension.ts` | 扩展入口：编排、激活、命令、诊断 | 需 VS Code 宿主 |

## 关键协议

- **RPC 信封**：`client-request` (POST) → `server-response`，路径 `/api/<method>`
- **openPath**：payload `{path:string}`，value `{opened:true}`
- **pickDirectory**：payload `{}`，value `{path:string|null}`（null=取消）
- **事件下行流**：WS `/api/events.mux` / `/api/events.host`
- **信任围栏**：Harness 校验 Host 为环回/受信 + Origin 同源；Proxy 统一改写 Host/Origin/Referer

## 配置命名空间

所有配置键以 `awakening.dsh.` 为前缀。详见 `src/config.js` 的 `createConfig` 接口。
