'use strict';
const vscode = require('vscode');
const { createProxy } = require('./proxy');
const { DshViewProvider } = require('./view');

const DEFAULT_BASE_URL = 'http://127.0.0.1:3082';

let proxy = null;
let provider = null;
let statusBar = null;
let output = null;
let moveTimer = null;

/** 串行化代理重启队列，防止并发配置变更导致 double-close / 泄漏。 */
let restartQueue = Promise.resolve(null);

function log(level, message) {
  if (!output) return;
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  output.appendLine(line);
  console.log(`[dsh-client] ${line}`);
}

function getBaseUrl() {
  return vscode.workspace.getConfiguration('dsh').get('baseUrl', DEFAULT_BASE_URL);
}

function isPickDirectoryIntercepted() {
  return vscode.workspace.getConfiguration('dsh').get('interceptPickDirectory', true);
}

async function openPathInVscode(filePath) {
  const uri = vscode.Uri.file(filePath);
  await vscode.commands.executeCommand('vscode.open', uri);
}

/** Cursor 同款：VSCode 原生目录选择器。返回选中目录 fsPath；取消返回 null。 */
async function pickDirectoryInVscode() {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  return picked && picked.length > 0 ? picked[0].fsPath : null;
}

async function restartProxy() {
  // 入队：保证同一时刻最多一个重建在进行
  const prev = restartQueue;
  const next = (async () => {
    // 等前一个重建完成后再处理本请求
    try { await prev; } catch { /* 前一个失败不影响本请求 */ }
    const baseUrl = getBaseUrl();
    const interceptPickDirectory = isPickDirectoryIntercepted();
    if (proxy && proxy.baseUrl === baseUrl && proxy.interceptPickDirectory === interceptPickDirectory) return proxy;
    if (proxy) {
      await proxy.close().catch((err) => log('warn', `关闭旧代理: ${err.message}`));
      proxy = null;
    }
    proxy = await createProxy({
      baseUrl,
      interceptPickDirectory,
      onOpenPath: openPathInVscode,
      onPickDirectory: pickDirectoryInVscode,
      logger: log,
    }).start();
    log('info', `代理就绪: ${proxy.origin} -> ${baseUrl}`);
    if (statusBar) {
      statusBar.text = `$(browser) DSH :${proxy.port}`;
      statusBar.tooltip = `DSH Client — 代理 ${proxy.origin} → ${baseUrl}`;
    }
    if (provider) provider.render();
    return proxy;
  })();
  restartQueue = next;
  return next;
}

async function moveViewToSecondarySidebar() {
  try {
    await vscode.commands.executeCommand('workbench.action.moveViewToSecondarySidebar', 'dsh.chatView');
  } catch (err) {
    log('warn', `移动到辅助侧边栏失败: ${err.message}`);
  }
}

async function openSidebar() {
  try {
    await vscode.commands.executeCommand('workbench.view.extension.dsh');
  } catch (err) {
    log('warn', `打开 DSH 视图失败: ${err.message}`);
  }
  try {
    await vscode.commands.executeCommand('dsh.chatView.focus');
  } catch { /* 视图尚未解析 */ }
  await moveViewToSecondarySidebar();
}

async function showDiagnostics() {
  const baseUrl = getBaseUrl();
  let reachable = '检测中…';
  try {
    const res = await fetch(baseUrl + '/');
    reachable = `可达 (HTTP ${res.status})`;
  } catch (err) {
    reachable = `不可达: ${err.message}`;
  }
  const s = proxy ? proxy.stats : { httpRequests: 0, openPathCalls: 0, pickDirectoryCalls: 0, wsConnections: 0, wsFailures: 0 };
  const items = [
    { label: '代理端口', description: proxy ? proxy.origin : '未启动' },
    { label: 'harness 地址', description: `${baseUrl} — ${reachable}` },
    { label: 'HTTP 转发', description: String(s.httpRequests) },
    { label: 'openPath 拦截', description: String(s.openPathCalls) },
    { label: 'pickDirectory 拦截', description: `${proxy && proxy.interceptPickDirectory ? '开' : '关'} · ${s.pickDirectoryCalls} 次` },
    { label: 'WebSocket 透传', description: `${s.wsConnections} 连接 / ${s.wsFailures} 失败` },
    { label: '最近打开的文件', description: (proxy && proxy.stats.interceptedPaths.slice(-3).join(' · ')) || '—' },
    { label: '最近选择的目录', description: (proxy && proxy.stats.pickedPaths.slice(-3).join(' · ')) || '—' },
  ];
  await vscode.window.showQuickPick(items, { title: 'DSH Client 诊断', matchOnDescription: true });
}

async function activate(context) {
  output = vscode.window.createOutputChannel('DSH Client');
  log('info', 'DSH Client 激活');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(browser) DSH';
  statusBar.command = 'dsh.openSidebar';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.openSidebar', openSidebar),
    vscode.commands.registerCommand('dsh.refresh', () => provider && provider.refresh()),
    vscode.commands.registerCommand('dsh.diagnostics', showDiagnostics),
    vscode.commands.registerCommand('dsh.openInBrowser', () => {
      vscode.env.openExternal(vscode.Uri.parse(getBaseUrl()));
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dsh.baseUrl') || event.affectsConfiguration('dsh.interceptPickDirectory')) {
        restartProxy().catch((err) => vscode.window.showErrorMessage(`DSH Client: 代理重启失败 ${err.message}`));
      }
    })
  );

  // 先起代理，再注册视图（避免 iframe 拿到空 origin）
  try {
    await restartProxy();
  } catch (err) {
    vscode.window.showErrorMessage(
      `DSH Client: 代理启动失败（${err.message}）。请确认 harness 在 ${getBaseUrl()} 运行，或修改设置 dsh.baseUrl。`
    );
  }

  provider = new DshViewProvider({
    getOrigin: () => (proxy ? proxy.origin : ''),
    logger: log,
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dsh.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 视图创建后自动移入辅助侧边栏（可拖回主侧栏）
  moveTimer = setTimeout(() => { moveViewToSecondarySidebar(); }, 1200);
  context.subscriptions.push({ dispose: () => clearTimeout(moveTimer) });
}

async function deactivate() {
  if (proxy) {
    await proxy.close().catch(() => {});
    proxy = null;
  }
}

module.exports = { activate, deactivate };
