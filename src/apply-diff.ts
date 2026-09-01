import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * ② 应用 diff（确认制）：agent(DSH) 把改动写到共享文件系统后，不直接覆盖编辑器，
 * 而是先给用户「变更文件列表 → diff 预览 → 应用/忽略」的确认流。
 * 只在一个「回合窗口」内生效（右键命令发消息后的 30s）。
 * 只对「磁盘变了且没有本地未保存修改(isDirty=false)」的文件生效——绝不覆盖用户的脏改动。
 */
export interface ApplyDiffOptions {
  log?: (level: string, msg: string) => void;
}

export interface ApplyDiff {
  /** 打开回合窗口：之后 30s 内外部文件变更若命中已打开的非脏编辑器，走确认流。 */
  armTurnWindow(durationMs?: number): void;
  dispose(): void;
}

interface OpenDoc { uri: vscode.Uri; isDirty: boolean; }

export function createApplyDiff(vscodeRef: typeof vscode, options: ApplyDiffOptions = {}): ApplyDiff {
  const log = options.log || ((_l: string, _m: string) => {});
  let armUntil = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 窗口内「快照」：fsPath -> 开启窗口时的编辑器 buffer 内容（agent 改之前的版本）。 */
  let snapshots = new Map<string, string>();
  let collecting = false;
  let pending = new Map<string, string>(); // fsPath -> 快照内容（记录一次窗口内变更集合）

  /** 快照当前所有打开的非脏文件内容。 */
  function snapshotOpenDocs(): void {
    const map = new Map<string, string>();
    for (const doc of vscodeRef.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' && !doc.isDirty) {
        try { map.set(doc.uri.fsPath, doc.getText()); } catch { /* noop */ }
      }
    }
    snapshots = map;
  }

  function openDirtyMap(): Map<string, OpenDoc> {
    const map = new Map<string, OpenDoc>();
    for (const doc of vscodeRef.workspace.textDocuments) {
      if (doc.uri.scheme === 'file') map.set(doc.uri.fsPath, { uri: doc.uri, isDirty: doc.isDirty });
    }
    return map;
  }

  /** djb2 字符串 hash：给快照临时文件名加唯一后缀，避免跨目录同名/中文名碰撞。 */
  function hashOf(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  let snapshotSeq = 0;
  /** 把快照写到临时文件，供 diff 左侧（改前）使用；文件名含 basename + fsPath hash + 递增序号，避免碰撞。 */
  function writeSnapshotTmp(fsPath: string, content: string): string {
    const tmpDir = path.join(os.tmpdir(), 'dsh-awakening-snapshots');
    fs.mkdirSync(tmpDir, { recursive: true });
    const base = path.basename(fsPath);
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'file';
    const uniq = hashOf(fsPath) + '-' + (++snapshotSeq);
    const tmpPath = path.join(tmpDir, safe + '.' + uniq + '.snapshot');
    fs.writeFileSync(tmpPath, content, 'utf8');
    return tmpPath;
  }

  /** 应用：把编辑器 buffer 拉回磁盘版本（等于 agent 的改动生效）。 */
  async function applyChange(fsPath: string): Promise<void> {
    const map = openDirtyMap();
    const entry = map.get(fsPath);
    if (!entry) { log('info', '应用：文件已关闭，跳过（磁盘已是 agent 版本）: ' + fsPath); return; }
    if (entry.isDirty) {
      log('info', '应用：文件有未保存修改，跳过（绝不覆盖）: ' + fsPath);
      vscodeRef.window.showWarningMessage('DSH Client: 文件有未保存修改，已跳过应用: ' + path.basename(fsPath));
      return;
    }
    await vscodeRef.commands.executeCommand('workbench.action.files.revert', entry.uri);
    log('info', '已应用磁盘改动到编辑器: ' + fsPath);
  }

  /** 打开 diff 视图：左=快照（改前），右=磁盘实际文件（改后）。 */
  async function previewDiff(fsPath: string): Promise<void> {
    const snapshot = snapshots.get(fsPath);
    if (snapshot === undefined) { log('info', 'diff 预览：无快照，跳过: ' + fsPath); return; }
    const tmpPath = writeSnapshotTmp(fsPath, snapshot);
    const left = vscodeRef.Uri.file(tmpPath);
    const right = vscodeRef.Uri.file(fsPath);
    await vscodeRef.commands.executeCommand('vscode.diff', left, right, path.basename(fsPath) + '（agent 变更预览）');
  }

  /** 全部应用：遍历 pending 逐个 applyChange（仍受 isDirty 保护）。 */
  async function applyAll(): Promise<void> {
    const list = [...pending.keys()];
    for (const fsPath of list) await applyChange(fsPath);
    pending = new Map();
  }

  /** 全部忽略：不应用任何变更（磁盘保留 agent 版本，编辑器不动）。 */
  function ignoreAll(): void {
    pending = new Map();
  }

  /** 组装文件列表 QuickPick items（顶部批量项 + 每个变更文件）。 */
  function buildItems(count: number): { label: string; description: string; alwaysShow: boolean; fsPath?: string; applyAll?: boolean; ignoreAll?: boolean }[] {
    const items: { label: string; description: string; alwaysShow: boolean; fsPath?: string; applyAll?: boolean; ignoreAll?: boolean }[] = [
      { label: '$(check-all) 全部应用', description: '应用全部 ' + count + ' 个变更', alwaysShow: true, applyAll: true },
      { label: '$(circle-slash) 全部忽略', description: '忽略全部 ' + count + ' 个变更（不应用）', alwaysShow: true, ignoreAll: true },
    ];
    for (const [fsPath] of pending.entries()) items.push({ label: '$(diff) ' + path.basename(fsPath), description: fsPath, alwaysShow: true, fsPath });
    return items;
  }

  /** 确认流：QuickPick 列出变更文件（可预览 diff、逐个应用/忽略；也可一键全部应用/全部忽略）。 */
  async function runConfirmFlow(): Promise<void> {
    if (pending.size === 0) return;
    collecting = true;
    try {
      while (true) {
        const items = buildItems(pending.size);
        const picked = await vscodeRef.window.showQuickPick(items, {
          title: 'DSH agent 变更了 ' + pending.size + ' 个文件',
          placeHolder: '选择文件：回车应用；「预览」查看 diff；Esc 忽略全部',
          matchOnDescription: true,
        });
        if (!picked) { log('info', '确认流：用户忽略（Esc），不做任何应用'); return; }
        if ((picked as { applyAll?: boolean }).applyAll || (picked as { ignoreAll?: boolean }).ignoreAll) {
          if ((picked as { applyAll?: boolean }).applyAll) await applyAll();
          else ignoreAll();
          return;
        }
        const fsPath = (picked as { fsPath?: string }).fsPath || (picked as { description?: string }).description || '';
        const action = await vscodeRef.window.showQuickPick(
          [
            { label: '$(check) 应用此变更', description: '把磁盘改动同步到编辑器', apply: true },
            { label: '$(diff) 预览 diff', description: '打开对比视图（改前 vs 改后）', apply: false, preview: true },
            { label: '$(check-all) 全部应用', description: '应用全部剩余变更', apply: false, allApply: true },
            { label: '$(circle-slash) 忽略此变更', description: '不改动编辑器；磁盘保留 agent 版本', apply: false, ignore: true },
            { label: '$(circle-slash) 全部忽略', description: '忽略全部剩余变更', apply: false, allIgnore: true },
          ],
          { title: path.basename(fsPath), placeHolder: '选择操作' }
        );
        if (!action) continue;
        if ((action as { apply?: boolean }).apply) { await applyChange(fsPath); pending.delete(fsPath); }
        else if ((action as { preview?: boolean }).preview) { await previewDiff(fsPath); }
        else if ((action as { allApply?: boolean }).allApply) { await applyAll(); return; }
        else if ((action as { allIgnore?: boolean }).allIgnore) { ignoreAll(); return; }
        else if ((action as { ignore?: boolean }).ignore) { pending.delete(fsPath); }
        if (pending.size === 0) return;
      }
    } catch (err) {
      log('warn', '确认流异常: ' + String((err as Error).message));
    } finally {
      collecting = false;
      pending = new Map();
    }
  }

  const watcher = vscodeRef.workspace.createFileSystemWatcher('**/*', true, false, true);
  watcher.onDidChange((uri) => {
    if (Date.now() >= armUntil || uri.scheme !== 'file') return;
    const openMap = openDirtyMap();
    const entry = openMap.get(uri.fsPath);
    if (!entry || entry.isDirty) return;      // 未打开/有未保存修改的不动
    if (!snapshots.has(uri.fsPath)) return;   // 窗口开启时未打开的文件无快照，不动
    pending.set(uri.fsPath, snapshots.get(uri.fsPath) || '');
    if (collecting) return;
    collecting = true;
    setTimeout(async () => {
      collecting = false;
      if (pending.size > 0 && Date.now() < armUntil) await runConfirmFlow();
      else pending = new Map();
    }, 800);
  });

  function armTurnWindow(durationMs = 30000): void {
    if (disposed) return;
    if (!vscodeRef.workspace.workspaceFolders || vscodeRef.workspace.workspaceFolders.length === 0) {
      log('warn', '未打开工作区文件夹：文件系统监听（**/*）不会生效，② 应用 diff 本窗口不可用');
    }
    armUntil = Date.now() + durationMs;
    pending = new Map();
    snapshotOpenDocs();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { armUntil = 0; snapshots = new Map(); pending = new Map(); }, durationMs + 500);
    log('info', '应用 diff 窗口已开启（' + durationMs + 'ms），已快照 ' + snapshots.size + ' 个打开文件');
  }

  return {
    armTurnWindow,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      watcher.dispose();
      snapshots = new Map();
      pending = new Map();
    },
  };
}
