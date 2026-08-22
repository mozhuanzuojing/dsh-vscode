import * as vscode from 'vscode';
import { mcpFind } from './openviking-mcp';
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
let agentRunning = false;
let agentIdleTimer: ReturnType<typeof setTimeout> | undefined;
let agentStatusBar: vscode.StatusBarItem | null = null;

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
      onMuxFrame: handleMuxFrame,
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

/** #7 OpenViking 语义检索：用本机 ov CLI 找与当前文件/工作区相关的上下文。失败/超时返回 ''（不阻塞注入）。 */
let ovWarned = false;
function ovFindContext(): Promise<string> {
  return new Promise((resolve) => {
    if (!config.openvikingRecallEnabled()) { resolve(''); return; }
    try {
      const editor = vscode.window.activeTextEditor;
      const doc = editor && editor.document;
      const query = (doc && doc.uri.fsPath.split('/').pop()) || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].name) || '当前项目';
      const OV_MCP_URL = 'http://127.0.0.1:1933/mcp';
      mcpFind(OV_MCP_URL, query, 3).then((recall) => {
        if (!recall.ok) {
          if (!ovWarned) { ovWarned = true; log('info', 'OpenViking MCP 不可用（' + OV_MCP_URL + '），[Repo Recall] 跳过；如需关闭请设 awakening.dsh.openvikingRecall=false'); }
          resolve(''); return;
        }
        resolve(recall.text); // ok=true：可达（可能 0 结果），不再误报"不可用"
      }).catch(() => { resolve(''); });
    } catch { resolve(''); }
  });
}

/** 经本地代理应答 server-request（approval/question 的 client-response）。 */
async function respondViaProxy(rpcId: string, value: unknown): Promise<boolean> {
  if (!proxy || !proxy.baseUrl || !rpcId) return false;
  try {
    const res = await fetch(proxy.origin + '/api/respond', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body: any = await res.json().catch(() => ({}));
    if (body && body.accepted === false) throw new Error('服务器拒绝应答: ' + (body.reason || ''));
    return true;
  } catch (err) { vscode.window.showErrorMessage('DSH Client: 应答失败 ' + (err as Error).message); return false; }
}

/** #1/#2/#3/#4 共享底座回调：tap mux 帧 → 回合状态 / 审批下沉 / 问题下沉。 */
function handleMuxFrame(frame: { type: string; payload?: unknown; rpcId?: string }): void {
  if (!frame || !frame.type) return;
  const p = (frame.payload || {}) as { sessionId?: string; approvalId?: string; toolName?: string; questions?: { id?: string; question?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[] };
  if (frame.type === 'session/event' || frame.type === 'session/queue' || frame.type === 'session/jobs' || frame.type === 'session/projection' || frame.type === 'approval/requested' || frame.type === 'question/requested') {
    agentRunning = true;
    if (agentStatusBar) { agentStatusBar.text = '$(sync~spin) DSH 回合中'; agentStatusBar.show(); }
    if (agentIdleTimer) clearTimeout(agentIdleTimer);
    agentIdleTimer = setTimeout(() => { agentRunning = false; if (agentStatusBar) { agentStatusBar.text = '$(check) DSH 空闲'; agentStatusBar.show(); } }, 20000);
  }
  if (frame.type === 'approval/requested' && p.sessionId && p.approvalId && frame.rpcId) {
    vscode.window.showWarningMessage('DSH 需要审批：工具 ' + (p.toolName || '?'), { modal: true }, '允许一次', '拒绝').then((choice) => {
      const outcome = choice === '允许一次' ? 'allowed-once' : 'rejected';
      respondViaProxy(frame.rpcId as string, { sessionId: p.sessionId, approvalId: p.approvalId, outcome });
    });
  } else if (frame.type === 'question/requested' && p.sessionId && frame.rpcId) {
    void (async () => {
      const q = (p.questions && p.questions[0]) as { id?: string; question?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean } | undefined;
      const qid = q && q.id ? q.id : 'q';
      const label = q && q.question ? q.question : '请回答';
      const opts = q && q.options ? q.options : undefined;
      const multi = q ? !!q.multiSelect : false;
      let ans: { id: string; selected: string[]; custom?: string }[];
      if (opts && opts.length > 0) {
        const items = opts.map((o) => ({ label: o.label, description: o.description }));
        const picked = await vscode.window.showQuickPick(items, { title: 'DSH 询问：' + label, canPickMany: multi, ignoreFocusOut: true });
        if (picked === undefined) { await respondViaProxy(frame.rpcId as string, { sessionId: p.sessionId, answer: { answers: [] } }); return; }
        const sel = Array.isArray(picked) ? picked.map((x) => x.label) : [picked.label];
        ans = [{ id: qid, selected: sel }];
      } else {
        const answer = await vscode.window.showInputBox({ prompt: 'DSH 询问：' + label, ignoreFocusOut: true });
        ans = answer === undefined ? [] : [{ id: qid, selected: [], custom: answer }];
      }
      await respondViaProxy(frame.rpcId as string, { sessionId: p.sessionId, answer: { answers: ans } });
    })();
  }
}

/** #1 取消当前回合：经本地代理发起 session.cancel（与 UI 同通道，头规范化）。 */
async function cancelSession(): Promise<void> {
  if (!proxy || !proxy.baseUrl || !proxy.lastSessionId) { vscode.window.showWarningMessage('DSH Client: 没有活动会话可取消。'); return; }
  try {
    const res = await fetch(proxy.origin + '/api/session.cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'cancel-' + Date.now(), method: 'session.cancel', payload: { sessionId: proxy.lastSessionId } }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body: any = await res.json().catch(() => ({}));
    if (body && body.result && body.result.ok === false) throw new Error('服务器拒绝: ' + JSON.stringify(body.result.error || {}));
    agentRunning = false; if (agentStatusBar) { agentStatusBar.text = '$(check) DSH 空闲'; agentStatusBar.show(); }
    vscode.window.showInformationMessage('DSH Client: 已发送取消。');
  } catch (err) { vscode.window.showErrorMessage('DSH Client: 取消失败 ' + (err as Error).message); }
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

  agentStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  agentStatusBar.text = '$(check) DSH 空闲';
  agentStatusBar.command = 'dsh.cancelSession';
  agentStatusBar.tooltip = 'DSH 回合状态；点击取消当前回合';
  agentStatusBar.show();
  context.subscriptions.push(agentStatusBar);

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
    vscode.commands.registerCommand('awakening.refactorSelection', () => sendSelectionToDsh('重构')),
    vscode.commands.registerCommand('dsh.cancelSession', cancelSession)
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
  editorContext.recall = ovFindContext;
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
  if (agentIdleTimer) clearTimeout(agentIdleTimer);
}
