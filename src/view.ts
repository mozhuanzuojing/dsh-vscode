import * as vscode from 'vscode';

export interface DshViewStatus { origin?: string; baseUrl?: string; detected?: boolean; }
export interface DshViewProviderOptions {
  getOrigin(): string;
  getStatus(): DshViewStatus | null;
  logger?(level: string, msg: string): void;
}

/**
 * webview 视图：iframe 内嵌原版 DSH web（代理 origin）。
 * 端口信息放在 VSCode 视图标题里（DSH Awakening :<代理>→<真实>），不在 webview 里再画顶条，
 * 因此顶部只有一行（VSCode 生成的视图标题栏）。
 */
export class DshViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private getOrigin: () => string;
  private getStatus: () => DshViewStatus | null;
  private logger: (level: string, msg: string) => void;

  constructor(opts: DshViewProviderOptions) {
    this.getOrigin = opts.getOrigin;
    this.getStatus = opts.getStatus || (() => null);
    this.logger = opts.logger || ((_l: string, _m: string) => {});
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== 'object') return;
      const m = message as { type?: string; url?: string };
      if (m.type === 'loaded') this.logger('info', 'webview 视图加载完成');
      else if (m.type === 'open-external' && typeof m.url === 'string') vscode.env.openExternal(vscode.Uri.parse(m.url));
    });
    this.render();
  }

  /** 重渲染整页（代理重建 / baseUrl 变更后调用；同时刷新视图标题端口）。 */
  render(): void {
    if (!this.view) return;
    this.view.webview.html = this.renderHtml();
    this.updateTitle();
  }

  refresh(): void {
    if (this.view) {
      try { this.view.webview.postMessage({ type: 'refresh' }); } catch (err) { this.logger('warn', 'refresh 失败: ' + String((err as Error).message)); }
    }
  }

  /** 把端口映射放进视图标题（VSCode 渲染成 "DSH: DSH Awakening :<代理>→<真实>"）——单行。 */
  private updateTitle(): void {
    if (!this.view) return;
    const s = this.getStatus();
    const proxyPort = s && s.origin ? new URL(s.origin).port : '';
    const realPort = s && s.baseUrl ? new URL(s.baseUrl).port : '';
    if (proxyPort && realPort) this.view.title = 'DSH Awakening :' + proxyPort + '→' + realPort;
    else if (realPort) this.view.title = 'DSH Awakening :' + realPort;
    else this.view.title = 'DSH Awakening';
  }

  private renderHtml(): string {
    const origin = this.getOrigin();
    if (!origin) {
      return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\';">\n<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center}.msg{color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);font-size:13px;text-align:center;padding:0 16px}</style></head>\n<body><div class="msg">DSH 代理尚未就绪，请执行「DSH: 诊断」查看 harness 连通性。</div></body></html>';
    }
    return ['<!DOCTYPE html>', '<html lang="zh-CN">', '<head>', '<meta charset="UTF-8">',
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; frame-src http://127.0.0.1:* http://localhost:*;">',
      '<style>',
      'html,body{margin:0;padding:0;height:100%;background:transparent}',
      '#frame{position:fixed;top:0;left:0;width:100%;height:100%;border:0}',
      '#status{position:fixed;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);font-size:12px;pointer-events:none;z-index:1}', '#status.hidden{display:none}',
      '</style>', '</head>', '<body>', '<div id="status">正在连接 DSH…</div>', '<iframe id="frame" src="' + origin + '" allow="clipboard-read; clipboard-write"></iframe>',
      '<script>', '(function(){var vscode=acquireVsCodeApi();var frame=document.getElementById("frame");var status=document.getElementById("status");function showLoading(){status.classList.remove("hidden")}function hideLoading(){status.classList.add("hidden")}frame.addEventListener("load",function(){if(frame.getAttribute("src")==="about:blank")return;hideLoading();vscode.postMessage({type:"loaded"})});window.addEventListener("message",function(e){var msg=e.data;if(!msg||msg.type!=="refresh")return;showLoading();var src=frame.getAttribute("src");frame.setAttribute("src","about:blank");requestAnimationFrame(function(){frame.setAttribute("src",src)})});showLoading()})();',
      '</script>', '</body>', '</html>'].join('\n');
  }
}
