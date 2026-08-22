export interface EditorState {
  filePath?: string;        // 绝对路径
  relativePath?: string;    // 相对工作区路径
  languageId?: string;      // 文件类型
  workspaceName?: string;   // 工作区名
  lineCount?: number;       // 文件总行数
  startLine?: number; endLine?: number;
  selectionText?: string;   // 选区文本（有选区时）
  fullText?: string;        // 全文（由 bind 侧提供，此处按大小决定是否嵌入）
}
export interface EditorContextBarrel { block: string; }
export interface VscodeLike {
  window: {
    activeTextEditor?: {
      document: {
        uri: { scheme: string; fsPath: string };
        languageId: string;
        lineCount: number;
        getText(range?: unknown): string;
      };
      selection: { isEmpty: boolean; start: { line: number }; end: { line: number } };
    };
    onDidChangeActiveTextEditor(cb: () => void): { dispose(): void };
    onDidChangeTextEditorSelection(cb: (e: { textEditor: unknown }) => void): { dispose(): void };
  };
  workspace: { workspaceFolders?: readonly { name: string; uri: { fsPath: string } }[] };
}

const MAX_SELECTION = 4000;
const MAX_WHOLE_FILE = 8000;
const MAX_FIRST_LINES = 200;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '\n…(截断)' : text;
}

/** 纯函数：编辑器状态 → 注入 DSH 的用户输入上下文块（[User Input]）。无活动文件时返回 ''。 */
export function formatEditorContext(s: EditorState): string {
  const filePath = s.filePath || s.relativePath;
  if (!filePath) return '';
  const out: string[] = [];
  out.push('[User Input]');
  if (s.workspaceName) out.push('workspace: ' + s.workspaceName);
  out.push('file: ' + (s.relativePath || s.filePath));
  if (s.languageId) out.push('language: ' + s.languageId);
  if (typeof s.startLine === 'number') {
    const end = typeof s.endLine === 'number' ? s.endLine : s.startLine;
    out.push('lines: ' + s.startLine + (end !== s.startLine ? '-' + end : ''));
  }
  // 内容优先级：选区 > 小文件全文 > 大文件前 200 行
  if (s.selectionText && s.selectionText.trim() !== '') {
    out.push('selection:');
    out.push(clip(s.selectionText, MAX_SELECTION));
  } else if (s.fullText && s.fullText.length <= MAX_WHOLE_FILE) {
    out.push('content (full):');
    out.push(s.fullText);
  } else if (s.fullText) {
    const first = s.fullText.split('\n').slice(0, MAX_FIRST_LINES).join('\n');
    out.push('content (first ' + MAX_FIRST_LINES + ' lines, total ' + (s.lineCount ?? '?') + '):');
    out.push(first);
  }
  out.push('[/User Input]');
  return out.join('\n') + '\n';
}

export function createEditorContext(): EditorContextBarrel {
  return { block: '' };
}

export function bindEditorContext(ctx: EditorContextBarrel, vscode: VscodeLike): { ctx: EditorContextBarrel; dispose(): void } {
  const disposables: { dispose(): void }[] = [];
  function refresh() {
    const editor = vscode.window.activeTextEditor;
    const doc = editor && editor.document;
    if (!doc || doc.uri.scheme !== 'file') { ctx.block = ''; return; }
    const sel = editor.selection && !editor.selection.isEmpty ? editor.selection : null;
    const folder = (vscode.workspace.workspaceFolders || []).find((f) => doc.uri.fsPath.startsWith(f.uri.fsPath));
    const rel = folder ? doc.uri.fsPath.slice(folder.uri.fsPath.length).replace(/^\//, '') : undefined;
    ctx.block = formatEditorContext({
      filePath: doc.uri.fsPath,
      relativePath: rel,
      languageId: doc.languageId,
      workspaceName: folder ? folder.name : undefined,
      lineCount: doc.lineCount,
      startLine: sel ? sel.start.line + 1 : undefined,
      endLine: sel ? sel.end.line + 1 : undefined,
      selectionText: sel ? doc.getText(sel) : undefined,
      fullText: doc.getText(),
    });
  }
  disposables.push(vscode.window.onDidChangeActiveTextEditor(refresh));
  disposables.push(vscode.window.onDidChangeTextEditorSelection((e: { textEditor: unknown }) => { if (e.textEditor === vscode.window.activeTextEditor) refresh(); }));
  refresh();
  return { ctx, dispose: () => { for (const d of disposables) { try { d.dispose(); } catch { /* noop */ } } } };
}