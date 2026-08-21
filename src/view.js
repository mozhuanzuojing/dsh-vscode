'use strict';
const vscode = require('vscode');

/**
 * webview 视图：iframe 内嵌原版 DSH web（代理 origin）。
 * CSP 只放行本机环回端口的 frame-src；加载状态上报 + 刷新（重挂 iframe）。
 */
class DshViewProvider {
  constructor({ getOrigin, logger }) {
    this.getOrigin = getOrigin;
    this.logger = logger || ((_level, _msg) => {});
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== 'object') return;
      switch (message.type) {
        case 'loaded':
          this.logger('info', 'webview 视图加载完成');
          break;
        case 'open-external':
          if (typeof message.url === 'string') {
            vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
          break;
        default:
          break;
      }
    });

    this.render();
  }

  /** 重渲染整页（代理重建 / baseUrl 变更后调用，会重置 iframe 状态）。 */
  render() {
    if (this.view) {
      this.view.webview.html = this.renderHtml();
    }
  }

  /** 只刷新 iframe（DSH: 刷新界面）。 */
  refresh() {
    if (this.view) {
      try { this.view.webview.postMessage({ type: 'refresh' }); } catch (err) {
        this.logger('warn', `refresh 失败: ${err.message}`);
      }
    }
  }

  renderHtml() {
    const origin = this.getOrigin();
    if (!origin) {
      return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; height: 100%; display: flex; align-items: center; justify-content: center; }
  .msg { color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); font-size: 13px; text-align: center; padding: 0 16px; }
</style></head>
<body><div class="msg">DSH 代理尚未就绪，请执行「DSH: 诊断」查看 harness 连通性。</div></body></html>`;
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src http://127.0.0.1:* http://localhost:*;">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: transparent; }
  #frame { position: fixed; top: 0; left: 0; width: 100%; height: 100%; border: 0; }
  #status {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family);
    font-size: 12px; pointer-events: none; z-index: 1;
  }
  #status.hidden { display: none; }
</style>
</head>
<body>
<div id="status">正在连接 DSH…</div>
<iframe id="frame" src="${origin}" allow="clipboard-read; clipboard-write"></iframe>
<script>
  (function () {
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('frame');
    const status = document.getElementById('status');

    function showLoading() { status.classList.remove('hidden'); }
    function hideLoading() { status.classList.add('hidden'); }

    frame.addEventListener('load', function () {
      if (frame.getAttribute('src') === 'about:blank') return; // 忽略刷新中间态
      hideLoading();
      vscode.postMessage({ type: 'loaded' });
    });

    window.addEventListener('message', function (event) {
      const msg = event.data;
      if (!msg || msg.type !== 'refresh') return;
      showLoading();
      const src = frame.getAttribute('src');
      frame.setAttribute('src', 'about:blank');
      requestAnimationFrame(function () {
        frame.setAttribute('src', src);
      });
    });

    showLoading();
  })();
</script>
</body>
</html>`;
  }
}

module.exports = { DshViewProvider };
