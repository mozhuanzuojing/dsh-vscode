'use strict';
const vscode = require('vscode');
const { createProxy } = require('./proxy');
const { DshViewProvider } = require('./view');
const { detectHarnessUrl, probe } = require('./detect');
const { createConfig, DEFAULT_BASE_URL } = require('./config');
const { createPrompt } = require('./prompt');

const config = createConfig(vscode.workspace.getConfiguration);

let proxy = null;
let provider = null;
let statusBar = null;
let output = null;
let moveTimer = null;

/** 串行化代理重启队列，防止并发配置变更导致 double-close / 泄漏。 */
let restartQueue = Promise.resolve(null);

const prompt = createPrompt({
  showInputBox: (opts) => vscode.window.showInputBox({
    prompt: '未自动检测到 DSH harness。请输入 harness Web 服务地址（本地默认 http://localhost:<port>）。',
    placeHolder: 'http://localhost:3082',
    ignoreFocusOut: true,
    ...opts,
  }),
  showError: (msg) => vscode.window.showErrorMessage('DSH Client: ' + msg),
  showWarning: (msg) => vscode.window.showWarningMessage('DSH Client: ' + msg),
  showInfo: (msg) => vscode.window.showInformationMessage('DSH Client: ' + msg, { modal: false }),
  isReachable: (url) => probe(url, { timeoutMs: 1500 }),
  persistUrl: async (url) => {
    await config.updateBaseUrl(url, vscode.ConfigurationTarget.Global);
    if (config.hasScopeOverride()) {
      await vscode.window.showWarningMessage('DSH Client: 当前 workspace/文件夹层级的 awakening.dsh.baseUrl 会覆盖此处保存的全局值，请在设置中确认实际生效地址。');
    }
  },
  restartProxy: () => restartProxy(),
  log: (lvl, msg) => log(lvl, msg),
});

function log(level, message) {
  if (!output) return;
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  output.appendLine(line);
  console.log(`[dsh-client] ${line}`);
}

/** 解析最终 harness 地址：显式配置>直接使用；否则默认3080连不上则自动检测真实监听端口。 */
async function resolveHarnessBaseUrl() {
  const requested = config.getBaseUrl();
  // 显式配置：规范化后直接用（合法）；非法则回退默认并告警，避免 createProxy 的 new URL 抛错
  if (config.isBaseUrlExplicit()) {
    const url = config.normalizeBaseUrl(requested);
    if (url) return { url, requested, detected: true, reason: 'explicit config' };
    log('warn', `baseUrl 配置非法（${requested}），回退默认 ${config.getBaseUrl()}`);
  }
  const res = await detectHarnessUrl({
    preferred: config.normalizeBaseUrl(requested) || DEFAULT_BASE_URL,
    range: config.getProbeRange(),
    log,
  });
  return { url: res.url, requested, detected: res.detected, reason: res.reason };
}

