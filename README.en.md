# DSH Client

> Use the 100% original DSH Web UI inside VS Code.
> English | [中文](README.md)

Embed the original DeepSeek Harness (DSH) Web interface in the VS Code secondary sidebar, and click file paths in conversations/traces to open them directly in the VS Code editor — fast file reading.

## How it works (Plan A2: local proxy + iframe)

```
┌───────────────────────── VSCode ─────────────────────────┐
│  Secondary sidebar webview view (dsh.chatView)            │
│  ┌─────────────────────────────────────────┐             │
│  │  iframe ──► http://127.0.0.1:<random port>/ │          │
│  │        (100% original dsh web, no porting)  │           │
│  └───────────────────────┬─────────────────┘             │
│                          │  HTTP + WS forwarded          │
│  Extension host ──► local reverse proxy ─┼─ intercept host.openPath ─┐ │
│              (src/proxy.js)│  └─ intercept host.pickDirectory  │      │
│                            │        └ vscode.open /           │      │
│                            │          VS Code folder picker   │      │
└───────────────────────────┼──────┼──────────────────────────┘
                            ▼      ▼
              http://127.0.0.1:3082 (DSH harness)
```

- **Zero porting**: the iframe loads the original UI served by the harness itself; DSH UI upgrades are followed automatically, no vendored snapshot.
- **Same-origin bypass**: iframe requests go to the proxy port (127.0.0.1 loopback); the proxy rewrites Host / Origin / Referer to the harness's own origin, satisfying the harness `/api` browser-trust fence. The WebSocket downlinks (`/api/events.mux`, `/api/events.host`) are relayed bidirectionally.
- **Fast file reading**: click a file path in the original UI → the harness sends a `host.openPath` RPC → the proxy intercepts it → converts it into `vscode.open` in the editor area; the proxy replies with `{ok:true, value:{opened:true}}` per the harness contract.
- **Cursor-like directory picking**: click "Select Directory" in the UI → the harness sends `host.pickDirectory` RPC → the proxy intercepts it → shows the **native VS Code folder picker** (`showOpenDialog`); on select it replies `{ok:true, value:{path}}`, on cancel `{path:null}` (matching the harness native dialog behavior).
- **No editor-space taken**: the UI lives in the secondary sidebar; the editor area is left entirely to files.

## Features

- 🐋 Official DeepSeek black-whale icon (activity bar + editor title button)
- 📍 View auto-moves to the secondary sidebar (draggable back to the primary sidebar)
- 🖼️ All original DSH web capabilities: conversations, traces, tool calls, attachments, model selection, permission presets, goals, etc.
- 📂 Click a file path → opens in VS Code
- 📁 Directory selection → native VS Code picker (Cursor-like)
- 🔝 Top banner in the view: reachability dot + proxy port + harness URL
- 🩺 Clicking the status-bar `DSH :port` opens `DSH: 诊断` (port detection page + config entry); `DSH: 在浏览器打开原版界面` opens the original UI in a browser for comparison

## Quick start

Prerequisite: the harness is running (default port `http://127.0.0.1:3080`, with automatic detection of the real listening port; if you set `awakening.dsh.baseUrl` explicitly it takes priority).

```bash
cd dsh-vscode
npm install        # only needs the ws dependency
npm run smoke      # proxy smoke test (verifies forwarding/interception/WS relay against a running harness)
```

Then in VS Code:

1. Open this directory
2. Press F5 to launch the "Extension Development Host" (`.vscode/launch.json` is preconfigured)
3. Click the DSH icon in the Activity Bar (or the whale button in the editor title) → the original UI opens in the secondary sidebar
4. If the harness port is outside the default detection range (3080-3099), set `awakening.dsh.baseUrl` explicitly (the proxy restarts automatically on change).
  - If auto-detection fails, **opening the sidebar shows an input box** — enter the URL, it is probed (marker `__DSH_BOOT__`) and persisted to settings for next time.

### Installing the packaged build

Install as a vsix without running from source:

```bash
npx -y @vscode/vsce package --out dsh-vscode-0.1.0.vsix
code --install-extension dsh-vscode-0.1.0.vsix   # or Extensions panel → … → Install from VSIX…
```

> Source & docs: https://github.com/mozhuanzuojing/dsh-vscode
> Release process (mandatory review gate before verify & publish): [RELEASING.md](RELEASING.md)

Settings:

