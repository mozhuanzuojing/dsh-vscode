export interface PromptDeps {
  showInputBox(opts: { value?: string }): Promise<string | undefined>;
  showError(msg: string): void;
  showWarning(msg: string): void;
  showInfo(msg: string): void;
  isReachable(url: string): Promise<boolean>;
  persistUrl(url: string): Promise<void>;
  restartProxy(): Promise<unknown>;
  log?(level: string, msg: string): void;
}
export const DEFAULT_SUGGEST = 'http://localhost:';

export function createPrompt(deps: PromptDeps) {
  let inProgress = false;
  async function promptAndPersist(): Promise<string | null> {
    if (inProgress) {
      deps.log && deps.log('info', '配置弹窗已在打开，忽略重复触发');
      return null;
    }
    inProgress = true;
    try {
      let lastValue: string | undefined;
      const ask = () => deps.showInputBox({ value: lastValue === undefined ? DEFAULT_SUGGEST : lastValue });
      for (let attempt = 0; ; attempt++) {
        const entered = await ask();
        if (entered === undefined) { deps.log && deps.log('info', '用户取消 harness 地址录入'); return null; }
        lastValue = entered;
        let url = entered.trim();
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
        try { new URL(url); } catch {
          deps.showError('地址格式无效，请输入形如 http://localhost:3082 的完整地址。');
          if (attempt >= 1) return null;
          continue;
        }
        deps.log && deps.log('info', '录入地址复核: ' + url);
        if (await deps.isReachable(url)) {
          try { await deps.persistUrl(url); }
          catch (err) {
            deps.showWarning('已确认地址 ' + url + ' 可达，但保存到设置失败（' + String((err as Error).message) + '）；未生效。请重试或到设置 awakening.dsh.baseUrl 手动填写。');
            return null;
          }
          deps.showInfo('已确认并保存 harness 地址 ' + url);
          try { await deps.restartProxy(); }
          catch (err) { deps.showError('应用新地址时代理重启失败 ' + String((err as Error).message)); }
          return url;
        }
        deps.showError(url + ' 不是可用的 DSH 服务（判据 __DSH_BOOT__ 未命中），请重试。');
        if (attempt >= 1) {
          deps.showInfo('未配置成功，可在设置 awakening.dsh.baseUrl 中手动填写，或稍后再试。');
          return null;
        }
      }
    } catch (err) {
      deps.log && deps.log('warn', '配置 harness 地址过程异常: ' + String((err as Error).message));
      return null;
    } finally {
      inProgress = false;
    }
  }
  return { promptAndPersist };
}
export type Prompt = ReturnType<typeof createPrompt>;
