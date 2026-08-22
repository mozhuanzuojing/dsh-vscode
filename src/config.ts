export const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';
export const DEFAULT_PROBE_RANGE = [3080, 3099] as const;
export const CONFIG_NAMESPACE = 'awakening.dsh';

/** 规范化 harness 地址：trim、补 http://、URL 校验。非法返回 null。 */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let url = raw.trim();
  if (url === '') return null;
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try { return new URL(url).href; } catch { return null; }
}

/** 配置对象应提供的形状（VS Code Configuration 的子集）。 */
export interface DshConfiguration {
  get<T>(key: string, defaultValue: T): T;
  inspect(key: string): {
    globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown;
  } | undefined;
  update(key: string, value: unknown, target?: unknown): Promise<void> | Thenable<void>;
}

/** 配置读取统一走 awakening.dsh 命名空间（注入 getConfiguration 以测试）。 */
export function createConfig(getConfiguration: (ns: string) => DshConfiguration) {
  const cfg = () => getConfiguration(CONFIG_NAMESPACE);
  return {
    CONFIG_NAMESPACE,
    getBaseUrl(): string {
      return cfg().get<string>('baseUrl', DEFAULT_BASE_URL);
    },
    /** 用户是否显式配置 baseUrl（是则尊重、不做自动扫描）。 */
    isBaseUrlExplicit(): boolean {
      const inspected = cfg().inspect('baseUrl');
      return !!(inspected && (inspected.globalValue !== undefined || inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined));
    },
    /** 自动检测端口范围：非法配置回退默认。 */
    getProbeRange(): readonly number[] {
      const v = cfg().get<unknown>('probeRange', DEFAULT_PROBE_RANGE);
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && v[0] <= v[1]) return [v[0], v[1]];
      return DEFAULT_PROBE_RANGE;
    },
    shouldAutoMove(): boolean {
      return cfg().get<boolean>('autoMoveToSecondarySidebar', true);
    },
    openvikingRecallEnabled(): boolean {
      return cfg().get<boolean>('openvikingRecall', true);
    },
    pickDirectoryIntercepted(): boolean {
      return cfg().get<boolean>('interceptPickDirectory', true);
    },
    normalizeBaseUrl,
    updateBaseUrl(url: string, target: unknown): Promise<void> | Thenable<void> {
      return cfg().update('baseUrl', url, target);
    },
    /** 是否存在 workspace/workspaceFolder 层的 baseUrl 覆盖（写 Global 时可能被屏蔽）。 */
    hasScopeOverride(): boolean {
      const inspected = cfg().inspect('baseUrl');
      return !!(inspected && (inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined));
    },
  };
}

export type Config = ReturnType<typeof createConfig>;