| Setting | Default | Description |
| --- | --- | --- |
| `awakening.dsh.baseUrl` | `http://127.0.0.1:3080` | Harness web service URL (default 3080, auto-detects the real port; explicit setting takes priority) |
| `awakening.dsh.interceptPickDirectory` | `true` | Intercept `host.pickDirectory` and show the native VS Code folder picker (Cursor-like); when `false`, forwards it to the harness host to show its own dialog (fallback for cross-machine setups) |
| `awakening.dsh.probeRange` | `[3080, 3099]` | TCP port range to scan when auto-detecting the port (inclusive) |
| `awakening.dsh.autoMoveToSecondarySidebar` | `true` | Auto-move the view to the secondary sidebar on activation; `false` keeps it in the primary sidebar (needs window reload) |

## Commands

| Command | Description |
| --- | --- |
| Open DSH Sidebar | Focus the DSH view (secondary sidebar) |
| (status-bar `DSH :port` click) | Opens `DSH: 诊断` — port detection page + config entry |
| Awakening: 打开设置 | Open this extension's VS Code settings page (config entry) |
| Awakening: 配置 harness 地址 | Re-open the input box to enter/change the harness URL (status-bar gear, editor title, and diagnostics panel) |
| DSH: 刷新界面 | Reload the iframe |
| DSH: 诊断 | Show proxy port, harness reachability, HTTP/WS/openPath/pickDirectory counts |
| DSH: 在浏览器打开原版界面 | Open the original harness in the system browser for comparison |

## File structure

```
dsh-vscode/
├── src/
│   ├── extension.js   Extension entry: proxy lifecycle, view registration, secondary-sidebar move, status bar, commands
│   ├── proxy.js       Local reverse proxy: HTTP forwarding, openPath/pickDirectory interception, WebSocket relay (pure Node, independently testable)
│   ├── detect.js       Auto-detects the harness's real listening port (pure Node, __DSH_BOOT__ marker)
│   └── view.js        Webview view: iframe + CSP (frame-src) + load-state reporting + refresh
├── scripts/
│   ├── probe.js       Harness protocol probe (root page / RPC envelope / WS downlink)
│   └── proxy-smoke.cjs  Proxy smoke: forwarding / openPath / pickDirectory / WS relay / Origin rewrite
├── media/icon.svg     Whale icon (activity bar + editor title)
├── .vscode/launch.json  Extension Development Host launch config
└── package.json
```

## Harness contract (verified against 0.1.0-rc.8)

- RPC: `POST /api/<method>`, body is the `client-request` envelope (`{type, rpcId, method, payload}`), response is the `server-response` envelope.
- Downlinks: `/api/events.mux` and `/api/events.host` are **WebSocket** (`ws://`), relayed bidirectionally; if the harness switches to SSE in the future, the plain HTTP streaming forward already covers it.
- Trust fence: the harness checks that the Host is loopback/trusted AND that the Origin (when present) matches the Host origin; the proxy rewrites them to pass.
- openPath response: `{type:'server-response', rpcId, result:{ok:true, value:{opened:true}}}`.
- pickDirectory: payload is an empty object `{}`; response `{type:'server-response', rpcId, result:{ok:true, value:{path: string|null}}}`, **cancel = `path:null`** (not an error); a real failure returns `directory-picker-unavailable`. The harness calls it with `caller-signal-only` (no default timeout), so the interceptor may hold the request open while the dialog is being used — that is expected.

## Known limitations

- **Hard prerequisite: VS Code and the harness share the same filesystem.** Paths returned by `host.openPath` / `host.pickDirectory` (`Uri.fsPath`) are used directly by the harness to open files, run `workspace.create`, and set the session cwd; the path must be visible to the harness. The default topology (VS Code Remote-WSL / running inside WSL) satisfies this naturally.
- **No automatic path conversion**: Windows paths are not converted to `\\wsl.localhost\...` or WSL-internal paths — cross-machine conversion cannot be done reliably (it only holds when the harness happens to be in that same WSL), so failing explicitly is better than a silent wrong path (the harness rejects it with `workspace-invalid-path`).
- **Cross-machine fallback switch**: when the hard prerequisite is violated, set `awakening.dsh.interceptPickDirectory` to `false`; directory picking returns to the harness host's native dialog (shown on the harness machine, so path semantics are correct).
- **The browse directory picker is preserved**: the in-iframe file tree uses `host.listDirectory/createDirectory`, not intercepted; both picking styles coexist.
- Theme follows the harness's own settings (the original UI's theme), not the VS Code theme.
- Webview WS behavior is subject to the real machine: if the event stream in the iframe does not update, run `DSH: 诊断` and check the WS count.
- The proxy only listens on a random `127.0.0.1` port, not exposed to the network.
## Troubleshooting

