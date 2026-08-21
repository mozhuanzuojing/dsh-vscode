'use strict';
/**
 * 编辑器上下文：让 DSH 会话知道用户当前在看哪个文件、选中了哪几行。
 * 纯逻辑（取文件+选区 → 格式化块）可独立测试；VS Code 事件绑定单独注入。
 */
/** 纯函数：把编辑器状态格式化成给 DSH 的上下文文本块。无活动文件/选区时返回 ''（跳过注入）。 */
function formatEditorContext({ filePath, startLine, endLine, selectionText }) {
  if (!filePath) return '';
  let body = 'file: ' + filePath;
  if (typeof startLine === 'number' && typeof endLine === 'number') {
    body += '\nlines: ' + startLine + (endLine !== startLine ? '-' + endLine : '');
  }
  if (typeof selectionText === 'string' && selectionText.trim() !== '') {
    // 选区文本参与注入（控制在合理长度内，避免撑爆上下文）
    const trimmed = selectionText.length > 4000 ? selectionText.slice(0, 4000) + '\n…(截断)' : selectionText;
    body += '\nselection:\n' + trimmed;
  }
  return '[editor-context]\n' + body + '\n[/editor-context]\n';
}
/** 共享上下文状态对象：extension 侧更新 block，proxy 侧在 session.prompt 时读取。 */
function createEditorContext() {
  return { block: '' };
}
/** 绑定 VS Code 编辑器事件 → 更新上下文共享对象。 */
function bindEditorContext(ctx, vscode) {
  function refresh() {
    const editor = vscode.window && vscode.window.activeTextEditor;
    const doc = editor && editor.document;
    if (!doc || doc.uri.scheme !== 'file') {
      ctx.block = '';
      return;
    }
    const sel = editor.selection && !editor.selection.isEmpty ? editor.selection : null;
    ctx.block = formatEditorContext({
      filePath: doc.uri.fsPath,
      startLine: sel ? sel.start.line + 1 : undefined,
      endLine: sel ? sel.end.line + 1 : undefined,
      selectionText: sel ? doc.getText(sel) : undefined,
    });
  }
  vscode.window.onDidChangeActiveTextEditor(refresh);
  vscode.window.onDidChangeTextEditorSelection((e) => { if (e.textEditor === vscode.window.activeTextEditor) refresh(); });
  refresh();
  return ctx;
}
module.exports = { createEditorContext, formatEditorContext, bindEditorContext };
