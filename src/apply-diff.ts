import * as vscode from 'vscode';

/**
 * ② 应用 diff（安全版）：agent(DSH) 把改动写到共享文件系统后，让编辑器的已打开文件同步新内容。
 * 只在一个「回合窗口」内生效（用户刚向 DSH 发消息/选区命令后的 30s）。
 * 只 revert「磁盘变了且没有本地未保存修改(isDirty=false)」的文件——绝不覆盖用户的脏改动。
 */
export interface ApplyDiffOptions {
  log?: (level: string, msg: string) => void;
}

export interface ApplyDiff {
  /** 打开回合窗口：之后 30s 内外部文件变更若命中已打开的非脏编辑器则 revert。 */
  armTurnWindow(durationMs?: number): void;
  dispose(): void;
}

interface OpenDoc { uri: vscode.Uri; isDirty: boolean; }

export function createApplyDiff(vscodeRef: typeof vscode, options: ApplyDiffOptions = {}): ApplyDiff {
  const log = options.log || ((_l: string, _m: string) => {});
  let armUntil = 0;
  let disposed = false;
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
      log('info', '跳过 revert（文件有未保存修改）: ' + fsPath);
      return;
    }
    vscodeRef.commands.executeCommand('workbench.action.files.revert', entry.uri).then(
      () => {}, (e: Error) => log('info', 'revert 失败: ' + e.message));
    log('info', '已同步磁盘改动到编辑器: ' + fsPath);
  }

  const watcher = vscodeRef.workspace.createFileSystemWatcher('**/*', true, false, true);
  watcher.onDidChange((uri) => { if (Date.now() < armUntil && uri.scheme === 'file') revertIfSafe(uri.fsPath); });

  function armTurnWindow(durationMs = 30000): void {
    if (disposed) return;
    if (!vscodeRef.workspace.workspaceFolders || vscodeRef.workspace.workspaceFolders.length === 0) {
      log('warn', '未打开工作区文件夹：文件系统监听（**/*）不会生效，② 应用 diff 本窗口不可用');
    }
    armUntil = Date.now() + durationMs;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { armUntil = 0; }, durationMs + 500);
    log('info', '应用 diff 窗口已开启（' + durationMs + 'ms）');
  }

  return { armTurnWindow, dispose: () => { if (disposed) return; disposed = true; if (timer) clearTimeout(timer); watcher.dispose(); } };
}
