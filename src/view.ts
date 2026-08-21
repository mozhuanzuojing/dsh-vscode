import * as vscode from 'vscode';

export const BANNER_H = 26;

export interface DshViewStatus { origin?: string; baseUrl?: string; detected?: boolean; }
export interface DshViewProviderOptions {
  getOrigin(): string;
  getStatus(): DshViewStatus | null;
  logger?(level: string, msg: string): void;
}

/**
 * webview 视图：iframe 内嵌原版 DSH web（代理 origin）。
 * 顶部常驻细顶条显示端口；CSP 只放行本机环回端口的 frame-src。
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

  render(): void { if (this.view) this.view.webview.html = this.renderHtml(); }
  refresh(): void {
    if (this.view) { try { this.view.webview.postMessage({ type: 'refresh' }); } catch (err) { this.logger('warn', 'refresh 失败: ' + String((err as Error).message)); } }
  }

  private bannerHtml(): string {
    const s = this.getStatus();
    if (!s || !s.baseUrl) return '<div id="banner"><span class="dot gray"></span><span class="b-text">DSH 未就绪</span></div>';
    const color = s.detected ? 'green' : 'orange';
    const port = s.origin ? new URL(s.origin).port : '?';
    return '<div id="banner"><span class="dot ' + color + '"></span><span class="b-text">DSH :' + port + '</span></div>';
  }

  private renderHtml(): string {
    const origin = this.getOrigin();
    if (!origin) {
      return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\';">\n<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center}.msg{color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);font-size:13px;text-align:center;padding:0 16px}</style></head>\n<body><div class="msg">DSH 代理尚未就绪，请执行「DSH: 诊断」查看 harness 连通性。</div></body></html>';
    }
    const banner = this.bannerHtml();
    return ['<!DOCTYPE html>', '<html lang="zh-CN">', '<head>', '<meta charset="UTF-8">',
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; frame-src http://127.0.0.1:* http://localhost:*;">',
      '<style>',
      'html,body{margin:0;padding:0;height:100%;background:transparent}',
      '#banner{position:fixed;top:0;left:0;right:0;height:26px;z-index:2;display:flex;align-items:center;gap:6px;box-sizing:border-box;padding:0 8px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,0.35));background:var(--vscode-sideBar-background,rgba(128,128,128,0.08));font-family:var(--vscode-font-family);font-size:11px;color:var(--vscode-descriptionForeground,#8b949e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#banner .dot{width:8px;height:8px;border-radius:50%;flex:none}', '#banner .dot.green{background:#3fb950}', '#banner .dot.orange{background:#d29922}', '#banner .dot.gray{background:#8b949e}',
      '#banner .b-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#frame{position:fixed;top:26px;left:0;width:100%;height:calc(100% - 26px);border:0}',
      '#status{position:fixed;top:26px;left:0;width:100%;height:calc(100% - 26px);display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);font-size:12px;pointer-events:none;z-index:1}', '#status.hidden{display:none}',
      '</style>', '</head>', '<body>', banner, '<div id="status">正在连接 DSH…</div>', '<iframe id="frame" src="' + origin + '" allow="clipboard-read; clipboard-write"></iframe>',
      '<script>', '(function(){var vscode=acquireVsCodeApi();var frame=document.getElementById("frame");var status=document.getElementById("status");function showLoading(){status.classList.remove("hidden")}function hideLoading(){status.classList.add("hidden")}frame.addEventListener("load",function(){if(frame.getAttribute("src")==="about:blank")return;hideLoading();vscode.postMessage({type:"loaded"})});window.addEventListener("message",function(e){var msg=e.data;if(!msg||msg.type!=="refresh")return;showLoading();var src=frame.getAttribute("src");frame.setAttribute("src","about:blank");requestAnimationFrame(function(){frame.setAttribute("src",src)})});showLoading()})();',
      '</script>', '</body>', '</html>'].join('\n');
  }
}
