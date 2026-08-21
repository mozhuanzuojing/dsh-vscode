export const HARNESS_BOOT_MARKER = '__DSH_BOOT__';
export const DEFAULT_PORTS: readonly [number, number] = [3080, 3099]; // 含 dsh 默认 3082

export interface ProbeOptions { timeoutMs?: number; marker?: string; }
export async function probe(url: string, options: ProbeOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const marker = options.marker ?? HARNESS_BOOT_MARKER;
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

export interface DetectOptions {
  preferred?: string;
  range?: readonly [number, number] | readonly number[];
  marker?: string;
  probeFn?: (url: string) => Promise<boolean>;
  log?: (level: string, msg: string) => void;
}
export interface DetectResult { url: string; detected: boolean; reason: string; }

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
