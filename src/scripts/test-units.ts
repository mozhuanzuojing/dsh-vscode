// @ts-nocheck
/* 架构改进后的单元测试：config 模块 + prompt 模块（注入 fake，无需 VS Code）。 */
import { createConfig } from '../config';
import { createPrompt } from '../prompt';

let failures = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : '')); if (!ok) failures++; }

function stubConfig(overrides) {
  return {
    get: (k, def) => (overrides && k in overrides) ? overrides[k] : def,
    inspect: () => ({}),
    update: async () => {},
  };
}

// ---- config 模块 ----
const cfg = createConfig(() => stubConfig({ baseUrl: 'localhost:3082', probeRange: [4000, 4099] }));
check('normalizeBaseUrl 补协议', cfg.normalizeBaseUrl('localhost:3082') === 'http://localhost:3082/');
check('normalizeBaseUrl 保留完整', cfg.normalizeBaseUrl('http://127.0.0.1:3082') === 'http://127.0.0.1:3082/');
check('normalizeBaseUrl 空串→null', cfg.normalizeBaseUrl('   ') === null);
check('normalizeBaseUrl 非法→null', cfg.normalizeBaseUrl('not a url') === null);
// probeRange 非法回退默认
const cfgBad = createConfig(() => stubConfig({ probeRange: [9999] }));
check('getProbeRange 非法回退默认', JSON.stringify(cfgBad.getProbeRange()) === '[3080,3099]');
check('getProbeRange 合法保留', JSON.stringify(cfg.getProbeRange()) === '[4000,4099]');
// hasScopeOverride
const cfgNoOverride = createConfig(() => ({ get: () => {}, inspect: () => ({}), update: async () => {} }));
check('hasScopeOverride false', cfgNoOverride.hasScopeOverride() === false);
const cfgWithOverride = createConfig(() => ({ get: () => {}, inspect: () => ({ workspaceValue: 'http://override:8080' }), update: async () => {} }));
check('hasScopeOverride true', cfgWithOverride.hasScopeOverride() === true);
const cfgFolderOverride = createConfig(() => ({ get: () => {}, inspect: () => ({ workspaceFolderValue: 'http://folder:8080' }), update: async () => {} }));
check('hasScopeOverride workspaceFolderValue', cfgFolderOverride.hasScopeOverride() === true);
// ---- editor-context 模块 ----
import { formatEditorContext } from '../editor-context';
check('formatEditorContext 无文件→空串', formatEditorContext({}) === '');
check('formatEditorContext 头尾 User Input', formatEditorContext({ filePath: '/a/b.ts' }).startsWith('[User Input]\n') && formatEditorContext({ filePath: '/a/b.ts' }).includes('[/User Input]'));
check('formatEditorContext 相对路径+类型+工作区',
  formatEditorContext({ filePath: '/ws/a/b.ts', relativePath: 'a/b.ts', languageId: 'typescript', workspaceName: 'proj' })
    .includes('file: a/b.ts') &&
  formatEditorContext({ filePath: '/ws/a/b.ts', relativePath: 'a/b.ts', languageId: 'typescript', workspaceName: 'proj' })
    .includes('language: typescript') &&
  formatEditorContext({ filePath: '/ws/a/b.ts', relativePath: 'a/b.ts', languageId: 'typescript', workspaceName: 'proj' })
    .includes('workspace: proj'));
check('formatEditorContext 路径+选区',
  formatEditorContext({ filePath: '/a/b.ts', startLine: 5, endLine: 10, selectionText: 'hello' }).includes('file: /a/b.ts') &&
  formatEditorContext({ filePath: '/a/b.ts', startLine: 5, endLine: 10, selectionText: 'hello' }).includes('lines: 5-10') &&
  formatEditorContext({ filePath: '/a/b.ts', startLine: 5, endLine: 10, selectionText: 'hello' }).includes('selection:') &&
  formatEditorContext({ filePath: '/a/b.ts', startLine: 5, endLine: 10, selectionText: 'hello' }).includes('hello'));
check('formatEditorContext 小文件全文', formatEditorContext({ filePath: '/a/b.ts', fullText: 'line1\nline2', lineCount: 2 }).includes('content (full):') && formatEditorContext({ filePath: '/a/b.ts', fullText: 'line1\nline2', lineCount: 2 }).includes('line2'));
check('formatEditorContext 大文件前200行', formatEditorContext({ filePath: '/a/b.ts', fullText: Array(300).fill('x'.repeat(50)).join('\n'), lineCount: 300 }).includes('content (first 200 lines, total 300):'));
const bigBlock = formatEditorContext({ filePath: '/a/b.ts', fullText: Array(300).fill('x'.repeat(500)).join('\n'), lineCount: 300 });
check('formatEditorContext 大文件字符上限', bigBlock.length < 9000 && bigBlock.includes('…(截断)'));
check('formatEditorContext 截断', formatEditorContext({ filePath: '/a/b.ts', selectionText: 'x'.repeat(5000) }).includes('(截断)'));




// ---- prompt 模块 ----
(async () => {
  // 场景1：确认→持久化→重启
  const calls = [];
  const p1 = createPrompt({
    showInputBox: async () => 'http://localhost:3082',
    showError: (m) => calls.push('err:' + m),
    showWarning: (m) => calls.push('warn:' + m),
    showInfo: (m) => calls.push('info:' + m),
    isReachable: async () => true,
    persistUrl: async (url) => calls.push('persist:' + url),
    restartProxy: async () => { calls.push('restart'); },
    log: () => {},
  });
  const r1 = await p1.promptAndPersist();
  check('prompt 成功→返回 url', r1 === 'http://localhost:3082');
  check('prompt 成功→持久化+重启', calls.includes('persist:http://localhost:3082') && calls.includes('restart'));

  // 场景2：取消→null
  const p2 = createPrompt({ showInputBox: async () => undefined, showError: () => {}, showWarning: () => {}, showInfo: () => {}, isReachable: async () => false, persistUrl: async () => {}, restartProxy: async () => {}, log: () => {} });
  const r2 = await p2.promptAndPersist();
  check('prompt 取消→null', r2 === null);

  // 场景3：非法格式→重试→成功（重试保留上一次输入）
  let askCount3 = 0;
  let lastShown3 = '';
  const p3 = createPrompt({
    showInputBox: async (opts) => { askCount3++; lastShown3 = opts.value; return askCount3 === 1 ? 'not a url' : 'localhost:3082'; },
    showError: () => {}, showWarning: () => {}, showInfo: () => {},
    isReachable: async () => true, persistUrl: async () => {}, restartProxy: async () => {}, log: () => {},
  });
  const r3 = await p3.promptAndPersist();
  check('prompt 重试→成功', r3 === 'http://localhost:3082' && askCount3 === 2);
  check('prompt 重试时第二次输入的 value = 上次输入(not a url)', askCount3 === 2 && lastShown3 === 'not a url');

  // 场景4：并发守卫——第二次调用直接 null
  let resolveAsk; const gate = new Promise(r => { resolveAsk = r; });
  let asks = 0;
  const p4 = createPrompt({
    showInputBox: async () => { asks++; await gate; return undefined; },
    showError: () => {}, showWarning: () => {}, showInfo: () => {}, isReachable: async () => false, persistUrl: async () => {}, restartProxy: async () => {}, log: () => {},
  });
  const first = p4.promptAndPersist();
  const second = await p4.promptAndPersist(); // 此时 first 仍在等输入
  check('prompt 并发二次→null', second === null);
  resolveAsk(undefined);
  await first;

  console.log(failures === 0 ? '\n全部通过 ✅' : '\n' + failures + ' 项失败 ❌');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
