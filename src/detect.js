'use strict';
/**
 * 自动检测 DSH harness 真实监听地址（纯 Node，可独立测试）。
 *
 * 策略：
 *   1. 先试 preferred（配置值/默认 http://127.0.0.1:3080）。
 *   2. 连不上则在 ports 区间扫描 127.0.0.1，判据是响应正文含 HARNESS_BOOT_MARKER
 *      （harness 首页的 __DSH_BOOT__ 标志，与 probe.js / 冒烟一致）。
 *   3. 全部失败回退 preferred（由调用方决定是否告警）。
 */
const HARNESS_BOOT_MARKER = '__DSH_BOOT__';
const DEFAULT_PORTS = [3080, 3099]; // 含 dsh 默认 3082

async function probe(url, { timeoutMs = 1500, marker = HARNESS_BOOT_MARKER } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (res.status >= 500) return false;
    const text = await res.text();
    return text.includes(marker);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{url:string, detected:boolean, reason:string}>}
 */
async function detectHarnessUrl(options = {}) {
  const preferred = options.preferred || 'http://127.0.0.1:3080';
  const range = options.range || DEFAULT_PORTS;
  const log = options.log || ((_lvl, _msg) => {});
  const probeFn = options.probe || probe;

  // 1) 首选地址（配置值 / 默认 3080）
  if (await probeFn(preferred)) {
    return { url: preferred, detected: true, reason: 'preferred reachable' };
  }

  // 2) 扫描区间
  for (let port = range[0]; port <= range[1]; port++) {
    const url = `http://127.0.0.1:${port}`;
    if (url === preferred) continue; // 已在首选试过
    if (await probeFn(url)) {
      log('info', `自动检测到 harness: ${url}`);
      return { url, detected: true, reason: `scanned port ${port}` };
    }
  }

  // 3) 回退
  log('warn', `未检测到 harness（${range[0]}-${range[1]}），回退 ${preferred}`);
  return { url: preferred, detected: false, reason: 'no reachable harness' };
}

module.exports = { detectHarnessUrl, probe, HARNESS_BOOT_MARKER, DEFAULT_PORTS };
