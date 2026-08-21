# DSH Client

> 在 VSCode 里用 100% 原版 DSH Web 界面

在 VSCode 辅助侧边栏（secondary sidebar）内嵌原版 DeepSeek Harness (DSH) Web 界面，点击对话/轨迹里的文件路径直接在 VSCode 编辑器里打开 —— 快速文件阅读。

## 原理（方案 A2：本地代理 + iframe）

```
┌───────────────────────── VSCode ─────────────────────────┐
│  辅助侧边栏 webview 视图 (dsh.chatView)                    │
│  ┌─────────────────────────────────────────┐             │
│  │  iframe ──► http://127.0.0.1:<随机端口>/ │             │
│  │        （100% 原版 dsh web，同源零移植）    │             │
│  └───────────────────────┬─────────────────┘             │
│                          │  HTTP + WS 原样转发             │
│  扩展宿主 ──► 本地反向代理 ─┼─ 拦截 host.openPath       ─┐    │
│              (src/proxy.js)│  └─ 拦截 host.pickDirectory │    │
│                            │      └ 转 vscode.open /     │    │
│                            │        vscode 目录选择器    │    │
└───────────────────────────┼──────┼───────────────────────┘
                            ▼      ▼
              http://127.0.0.1:3082（DSH harness）
```

- **零移植**：iframe 加载的就是 harness 自己服务的原版界面，DSH 升级 UI 自动跟随，无 vendor 快照。
- **同源过围栏**：iframe 的请求发往代理端口（127.0.0.1 环回），代理把 Host / Origin / Referer 统一改写为 harness 自身 origin，满足 harness 的 `/api` 浏览器信任围栏；WebSocket 下行流（`/api/events.mux`、`/api/events.host`）由代理双向透传。
- **快速文件阅读**：原版界面里点文件路径 → harness 发 `host.openPath` RPC → 代理拦截 → 转成 `vscode.open` 在编辑器区打开文件；代理按 harness 契约返回 `{ok:true, value:{opened:true}}`。
- **Cursor 同款目录选择**：界面里点「选择目录」→ harness 发 `host.pickDirectory` RPC → 代理拦截 → 弹 **VSCode 原生目录选择器**（`showOpenDialog`）；选中回 `{ok:true, value:{path}}`，取消回 `{path:null}`（与 harness 原生对话框行为一致）。
- **不占文件显示区**：界面在辅助侧边栏，编辑器区完全留给文件。

## 特性

- 🐋 DeepSeek 官方黑鲸图标（activity bar + 编辑器右上角按钮）
- 📍 视图自动移入辅助侧边栏（可拖回主侧栏）
- 🖼️ 原版 DSH web 全部能力：会话、轨迹、工具调用、附件、模型选择、权限预设、goal 等
- 📂 点击文件路径 → 在 VSCode 打开
- 📁 目录选择 → VSCode 原生选择器（Cursor 同款体验）
- 🩺 `DSH: 诊断` 命令查看代理/连通性统计；`DSH: 在浏览器打开原版界面` 对照排障

## 快速开始

前置：harness 正在运行（web 服务默认 `http://127.0.0.1:3082`；旧版默认 3080）。

```bash
cd dsh-vscode
npm install        # 只需 ws 一个依赖
npm run smoke      # 代理冒烟（对运行中的 harness 验证转发/拦截/WS 透传）
```

然后在 VSCode 中：

1. 打开本目录
2. 按 F5 启动「扩展开发宿主」（`.vscode/launch.json` 已配好）
3. 点击左侧 Activity Bar 的 DSH 图标（或编辑器右上角黑鲸按钮）→ 辅助侧边栏打开原版界面
4. 若 harness 不在 3082 端口，改设置 `dsh.baseUrl`（修改后代理自动重启、界面自动刷新）

### 安装打包产物

不跑源码、直接装成品：

```bash
npx -y @vscode/vsce package --out dsh-vscode-0.1.0.vsix
code --install-extension dsh-vscode-0.1.0.vsix   # 或在扩展面板 → … → 从 VSIX 安装…
```

> 源码与使用文档：https://github.com/mozhuanzuojing/dsh-vscode

