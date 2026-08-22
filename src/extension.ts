import * as vscode from 'vscode';
import { createProxy, ProxyHandle, ProxyOptions } from './proxy';
import { DshViewProvider } from './view';
import { detectHarnessUrl, probe } from './detect';
import { createConfig, normalizeBaseUrl, DEFAULT_BASE_URL, Config } from './config';
import { createPrompt, Prompt } from './prompt';
import { createEditorContext, bindEditorContext, EditorContextBarrel } from './editor-context';
import { createApplyDiff, ApplyDiff } from './apply-diff';

const config: Config = createConfig(vscode.workspace.getConfiguration);
const editorContext: EditorContextBarrel = createEditorContext();
let applyDiff: ApplyDiff;

let proxy: ProxyHandle | null = null;
let provider: DshViewProvider | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let output: vscode.OutputChannel | null = null;
let moveTimer: ReturnType<typeof setTimeout> | undefined;

/** 串行化代理重启队列，防止并发配置变更导致 double-close / 泄漏。 */
let restartQueue: Promise<unknown> = Promise.resolve(null);
let shuttingDown = false;
let lastRealPort = '';

const prompt: Prompt = createPrompt({
  showInputBox: (opts) => new Promise<string | undefined>((resolve) => {
    vscode.window.showInputBox({
      prompt: '未自动检测到 DSH harness。请输入 harness Web 服务地址（本地默认 http://localhost:<port>）。',
      placeHolder: 'http://localhost:3082',
      ignoreFocusOut: true,
      ...opts,
    }).then(resolve);
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

function log(level: string, message: string): void {
  if (!output) return;
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + message;
  output.appendLine(line);
  console.log('[dsh-client] ' + line);
}

/** 解析最终 harness 地址：显式配置>直接使用；否则默认3080连不上则自动检测真实监听端口。 */
async function resolveHarnessBaseUrl(): Promise<{ url: string; requested: string; detected: boolean; reason: string }> {
  const requested = config.getBaseUrl();
  if (config.isBaseUrlExplicit()) {
    const url = normalizeBaseUrl(requested);
    if (url) return { url, requested, detected: true, reason: 'explicit config' };
    log('warn', 'baseUrl 配置非法（' + requested + '），回退默认 ' + config.getBaseUrl());
  }
  const res = await detectHarnessUrl({
    preferred: normalizeBaseUrl(requested) || DEFAULT_BASE_URL,
    range: config.getProbeRange(),
    log,
  });
  return { url: res.url, requested, detected: res.detected, reason: res.reason };
}

function isPickDirectoryIntercepted(): boolean {
  return config.pickDirectoryIntercepted();
}

async function openPathInVscode(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  await vscode.commands.executeCommand('vscode.open', uri);
}

/** Cursor 同款：VSCode 原生目录选择器。返回选中目录 fsPath；取消返回 null。 */
async function pickDirectoryInVscode(): Promise<string | null> {
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
  return picked && picked.length > 0 ? picked[0].fsPath : null;
}

/** 数组相等（用于配置防重键）。 */
function arraysEqual(a: number[] | undefined, b: readonly number[]): boolean {
  return !!a && Array.isArray(a) && a.length === b.length && (a as number[]).every((v, i) => v === b[i]);
}

async function restartProxy(): Promise<ProxyHandle> {
  const prev = restartQueue;
  const next = (async (): Promise<ProxyHandle> => {
    try { await prev; } catch { /* 前一个失败不影响本请求 */ }
    if (shuttingDown) return proxy as ProxyHandle;
    const interceptPickDirectory = isPickDirectoryIntercepted();
    const requested = config.getBaseUrl();
    const probeRange = config.getProbeRange();
    if (proxy && proxy.requestedBaseUrl === requested && proxy.interceptPickDirectory === interceptPickDirectory && arraysEqual(proxy.probeRange, probeRange)) return proxy;
    if (proxy) { await proxy.close().catch((err) => log('warn', '关闭旧代理: ' + (err as Error).message)); proxy = null; }
    const resolved = await resolveHarnessBaseUrl();
    proxy = await createProxy({
      baseUrl: resolved.url, interceptPickDirectory, editorContext,
      onOpenPath: openPathInVscode, onPickDirectory: pickDirectoryInVscode,
      onSessionPrompt: () => { if (applyDiff) applyDiff.armTurnWindow(); },
      logger: log,
    }).start();
    proxy.requestedBaseUrl = requested;
    proxy.probeRange = [...probeRange];
    proxy.detectedBaseUrl = resolved.detected;
    proxy.detectedReason = resolved.reason;
    log('info', '代理就绪: ' + proxy.origin + ' -> ' + resolved.url + '（请求 ' + requested + '，' + resolved.reason + '）');
    const realPort = new URL(resolved.url).port;
    if (realPort && realPort !== lastRealPort) {
      lastRealPort = realPort;
      vscode.window.showInformationMessage('已连接到真实服务端口 ' + realPort + '（经本地代理 ' + proxy.port + '）', { modal: false });
    }
    if (statusBar) {
      statusBar.text = '$(browser) DSH :' + proxy.port;
      statusBar.tooltip = 'DSH Client — 代理 ' + proxy.origin + ' → ' + resolved.url;
    }
    if (provider) provider.render();
    return proxy;
  })();
  restartQueue = next;
  return next;
}

async function moveViewToSecondarySidebar(): Promise<void> {
  try { await vscode.commands.executeCommand('workbench.action.moveViewToSecondarySidebar', 'dsh.chatView'); }
  catch (err) { log('warn', '移动到辅助侧边栏失败: ' + (err as Error).message); }
}

async function openSettings(): Promise<void> {
  try { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.dsh-vscode'); }
  catch (err) { log('warn', '打开设置失败: ' + (err as Error).message); }
}

async function openSidebar(): Promise<void> {
  try { await vscode.commands.executeCommand('workbench.view.extension.dsh'); }
  catch (err) { log('warn', '打开 DSH 视图失败: ' + (err as Error).message); }
  try { await vscode.commands.executeCommand('dsh.chatView.focus'); } catch { /* 视图尚未解析 */ }
  await moveViewToSecondarySidebar();
  if (!proxy || !(await probe(proxy.baseUrl, { timeoutMs: 1500 }))) {
    await prompt.promptAndPersist();
  }
}

function descriptionOfPortDetection(p: ProxyHandle | null, requested: string): string {
  if (!p) return '未启动代理';
  if (p.requestedBaseUrl === requested && p.detectedBaseUrl === false) return '未检测到，用默认 ' + p.baseUrl;
  if (p.detectedReason === 'explicit config') return '显式配置 ' + p.baseUrl;
  if (p.baseUrl === requested) return '配置端口直接可达';
  return '自动检测 → ' + p.baseUrl;
}

async function showDiagnostics(): Promise<void> {
  const requested = config.getBaseUrl();
  const used = (proxy && proxy.baseUrl) || requested;
  let reachable = '检测中…';
  try { const res = await fetch(new URL('/', used).href); reachable = '可达 (HTTP ' + res.status + ')'; }
  catch (err) { reachable = '不可达: ' + (err as Error).message; }
  const s = proxy ? proxy.stats : { httpRequests: 0, openPathCalls: 0, pickDirectoryCalls: 0, wsConnections: 0, wsFailures: 0 };
  const items = [
    { label: '$(settings-gear) 配置 harness 地址…', description: '打开输入框重新录入并保存', kind: vscode.QuickPickItemKind.Default, alwaysShow: true, action: 'configure' as const },
    { label: '代理端口', description: proxy ? proxy.origin : '未启动' },
    { label: 'harness 地址', description: used + ' — ' + reachable },
    { label: '端口检测', description: descriptionOfPortDetection(proxy, requested) },
    { label: 'HTTP 转发', description: String(s.httpRequests) },
    { label: 'openPath 拦截', description: String(s.openPathCalls) },
    { label: 'pickDirectory 拦截', description: (proxy && proxy.interceptPickDirectory ? '开' : '关') + ' · ' + s.pickDirectoryCalls + ' 次' },
    { label: 'WebSocket 透传', description: s.wsConnections + ' 连接 / ' + s.wsFailures + ' 失败' },
    { label: '最近打开的文件', description: (proxy && proxy.stats.interceptedPaths.slice(-3).join(' · ')) || '—' },
    { label: '最近选择的目录', description: (proxy && proxy.stats.pickedPaths.slice(-3).join(' · ')) || '—' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'DSH Client 诊断', matchOnDescription: true });
  if (picked && (picked as { action?: string }).action === 'configure') {
    await prompt.promptAndPersist();
  }
}

/** ③ 选区命令：把当前选中文本 + 模式词发给最近 DSH 会话。 */
async function sendSelectionToDsh(mode: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const sel = editor && editor.selection && !editor.selection.isEmpty ? editor.selection : null;
  const text = editor && sel ? editor.document.getText(sel) : undefined;
  if (!text) { vscode.window.showWarningMessage('DSH Client: 请先选中一段文本。'); return; }
  if (!proxy || !proxy.baseUrl || !proxy.lastSessionId) {
    vscode.window.showWarningMessage('DSH Client: 还没有活动的 DSH 会话，请先在 DSH 界面新建/打开会话。');
    return;
  }
  const promptText = mode + '（选中内容）：\n\n' + text.slice(0, 4000);
  try {
    // 走本地代理端口，让代理统一改写信任围栏头 + 注入编辑器上下文（文件/行号），并经 onSessionPrompt arm apply-diff
    const res = await fetch(proxy.origin + '/api/session.prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'ed-' + Date.now(), method: 'session.prompt', payload: { sessionId: proxy.lastSessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] } }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await vscode.commands.executeCommand('dsh.chatView.focus');
    vscode.window.showInformationMessage('DSH Client: 已发送「' + mode + '」到 DSH 会话。');
  } catch (err) {
    vscode.window.showErrorMessage('DSH Client: 发送失败 ' + (err as Error).message);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('DSH Client');
  context.subscriptions.push(output);
  log('info', 'DSH Client 激活');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(browser) DSH';
  statusBar.command = 'dsh.diagnostics';
  statusBar.tooltip = 'DSH Client — 点击查看端口检测与配置（DSH: 诊断）';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.openSidebar', openSidebar),
    vscode.commands.registerCommand('dsh.refresh', () => { if (provider) provider.refresh(); }),
    vscode.commands.registerCommand('dsh.diagnostics', showDiagnostics),
    vscode.commands.registerCommand('dsh.openInBrowser', () => { vscode.env.openExternal(vscode.Uri.parse(config.getBaseUrl())); }),
    vscode.commands.registerCommand('awakening.openSettings', openSettings),
    vscode.commands.registerCommand('awakening.configureHarnessUrl', () => prompt.promptAndPersist()),
    vscode.commands.registerCommand('awakening.explainSelection', () => sendSelectionToDsh('解释')),
    vscode.commands.registerCommand('awakening.fixSelection', () => sendSelectionToDsh('修复')),
    vscode.commands.registerCommand('awakening.refactorSelection', () => sendSelectionToDsh('重构'))
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('awakening.dsh')) {
        restartProxy().catch((err) => vscode.window.showErrorMessage('DSH Client: 代理重启失败 ' + (err as Error).message));
      }
    })
  );

  provider = new DshViewProvider({
    getOrigin: () => (proxy ? proxy.origin : ''),
    getStatus: () => (proxy ? { origin: proxy.origin, baseUrl: proxy.baseUrl, detected: proxy.detectedBaseUrl !== false } : null),
    logger: log,
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dsh.chatView', provider, { webviewOptions: { retainContextWhenHidden: true } })
  );

  const { dispose: disposeEditorCtx } = bindEditorContext(editorContext, vscode);
  context.subscriptions.push({ dispose: disposeEditorCtx });
  applyDiff = createApplyDiff(vscode, { log });
  context.subscriptions.push(applyDiff);

  try {
    await restartProxy().catch((err) => vscode.window.showErrorMessage(
      'DSH Client: 代理启动失败（' + (err as Error).message + '）。请确认 harness 在 ' + config.getBaseUrl() + ' 运行，或修改设置 awakening.dsh.baseUrl。'
    ));
  } catch { /* 已在 catch 里提示 */ }

  if (config.shouldAutoMove()) {
    moveTimer = setTimeout(() => { moveViewToSecondarySidebar(); }, 1200);
  }
  context.subscriptions.push({ dispose: () => { if (moveTimer) clearTimeout(moveTimer); } });
}

export async function deactivate(): Promise<void> {
  shuttingDown = true;
  await restartQueue.catch(() => {});
  if (proxy) { await proxy.close().catch(() => {}); proxy = null; }
  // applyDiff 已挂 context.subscriptions，由 VS Code 统一释放，这里不再重复 dispose
}
