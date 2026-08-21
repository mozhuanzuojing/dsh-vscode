'use strict';
/**
 * 配置模块（纯读）：封装 awakening.dsh.* 的全部配置读取与校验。
 * 通过注入的 getConfiguration 函数访问 VS Code 配置，测试时注入 fake 即可。
 * 不含编排/检测/UI 逻辑。
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';
const DEFAULT_PROBE_RANGE = [3080, 3099];
const CONFIG_NAMESPACE = 'awakening.dsh';

/** 规范化 harness 地址：trim、补 http://、URL 校验。非法返回 null。 */
function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') return null;
  let url = raw.trim();
  if (url === '') return null;
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try { return new URL(url).href; } catch { return null; }
}

/**

 * @param {(ns:string)=>object} getConfiguration - 返回含 get/inspect/update 的配置对象
 */
function createConfig(getConfiguration) {
  const cfg = () => getConfiguration(CONFIG_NAMESPACE);
  return {
    CONFIG_NAMESPACE,
    getBaseUrl() {
      return cfg().get('baseUrl', DEFAULT_BASE_URL);
    },
    /** 用户是否显式配置 baseUrl（是则尊重、不做自动扫描）。 */
    isBaseUrlExplicit() {
      const inspected = cfg().inspect('baseUrl');
      return !!(inspected && (inspected.globalValue !== undefined || inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined));
    },
    /** 自动检测端口范围：非法配置回退默认。 */
    getProbeRange() {
      const v = cfg().get('probeRange', DEFAULT_PROBE_RANGE);
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && v[0] <= v[1]) return v;
      return DEFAULT_PROBE_RANGE;
    },
    shouldAutoMove() {
      return cfg().get('autoMoveToSecondarySidebar', true);
    },
    pickDirectoryIntercepted() {
      return cfg().get('interceptPickDirectory', true);
    },
    normalizeBaseUrl,
    updateBaseUrl(url, target) {
      return cfg().update('baseUrl', url, target);
    },
  };
}

module.exports = { createConfig, normalizeBaseUrl, DEFAULT_BASE_URL, DEFAULT_PROBE_RANGE, CONFIG_NAMESPACE };
