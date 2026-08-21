'use strict';
const vscode = require('vscode');
const { createProxy } = require('./proxy');
const { DshViewProvider } = require('./view');
const { detectHarnessUrl } = require('./detect');

const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';
const HARNESS_PROBE_RANGE = [3080, 3099]; // 含 dsh 默认 3082

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

/** 用户是否显式配置过 dsh.baseUrl（是则尊重，不做自动扫描）。 */
function isBaseUrlExplicit() {
  const inspected = vscode.workspace.getConfiguration('dsh').inspect('baseUrl');
  return !!(inspected && (inspected.globalValue !== undefined || inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined));
}

/** 解析最终 harness 地址：显式配置>直接使用；否则默认3080连不上则自动检测真实监听端口。 */
async function resolveHarnessBaseUrl() {
  const requested = getBaseUrl();
  if (isBaseUrlExplicit()) return { url: requested, requested, detected: true, reason: 'explicit config' };
  const res = await detectHarnessUrl({
    preferred: requested,
    range: HARNESS_PROBE_RANGE,
    log,
  });
  return { url: res.url, requested, detected: res.detected, reason: res.reason };
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
    const interceptPickDirectory = isPickDirectoryIntercepted();
    const requested = getBaseUrl();
    // 以「请求的 baseUrl」为防重键（解析后的 detected 端口是内部细节，避免无关重建）
    if (proxy && proxy.requestedBaseUrl === requested && proxy.interceptPickDirectory === interceptPickDirectory) return proxy;
    if (proxy) {
      await proxy.close().catch((err) => log('warn', `关闭旧代理: ${err.message}`));
      proxy = null;
    }
    const resolved = await resolveHarnessBaseUrl();
    proxy = await createProxy({
      baseUrl: resolved.url,
      interceptPickDirectory,
      onOpenPath: openPathInVscode,
      onPickDirectory: pickDirectoryInVscode,
      logger: log,
    }).start();
    proxy.requestedBaseUrl = requested;
    proxy.detectedBaseUrl = resolved.detected;
    proxy.detectedReason = resolved.reason;
    log('info', `代理就绪: ${proxy.origin} -> ${resolved.url}（请求 ${requested}，${resolved.reason}）`);
    if (statusBar) {
      statusBar.text = `$(browser) DSH :${proxy.port}`;
      statusBar.tooltip = `DSH Client — 代理 ${proxy.origin} → ${resolved.url}`;
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

/** 诊断里端口检测状态的可读描述。 */
function descriptionOfPortDetection(p, requested) {
  if (!p) return '未启动代理';
  if (p.requestedBaseUrl === requested && p.detectedBaseUrl === false) {
    return `未检测到，用默认 ${p.baseUrl}`;
  }
  if (p.detectedReason === 'explicit config') return `显式配置 ${p.baseUrl}`;
  if (p.baseUrl === requested) return '配置端口直接可达';
  return `自动检测 → ${p.baseUrl}`;
}

async function showDiagnostics() {
  const requested = getBaseUrl();
  const used = (proxy && proxy.baseUrl) || requested;
  let reachable = '检测中…';
  try {
    const res = await fetch(used + '/');
    reachable = `可达 (HTTP ${res.status})`;
  } catch (err) {
    reachable = `不可达: ${err.message}`;
  }
  const s = proxy ? proxy.stats : { httpRequests: 0, openPathCalls: 0, pickDirectoryCalls: 0, wsConnections: 0, wsFailures: 0 };
  const items = [
    { label: '代理端口', description: proxy ? proxy.origin : '未启动' },
    { label: 'harness 地址', description: `${used} — ${reachable}` },
    { label: '端口检测', description: descriptionOfPortDetection(proxy, requested) },
    { label: 'HTTP 转发', description: String(s.httpRequests) },
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