设置：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `dsh.baseUrl` | `http://127.0.0.1:3082` | harness Web 服务地址 |
| `dsh.interceptPickDirectory` | `true` | 拦截 `host.pickDirectory` 并在 VSCode 弹原生目录选择器（Cursor 同款）；关闭后原样转发给 harness 宿主弹它自己的对话框（跨机拓扑降级路径） |

## 命令

| 命令 | 作用 |
| --- | --- |
| Open DSH Sidebar | 聚焦 DSH 视图（辅助侧边栏） |
| DSH: 刷新界面 | 重新加载 iframe |
| DSH: 诊断 | 显示代理端口、harness 可达性、HTTP/WS/openPath/pickDirectory 计数 |
| DSH: 在浏览器打开原版界面 | 系统浏览器打开 harness，与侧边栏对照 |

## 文件结构

```
dsh-vscode/
├── src/
│   ├── extension.js       扩展入口：代理生命周期、视图注册、辅助侧边栏移动、状态栏、命令
│   ├── proxy.js           本地反向代理：HTTP 转发、openPath/pickDirectory 拦截、WebSocket 透传（纯 Node，可独立测试）
│   └── view.js            webview 视图：iframe + CSP(frame-src) + 加载状态上报 + 刷新
├── scripts/
│   ├── probe.js           harness 协议探针（根页面 / RPC 信封 / WS 下行流）
│   └── proxy-smoke.cjs    代理冒烟：转发 / openPath / pickDirectory / WS 透传 / Origin 改写
├── media/icon.svg         黑鲸图标（activity bar + 编辑器标题栏）
├── .vscode/launch.json    扩展开发宿主启动配置
└── package.json
```

## 与当前 harness 的契约（0.1.0-rc.8 实测）

- RPC：`POST /api/<method>`，body 为 `client-request` 信封（`{type, rpcId, method, payload}`），应答 `server-response` 信封。
- 下行流：`/api/events.mux`、`/api/events.host` 为 **WebSocket**（`ws://`），由代理双向透传；若未来 harness 切换为 SSE，普通 HTTP 流式转发同样覆盖。
- 信任围栏：harness 对 `/api` 校验 Host 为环回/受信 + Origin 与 Host 同源；代理统一改写即可放行。
- openPath 应答：`{type:'server-response', rpcId, result:{ok:true, value:{opened:true}}}`。
- pickDirectory：payload 为空对象 `{}`；应答 `{type:'server-response', rpcId, result:{ok:true, value:{path: string|null}}}`，**取消 = `path:null`**（非错误）；真实失败回 `directory-picker-unavailable`。harness 以 `caller-signal-only` 调用（无默认超时），拦截器挂起等用户操作完对话框是合法行为。

## 已知边界

- **硬前置条件：VSCode 与 harness 共享同一文件系统。** `host.openPath` / `host.pickDirectory` 返回的路径（`Uri.fsPath`）会被 harness 直接用于打开文件、`workspace.create` 与会话 cwd；路径必须对 harness 可见。当前默认拓扑（VSCode Remote-WSL / WSL 内运行）天然满足。
- **不做自动路径转换**：不把 Windows 路径转成 `\\wsl.localhost\...` 或 WSL 内路径——跨机器场景无法可靠自动转换（转换只在「harness 恰好就在该 WSL 里」时成立），制造隐式错误不如显式报错（harness 会以 `workspace-invalid-path` 拒绝）。
- **跨机拓扑降级开关**：违反硬前置时把 `dsh.interceptPickDirectory` 设为 `false`，目录选择回到 harness 宿主原生对话框（对话框出现在 harness 机器上，路径语义天然正确）。
- **浏览型目录选择器（browse）原样保留**：iframe 内文件树走 `host.listDirectory/createDirectory`，不经拦截，两种选择方式并存。
- 主题跟随 harness 自身设置（原版界面的主题），不随 VSCode 主题变化。
- webview 环境对 WS 的策略以真机为准：若 iframe 内事件流不更新，执行 `DSH: 诊断` 查看 WS 计数。
- 代理仅监听 `127.0.0.1` 随机端口，不对外网暴露。
