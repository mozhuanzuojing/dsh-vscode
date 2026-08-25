/**
 * 最小 OpenViking MCP 客户端（streamable-http，无第三方依赖，Node fetch）。
 * 只做两件事：initialize（含 notifications/initialized，带会话缓存）+ tools/call find。
 * 约定：mcpFind 返回 { ok: boolean; text: string } —— ok=false 表示传输/协议失败（调用方据此告警），
 *       ok=true 但 text='' 表示服务器可达但无匹配结果（不告警、不注入）。
 */
export interface McpFindResult { ok: boolean; text: string; }

interface McpResponse { result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } }

let sessionId = '';
let initialized = false;

async function mcpPost(url: string, body: unknown, signal: AbortSignal): Promise<McpResponse> {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!text.trim()) return {};
  const datas = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  if (datas.length) return JSON.parse(datas[datas.length - 1]) as McpResponse;
  return JSON.parse(text) as McpResponse;
}

/** 单次召回：总超时 3s（AbortController 真正中止 fetch），返回 { ok, text }。 */
export async function mcpFind(url: string, query: string, limit = 3): Promise<McpFindResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try {
    if (!initialized) {
      await mcpPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-awakening', version: '0.7.6' } } }, ac.signal);
      await mcpPost(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, ac.signal);
      initialized = true;
    }
    const r = await mcpPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find', arguments: { query, limit } } }, ac.signal);
    if (r.error) return { ok: true, text: '' };
    if (r.result && r.result.isError) return { ok: true, text: '' };
    const c = r.result && r.result.content;
    const text = Array.isArray(c) ? c.map((x) => x.text || '').join('\n').trim() : '';
    return { ok: true, text: text ? '[Repo Recall]\n' + text.slice(0, 2000) + '\n[/Repo Recall]\n' : '' };
  } catch {
    return { ok: false, text: '' };
  } finally {
    clearTimeout(timer);
  }
}
