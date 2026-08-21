'use strict';
/**
 * 交互式 harness 地址补录模块。所有副作用（输入框/消息/探测/持久化/重启代理）都通过
 * 注入的适配器调用，这里只保留流程与分支逻辑，可用 fake 适配器单元测试。
 */
const DEFAULT_SUGGEST = 'http://localhost:';

/**
 * @param {object} deps
 * @param {(opts)=>Promise<string|undefined>} deps.showInputBox
 * @param {(msg:string)=>void} deps.showError
 * @param {(msg:string)=>void} deps.showWarning
 * @param {(msg:string)=>void} deps.showInfo
 * @param {(url:string)=>Promise<boolean>} deps.isReachable
 * @param {(url:string)=>Promise<void>} deps.persistUrl
 * @param {()=>Promise<any>} deps.restartProxy
 * @param {(level:string,msg:string)=>void} [deps.log]
 */
function createPrompt(deps) {
  let inProgress = false;

  async function promptAndPersist() {
    if (inProgress) { // 防并发：多入口同时触发只弹一个
      deps.log && deps.log('info', '配置弹窗已在打开，忽略重复触发');
      return null;
    }
    inProgress = true;
    try {
      let lastValue;
      const ask = () => deps.showInputBox({ value: lastValue === undefined ? DEFAULT_SUGGEST : lastValue });

      for (let attempt = 0; ; attempt++) {
        const entered = await ask();
        if (entered === undefined) {
          deps.log && deps.log('info', '用户取消 harness 地址录入');
          return null;
        }
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
          try {
            await deps.persistUrl(url);
            deps.showInfo('已确认并保存 harness 地址 ' + url);
          } catch (err) {
            deps.showWarning('已确认地址 ' + url + '，但保存到设置失败（' + err.message + '）。本次会话仍使用。');
          }
          try {
            await deps.restartProxy();
          } catch (err) {
            deps.showError('应用新地址时代理重启失败 ' + err.message);
          }
          return url;
        }
        deps.showError(url + ' 不是可用的 DSH 服务（判据 __DSH_BOOT__ 未命中），请重试。');
        if (attempt >= 1) {
          deps.showInfo('未配置成功，可在设置 awakening.dsh.baseUrl 中手动填写，或稍后再试。');
          return null;
        }
      }
    } catch (err) {
      deps.log && deps.log('warn', '配置 harness 地址过程异常: ' + err.message);
      return null;
    } finally {
      inProgress = false;
    }
  }

  return { promptAndPersist };
}

module.exports = { createPrompt, DEFAULT_SUGGEST };
