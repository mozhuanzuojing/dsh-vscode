export const HARNESS_BOOT_MARKER = '__DSH_BOOT__';
export const DEFAULT_PORTS: readonly [number, number] = [3080, 3099]; // 含 dsh 默认 3082

export interface ProbeOptions { timeoutMs?: number; marker?: string; }
export async function probe(url: string, options: ProbeOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const marker = options.marker ?? HARNESS_BOOT_MARKER;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const opts = { signal: ac.signal };
  try {
    // DSH 0.1.2-rc.1 用 launch token 认证：`?token=` 首次访问 303 换 `dsh-auth-*`
    // 会话 cookie。这里不自动跟随重定向（fetch 默认不保存 set-cookie），而是手动
    // 拿到 set-cookie 后带 cookie 请求干净 `/`，再判断 `__DSH_BOOT__`。否则无 token
    // 的请求和"已换 cookie 但未带上"的请求都会拿到 401 占位页（判据不命中）。
    const res = await fetch(url, { ...opts, redirect: 'manual' });
    // 无认证的旧 harness：200 直接含 marker。
    if (res.status === 200) {
      const text = await res.text();
      if (text.includes(marker)) return true;
    }
    // launch-token 换 cookie：303 + set-cookie → 带 cookie 请求干净 origin 验证。
    if (res.status === 303) {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const cookie = setCookie.split(';')[0]; // `<name>=<value>`
        const clean = new URL(url, 'http://dsh.invalid');
        clean.search = '';
        const ok = await fetch(clean.toString(), { ...opts, headers: { cookie } });
        if (ok.status === 200) {
          const text = await ok.text();
          return text.includes(marker);
        }
      }
      return false;
    }
    // 401（无 token 无 cookie）或其它非 2xx → 未命中。
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface DetectOptions {
  preferred?: string;
  range?: readonly [number, number] | readonly number[];
  marker?: string;
  probeFn?: (url: string) => Promise<boolean>;
  log?: (level: string, msg: string) => void;
}
export interface DetectResult { url: string; detected: boolean; reason: string; }

/**
 * DSH 0.1.2-rc.1 的 launch token 认证：用户可能填带 `?token=` 的地址。该 token 是
 * 进程启动时随机生成、由 `dsh web` 打印；它只用于 iframe 首次加载换 `dsh-auth-*`
 * 会话 cookie，之后走 cookie 认证。
 *
 * 这里把它从配置地址里抽出来，并把地址归一为「干净 origin」（无 token）作为 proxy 的
 * baseUrl——token 只在 view 的 iframe 首次 src 里出现，不能残留到 proxy baseUrl（否则
 * 已认证的请求会被 harness 反复 303 重定向）。
 * @returns `{ baseUrl, launchToken }`；launchToken 为空白时表示无需 token（旧 harness）。
 */
export function splitLaunchToken(url: string): { baseUrl: string; launchToken: string } {
  let u: URL;
  try { u = new URL(url, 'http://dsh.invalid'); } catch { return { baseUrl: url, launchToken: '' }; }
  const token = u.searchParams.get('token') ?? '';
  if (token !== '') u.searchParams.delete('token');
  // 归一为 origin + "/"（去掉可能残留的无意义 path/query）
  const baseUrl = u.origin + '/';
  return { baseUrl, launchToken: token };
}

export async function detectHarnessUrl(options: DetectOptions = {}): Promise<DetectResult> {
  const preferred = options.preferred || 'http://127.0.0.1:3080';
  const range = options.range || DEFAULT_PORTS;
  const probeFn = options.probeFn || ((u: string) => probe(u, { marker: options.marker }));
  const log = options.log || ((_l: string, _m: string) => {});

  if (await probeFn(preferred)) {
    return { url: preferred, detected: true, reason: 'preferred reachable' };
  }
  for (let port = range[0]; port <= range[1]; port++) {
    const url = 'http://127.0.0.1:' + port;
    if (url === preferred) continue;
    if (await probeFn(url)) {
      log('info', '自动检测到 harness: ' + url);
      return { url, detected: true, reason: 'scanned port ' + port };
    }
  }
  log('warn', '未检测到 harness（' + range[0] + '-' + range[1] + '），回退 ' + preferred);
  return { url: preferred, detected: false, reason: 'no reachable harness' };
}