> Single entry point: **run `DSH: 诊断` first** — it reports proxy port / harness URL + reachability / port-detection source / HTTP / openPath / pickDirectory / WebSocket relay (connections/failures) / recently opened / recently picked. Each entry below tells you which field to watch, how to judge, then how to fix.

### 1. Blank sidebar / stuck on "Connecting to DSH..."

- **Symptom**: the iframe is blank after opening the sidebar, or stays on the connecting hint.
- **Watch**: is the `harness 地址` row `不可达: ...` or `可达 (HTTP 200)`? Does `代理端口` show a port (not "未启动")?
- **Diagnosis**: blank iframe = the harness homepage did not load; `不可达` = proxy-to-harness connection down; `未启动` = the proxy failed in the extension host (see the `DSH Client` output channel / the `代理启动失败` popup).
- **Fix**
  1. Make sure the harness is running (`DSH: 在浏览器打开原版界面` opening proves it).
  2. If default 3080 is not reachable, the extension auto-scans [3080,3099] (`端口检测` row will show `自动检测到...`); if still unreachable, set `awakening.dsh.baseUrl` manually.
  3. Close/reopen the sidebar, or run `DSH: 刷新界面` to remount the iframe.

### 2. UI does not update after sending a message

- **Symptom**: messages send but the trace/response does not appear automatically.
- **Watch**: is `WebSocket 透传` `0 连接 / 0 失败`, or many failures?
- **Diagnosis**: `0 连接` for the two downlinks (`/api/events.mux`, `/api/events.host`) means the event channel is closed; many failures means the proxy-to-harness WS handshake is failing.
- **Fix**: run `DSH: 刷新界面` to reopen the streams; if still broken check `harness 地址` reachability. Transient drops self-heal via the harness client-connection exponential backoff — wait a moment.

### 3. Clicking a file path does not open it in VS Code

- **Symptom**: clicked a file path/link in the original UI but nothing opens in the editor.
- **Watch**: did `openPath 拦截` count +1? Does the path show under `最近打开的文件`?
- **Diagnosis**: count unchanged = the request never arrived (the UI entry may not use `host.openPath`); count increased but nothing opened = `vscode.open` failed (path missing/not visible to VS Code).
- **Fix**: check the path under `最近打开的文件`; it must be visible to VS Code (hard prerequisite: shared filesystem). If the path is wrong you are probably in a cross-machine topology — see Known limitations.

### 4. "Select Directory" does not open a dialog / opens on another machine

- **Symptom**: no VS Code native picker, or the harness machine's OS dialog appears instead.
- **Watch**: is `pickDirectory 拦截` `开` or `关`? Did the count +1?
- **Diagnosis**: `关` = interception disabled, forwarded to the harness host (by design) — set it to `开` to pick locally; `开` but no +1 = request did not reach the proxy or the UI used the browse file tree.
- **Fix**: set `awakening.dsh.interceptPickDirectory=true` and use the native entry (the browse tree renders inside the iframe; it is not a dialog).

### 5. "Proxy failed to start" popup on window open

- **Symptom**: VS Code shows `DSH Client: 代理启动失败（...）`.
- **Watch**: the error text (502 / ECONNREFUSED / ECONNRESET ...) and the `端口检测` row.
- **Diagnosis**: usually the harness was not up yet at startup, or `awakening.dsh.baseUrl` points somewhere unreachable.
- **Fix**: after the harness is confirmed running, run `DSH: 刷新界面` / reload the window; or set `awakening.dsh.baseUrl` to a definitely-reachable URL.

### 6. `WebSocket 透传` shows many failures / stays at 0

- **Symptom**: `连接 0 / 失败 N` in diagnostics.
- **Watch**: `harness 地址` reachability; whether `端口检测` stabilizes.
- **Diagnosis**: WS goes through proxy-to-harness upstream handshake (reusing the Origin/Host rewrite); failures mean the harness WS endpoint rejects or times out (e.g. non-101).
- **Fix**: confirm the harness version/process is healthy; refresh the iframe to reconnect; if frequent, wait — the harness reconnect backoff handles it.

### 7. Auto-detection finds no port, but the harness is running

- **Symptom**: `端口检测` shows "not detected, using default 3080" although dsh is listening somewhere (e.g. 3999).
- **Watch**: the scan range [3080,3099] and the "not detected" message.
- **Diagnosis**: the probe range is limited (3080-3099, marker `__DSH_BOOT__` in the homepage); an out-of-range port is not found.
- **Fix**: set `awakening.dsh.baseUrl` to the real address explicitly (explicit config takes priority, no scanning); or widen `awakening.dsh.probeRange` to scan a larger port range.
  - **Or just open the sidebar** — the auto-shown input box will enter, probe and save the address for you.
