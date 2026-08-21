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
- 🩺 `DSH: 诊断` command shows proxy/connectivity stats; `DSH: 在浏览器打开原版界面` opens the original UI in a browser for comparison

## Quick start

Prerequisite: the harness is running (default port `http://127.0.0.1:3080`, with automatic detection of the real listening port; if you set `dsh.baseUrl` explicitly it takes priority).

```bash
cd dsh-vscode
npm install        # only needs the ws dependency
npm run smoke      # proxy smoke test (verifies forwarding/interception/WS relay against a running harness)
```

Then in VS Code:

1. Open this directory
2. Press F5 to launch the "Extension Development Host" (`.vscode/launch.json` is preconfigured)
3. Click the DSH icon in the Activity Bar (or the whale button in the editor title) → the original UI opens in the secondary sidebar
4. If the harness port is outside the default detection range (3080-3099), set `dsh.baseUrl` explicitly (the proxy restarts automatically on change)

### Installing the packaged build

Install as a vsix without running from source:

```bash
npx -y @vscode/vsce package --out dsh-vscode-0.1.0.vsix
code --install-extension dsh-vscode-0.1.0.vsix   # or Extensions panel → … → Install from VSIX…
```

> Source & docs: https://github.com/mozhuanzuojing/dsh-vscode

Settings:

| Setting | Default | Description |
| --- | --- | --- |
| `dsh.baseUrl` | `http://127.0.0.1:3080` | Harness web service URL (default 3080, auto-detects the real port; explicit setting takes priority) |
| `dsh.interceptPickDirectory` | `true` | Intercept `host.pickDirectory` and show the native VS Code folder picker (Cursor-like); when `false`, forwards it to the harness host to show its own dialog (fallback for cross-machine setups) |

## Commands

| Command | Description |
| --- | --- |
| Open DSH Sidebar | Focus the DSH view (secondary sidebar) |
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
- **Cross-machine fallback switch**: when the hard prerequisite is violated, set `dsh.interceptPickDirectory` to `false`; directory picking returns to the harness host's native dialog (shown on the harness machine, so path semantics are correct).
- **The browse directory picker is preserved**: the in-iframe file tree uses `host.listDirectory/createDirectory`, not intercepted; both picking styles coexist.
- Theme follows the harness's own settings (the original UI's theme), not the VS Code theme.
- Webview WS behavior is subject to the real machine: if the event stream in the iframe does not update, run `DSH: 诊断` and check the WS count.
- The proxy only listens on a random `127.0.0.1` port, not exposed to the network.
