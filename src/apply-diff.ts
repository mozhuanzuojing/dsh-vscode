import * as vscode from 'vscode';

/**
 * ② 应用 diff（安全版）：agent(DSH) 把改动写到共享文件系统后，让编辑器的已打开文件同步新内容。
 * 只在一个「回合窗口」内生效（用户刚向 DSH 发消息/选区命令后的 30s）。
 * 只 revert「磁盘变了且没有本地未保存修改(isDirty=false)」的文件——绝不覆盖用户的脏改动。
 */
export interface ApplyDiff {
  /** 打开回合窗口：之后 30s 内外部文件变更若命中已打开的非脏编辑器则 revert。 */
  armTurnWindow(durationMs?: number): void;
  dispose(): void;
}

interface OpenDoc { uri: vscode.Uri; isDirty: boolean; }

export function createApplyDiff(vscodeRef: typeof vscode): ApplyDiff {
  let armUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function openDirtyMap(): Map<string, OpenDoc> {
    const map = new Map<string, OpenDoc>();
    for (const doc of vscodeRef.workspace.textDocuments) {
      if (doc.uri.scheme === 'file') map.set(doc.uri.fsPath, { uri: doc.uri, isDirty: doc.isDirty });
    }
    return map;
  }

  function revertIfSafe(fsPath: string): void {
    const map = openDirtyMap();
    const entry = map.get(fsPath);
    if (!entry) return;                 // 没打开这个文件
    if (entry.isDirty) {                // 有未保存修改 ⚠️ 绝不覆盖
      console.log('[dsh-client] 跳过 revert（文件有未保存修改）: ' + fsPath);
      return;
    }
    vscodeRef.commands.executeCommand('workbench.action.files.revert', entry.uri).then(
      () => {}, (e: Error) => console.log('[dsh-client] revert 失败: ' + e.message));
    console.log('[dsh-client] 已同步磁盘改动到编辑器: ' + fsPath);
  }

  const watcher = vscodeRef.workspace.createFileSystemWatcher('**/*', false, true, false);
  watcher.onDidChange((uri) => { if (Date.now() < armUntil && uri.scheme === 'file') revertIfSafe(uri.fsPath); });

  function armTurnWindow(durationMs = 30000): void {
    armUntil = Date.now() + durationMs;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { armUntil = 0; }, durationMs + 500);
    console.log('[dsh-client] 应用 diff 窗口已开启（' + durationMs + 'ms）');
  }

  return { armTurnWindow, dispose: () => { if (timer) clearTimeout(timer); watcher.dispose(); } };
}
