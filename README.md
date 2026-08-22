# DSH Client

> 在 VSCode 里用 100% 原版 DSH Web 界面
> [English](README.en.md) | 中文

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

- ⚙️ TypeScript 7.0.2（tsc 编译，CommonJS）
- 🐋 DeepSeek 官方黑鲸图标（activity bar + 编辑器右上角按钮）
- 📍 视图自动移入辅助侧边栏（可拖回主侧栏）
- 🖼️ 原版 DSH web 全部能力：会话、轨迹、工具调用、附件、模型选择、权限预设、goal 等
- 📂 点击文件路径 → 在 VSCode 打开
- 📁 目录选择 → VSCode 原生选择器（Cursor 同款体验）
- 🔝 顶部单行：视图标题 `DSH Awakening :<代理端口>→<真实端口>` 显示代理→真实端口映射；切换后弹「已连接到真实服务端口」
- 🩺 底部状态栏 `DSH :<port>` 点击即开「DSH: 诊断」（端口检测页 + 配置入口）；`DSH: 在浏览器打开原版界面` 对照排障
- 🧠 **编辑器联动**：① 发消息自动注入 `[User Input]` 上下文（工作区/相对路径/文件类型/行号/按大小给内容）② agent 写文件后自动同步到编辑器（安全：不覆盖未保存修改）③ 编辑器右键「用 DSH 解释/修复/重构」 ④ 上下文实时反映当前选区

## 快速开始

前置：harness 正在运行（默认端口 `http://127.0.0.1:3080`，自动检测真实监听端口；若显式设置 `awakening.dsh.baseUrl` 则优先使用）。

```bash
cd dsh-vscode
npm install        # 只需 ws 一个依赖
npm run smoke      # 代理冒烟（对运行中的 harness 验证转发/拦截/WS 透传）
```

然后在 VSCode 中：

1. 打开本目录
2. 按 F5 启动「扩展开发宿主」（`.vscode/launch.json` 已配好）
3. 点击左侧 Activity Bar 的 DSH 图标（或编辑器右上角黑鲸按钮）→ 辅助侧边栏打开原版界面
4. 若 harness 端口不在默认检测范围（3080–3099），设 `awakening.dsh.baseUrl` 显式指定（修改后代理自动重启）。
   - 自动检测失败时，**打开侧边栏会自动弹出输入框**，录入地址后探测确认（判据 `__DSH_BOOT__`）并持久化到设置，下次直接使用。

### 安装打包产物

不跑源码、直接装成品：

```bash
npx -y @vscode/vsce package --out dsh-vscode-0.1.0.vsix
code --install-extension dsh-vscode-0.1.0.vsix   # 或在扩展面板 → … → 从 VSIX 安装…
```

> 源码与使用文档：https://github.com/mozhuanzuojing/dsh-vscode
> 发布流程（含强制 Review 门禁）：[RELEASING.md](RELEASING.md)

设置：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `awakening.dsh.baseUrl` | `http://127.0.0.1:3080` | harness Web 服务地址（默认 3080，自动检测真实端口；显式设置后优先使用） |
| `awakening.dsh.interceptPickDirectory` | `true` | 拦截 `host.pickDirectory` 并在 VSCode 弹原生目录选择器（Cursor 同款）；关闭后原样转发给 harness 宿主弹它自己的对话框（跨机拓扑降级路径） |
| `awakening.dsh.probeRange` | `[3080, 3099]` | 自动检测端口时扫描的 TCP 端口范围（含两端） |
| `awakening.dsh.autoMoveToSecondarySidebar` | `true` | 激活时自动把视图移入辅助侧边栏；`false` 则留在主侧边栏（改后重载窗口） |

## 命令

| 命令 | 作用 |
| --- | --- |
| Open DSH Sidebar | 聚焦 DSH 视图（辅助侧边栏） |
| （状态栏 `DSH :port` 点击） | 打开「DSH: 诊断」——端口检测页 + 配置入口 |
| Awakening: 打开设置 | 打开本扩展的 VS Code 设置页（配置入口） |
| Awakening: 配置 harness 地址 | 弹输入框重新录入/修改 harness 地址（编辑器标题栏齿轮、诊断面板、命令面板均可触发） |
| 用 DSH 解释/修复/重构选中内容 | 编辑器右键：把选中文本发给最近 DSH 会话执行对应动作 |
| DSH: 刷新界面 | 重新加载 iframe |
| DSH: 诊断 | 显示代理端口、harness 可达性、HTTP/WS/openPath/pickDirectory 计数 |
| DSH: 在浏览器打开原版界面 | 系统浏览器打开 harness，与侧边栏对照 |

## 文件结构