function isPickDirectoryIntercepted() {
  return config.pickDirectoryIntercepted();
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

/** 数组相等（用于配置防重键）。 */
function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

async function restartProxy() {
  // 入队：保证同一时刻最多一个重建在进行
  const prev = restartQueue;
  const next = (async () => {
    // 等前一个重建完成后再处理本请求
    try { await prev; } catch { /* 前一个失败不影响本请求 */ }
    const interceptPickDirectory = isPickDirectoryIntercepted();
    const requested = config.getBaseUrl();
    const probeRange = config.getProbeRange();
    // 防重键：请求 baseUrl + 拦截开关 + 探测范围（解析出的端口是内部细节，避免无关重建）
    if (proxy && proxy.requestedBaseUrl === requested && proxy.interceptPickDirectory === interceptPickDirectory && arraysEqual(proxy.probeRange, probeRange)) return proxy;
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
    proxy.probeRange = probeRange;
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

/** 打开本扩展的 VS Code 设置页（作为「配置入口」）。 */
async function openSettings() {
  try {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.dsh-vscode');
  } catch (err) {
    log('warn', `打开设置失败: ${err.message}`);
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
  // 打开侧边栏时若 harness 不可达，再弹窗补录（不在激活时打扰）
  if (!proxy || !(await probe(proxy.baseUrl, { timeoutMs: 1500 }))) {
    await prompt.promptAndPersist();
  }
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
  const requested = config.getBaseUrl();
  const used = (proxy && proxy.baseUrl) || requested;
  let reachable = '检测中…';
  try {
    const res = await fetch(new URL('/', used).href);
    reachable = `可达 (HTTP ${res.status})`;
  } catch (err) {
    reachable = `不可达: ${err.message}`;
  }
  const s = proxy ? proxy.stats : { httpRequests: 0, openPathCalls: 0, pickDirectoryCalls: 0, wsConnections: 0, wsFailures: 0 };
  const items = [
    { label: '$(settings-gear) 配置 harness 地址…', description: '打开输入框重新录入并保存', kind: vscode.QuickPickItemKind.Default, alwaysShow: true, action: 'configure' },
    { label: '代理端口', description: proxy ? proxy.origin : '未启动' },
    { label: 'harness 地址', description: `${used} — ${reachable}` },
    { label: '端口检测', description: descriptionOfPortDetection(proxy, requested) },
    { label: 'HTTP 转发', description: String(s.httpRequests) },
    { label: 'openPath 拦截', description: String(s.openPathCalls) },
    { label: 'pickDirectory 拦截', description: `${proxy && proxy.interceptPickDirectory ? '开' : '关'} · ${s.pickDirectoryCalls} 次` },
    { label: 'WebSocket 透传', description: `${s.wsConnections} 连接 / ${s.wsFailures} 失败` },
    { label: '最近打开的文件', description: (proxy && proxy.stats.interceptedPaths.slice(-3).join(' · ')) || '—' },
    { label: '最近选择的目录', description: (proxy && proxy.stats.pickedPaths.slice(-3).join(' · ')) || '—' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'DSH Client 诊断', matchOnDescription: true });
  if (picked && picked.action === 'configure') {
    await prompt.promptAndPersist();
  }
}

async function activate(context) {
  output = vscode.window.createOutputChannel('DSH Client');
  log('info', 'DSH Client 激活');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(browser) DSH';
  statusBar.command = 'dsh.diagnostics'; // 点击展示端口检测/配置（DSH: 诊断）
  statusBar.tooltip = 'DSH Client — 点击查看端口检测与配置（DSH: 诊断）';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.openSidebar', openSidebar),
    vscode.commands.registerCommand('dsh.refresh', () => provider && provider.refresh()),
    vscode.commands.registerCommand('dsh.diagnostics', showDiagnostics),
    vscode.commands.registerCommand('dsh.openInBrowser', () => {
      vscode.env.openExternal(vscode.Uri.parse(config.getBaseUrl()));
    }),
    vscode.commands.registerCommand('awakening.openSettings', openSettings),
    vscode.commands.registerCommand('awakening.configureHarnessUrl', () => prompt.promptAndPersist())
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('awakening.dsh')) {
        restartProxy().catch((err) => vscode.window.showErrorMessage(`DSH Client: 代理重启失败 ${err.message}`));
      }
    })
  );

  // 先注册视图（代理未就绪时显示占位），再启动代理——端口扫描可能耗时，不能让激活卡在它前面
  provider = new DshViewProvider({
    getOrigin: () => (proxy ? proxy.origin : ''),
    getStatus: () => (proxy ? { origin: proxy.origin, baseUrl: proxy.baseUrl, detected: proxy.detectedBaseUrl !== false } : null),
    logger: log,
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dsh.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  try {
    await restartProxy().catch((err) => vscode.window.showErrorMessage(
      `DSH Client: 代理启动失败（${err.message}）。请确认 harness 在 ${config.getBaseUrl()} 运行，或修改设置 awakening.dsh.baseUrl。`
    ));
  } catch { /* 已在 catch 里提示；restartProxy 自身异常时不再重复 */ }

  // 视图创建后自动移入辅助侧边栏（可拖回主侧栏）
  if (config.shouldAutoMove()) {
    moveTimer = setTimeout(() => { moveViewToSecondarySidebar(); }, 1200);
  }
  context.subscriptions.push({ dispose: () => clearTimeout(moveTimer) });
}

async function deactivate() {
  if (proxy) {
    await proxy.close().catch(() => {});
    proxy = null;
  }
}

module.exports = { activate, deactivate };
