export interface EditorState { filePath?: string; startLine?: number; endLine?: number; selectionText?: string; }
export interface EditorContextBarrel { block: string; }
export interface VscodeLike {
  window: {
    activeTextEditor?: { document: { uri: { scheme: string; fsPath: string }; getText(range?: unknown): string }; selection: { isEmpty: boolean; start: { line: number }; end: { line: number } } };
    onDidChangeActiveTextEditor(cb: () => void): { dispose(): void };
    onDidChangeTextEditorSelection(cb: (e: { textEditor: unknown }) => void): { dispose(): void };
  };
}

/** 纯函数：编辑器状态 → 注入 DSH 的上下文块。无活动文件时返回 ''（跳过）。 */
export function formatEditorContext({ filePath, startLine, endLine, selectionText }: EditorState): string {
  if (!filePath) return '';
  let body = 'file: ' + filePath;
  if (typeof startLine === 'number' && typeof endLine === 'number') {
    body += '\nlines: ' + startLine + (endLine !== startLine ? '-' + endLine : '');
  }
  if (typeof selectionText === 'string' && selectionText.trim() !== '') {
    const trimmed = selectionText.length > 4000 ? selectionText.slice(0, 4000) + '\n…(截断)' : selectionText;
    body += '\nselection:\n' + trimmed;
  }
  return '[editor-context]\n' + body + '\n[/editor-context]\n';
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
    ctx.block = formatEditorContext({
      filePath: doc.uri.fsPath,
      startLine: sel ? sel.start.line + 1 : undefined,
      endLine: sel ? sel.end.line + 1 : undefined,
      selectionText: sel ? doc.getText(sel) : undefined,
    });
  }
  disposables.push(vscode.window.onDidChangeActiveTextEditor(refresh));
  disposables.push(vscode.window.onDidChangeTextEditorSelection((e: { textEditor: unknown }) => { if (e.textEditor === vscode.window.activeTextEditor) refresh(); }));
  refresh();
  return { ctx, dispose: () => { for (const d of disposables) { try { d.dispose(); } catch { /* noop */ } } } };
}