```
dsh-vscode/
├── src/
│   ├── extension.js       扩展入口：代理生命周期、视图注册、辅助侧边栏移动、状态栏、命令
│   ├── proxy.js           本地反向代理：HTTP 转发、openPath/pickDirectory 拦截、WebSocket 透传（纯 Node，可独立测试）
│   ├── detect.js          自动检测 harness 真实监听端口（纯 Node，判据 __DSH_BOOT__）
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
- **跨机拓扑降级开关**：违反硬前置时把 `awakening.dsh.interceptPickDirectory` 设为 `false`，目录选择回到 harness 宿主原生对话框（对话框出现在 harness 机器上，路径语义天然正确）。
- **浏览型目录选择器（browse）原样保留**：iframe 内文件树走 `host.listDirectory/createDirectory`，不经拦截，两种选择方式并存。
- 主题跟随 harness 自身设置（原版界面的主题），不随 VSCode 主题变化。
- webview 环境对 WS 的策略以真机为准：若 iframe 内事件流不更新，执行 `DSH: 诊断` 查看 WS 计数。
- 代理仅监听 `127.0.0.1` 随机端口，不对外网暴露。
## 排障（Troubleshooting）

> 统一入口：**先在命令行执行 `DSH: 诊断`**，它一次给出「代理端口 / harness 地址+可达性 / 端口检测来源 / HTTP / openPath / pickDirectory / WebSocket 透传(连接/失败) / 最近打开 / 最近选择目录」。下面每条先看你该盯哪个字段，再定位、再改。

### 1. 辅助侧边栏白屏 / 一直转"正在连接 DSH..."

- **现象**：打开侧边栏后 iframe 是空白，或停留在连接提示。
- **诊断观察**：`harness 地址` 那行是 `不可达: ...` 还是 `可达 (HTTP 200)`？`代理端口` 是否显示端口（不是"未启动"）。
- **判定**：白屏 = iframe 没拿到 harness 首页；`不可达` = 代理到 harness 的连接断；`代理未启动` = 扩展宿主里代理起失败（多半在 `代理启动失败` 弹出时能看到，或看输出面板 "DSH Client"）。
- **修复**
  1. 确认 harness 正在 `dsh web` 运行（`DSH: 在浏览器打开原版界面` 能打开就是好的）。
  2. 若默认 3080 连不上，扩展应已自动扫 [3080,3099]（`端口检测` 行会标 `自动检测到...`）；仍不可达就手动设 `awakening.dsh.baseUrl`。
  3. 关掉再开侧边栏，或执行 `DSH: 刷新界面` 重挂 iframe。

### 2. 发消息后界面不更新（事件流不动）

- **现象**：能发消息，但轨迹/回包不自动出现。
- **诊断观察**：`WebSocket 透传` 是不是 `0 连接 / 0 失败`，或失败很多。
- **判定**：`/api/events.mux`、`/api/events.host` 两个下行流没连上（0 连接）＝ 事件通道断了；失败多＝ 代理到 harness 的 WS 握手出问题。
- **修复**：执行 `DSH: 刷新界面` 重开流；还不行则看 `harness 地址` 是否可达；偶发断线在 harness 端也有重连（`client-connection` 指数退避），稍等即可。

### 3. 点文件路径没在编辑器打开

- **现象**：原版界面里点了文件路径/链接，编辑器区没弹出来。
- **诊断观察**：`openPath 拦截` 计数有没有 +1；`最近打开的文件` 是不是出现了该路径。
- **判定**：计数没动＝ 请求没到（可能是 UI 里不是走 `host.openPath` 的入口）；计数动了但没打开＝ `vscode.open` 失败（路径在 VSCode 侧不存在/权限）。
- **修复**：对照 `最近打开的文件` 的路径，确认它对 VSCode 可见（硬前置：共享文件系统）；路径不对则说明跨机拓扑，参考已知边界。

### 4. 点「选择目录」不弹框 / 弹到别的机器

- **现象**：点目录按钮没弹出 VSCode 原生选择器，或弹到了 harness 所在机器的系统对话框。
- **诊断观察**：`pickDirectory 拦截` 是 `开` 还是 `关`；计数有没有 +1。
- **判定**：`关`＝ 关闭了拦截，转发给 harness 宿主弹系统对话框（这是设计）—— 改成 `开` 即本机弹；`开` 但没 +1 ＝ 请求没到代理或 UI 走的是浏览型文件树。
- **修复**：设 `awakening.dsh.interceptPickDirectory=true` 并看看是否走 native 入口（浏览型 browse 树本来就显示在 iframe 内，不算弹框）。

### 5. 打开窗口时弹"代理启动失败"

- **现象**：VS Code 底部提示 `DSH Client: 代理启动失败（...）`。
- **诊断观察**：错误文案里 502/ECONNREFUSED/ECONNRESET 等；`端口检测` 行。
- **判定**：多数是启动瞬间 harness 还没起来，或 `awakening.dsh.baseUrl` 指向连不上的地址。
- **修复**：确认 harness 在跑后，执行 `DSH: 刷新界面`/重载窗口；或把 `awakening.dsh.baseUrl` 改成唯一确定可达的地址。

### 6. `WebSocket 透传` 失败很多 / 一直是 0

- **现象**：诊断里 WS `连接 0 / 失败 N`。
- **诊断观察**：`harness 地址` 可达性；`端口检测` 是否稳定命中。
- **判定**：WS 走的是代理到 harness 的上游握手（复用 Origin/Host 改写）；失败说明 harness 端 WS 端点拒绝或超时（如非 101）。
- **修复**：确认 harness 版本/进程正常；刷新界面重连；若频繁可稍等（harness 有重连退避）。

### 7. 自动检测不到端口，但 harness 明明在跑

- **现象**：`端口检测` 显示"未检测到，用默认 3080"，其实 dsh 在某个端口监听（如 3999）。
- **诊断观察**：`端口检测` 行的"未检测到" + 采集范围 [3080,3099]。
- **判定**：探测范围有限（默认 3080-3099，判据为首页含 `__DSH_BOOT__`）；端口落范围外就扫不到。
- **修复**：手动设 `awakening.dsh.baseUrl` 到真实地址（显式配置优先，不做自动扫描）；或调大 `awakening.dsh.probeRange` 扩大检测范围后重跑。
  - **或直接打开侧边栏**——自动弹出的输入框会帮你录入、探测并保存。
