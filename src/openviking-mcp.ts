/**
 * 最小 OpenViking MCP 客户端（streamable-http，无第三方依赖，Node fetch）。
 * 只做两件事：initialize（含 notifications/initialized）+ tools/call find。
 * 服务器不可达/协议异常 → 返回空串（调用方注入时跳过，绝不影响消息发送）。
 */
interface McpResponse { result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } }

async function mcpPost(url: string, body: unknown): Promise<McpResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!text.trim()) return {};
  const datas = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  return datas.length ? (JSON.parse(datas[datas.length - 1]) as McpResponse) : (JSON.parse(text) as McpResponse);
}

export async function mcpFind(url: string, query: string, limit = 3): Promise<string> {
  try {
    await mcpPost(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-vscode', version: '0.7.3' } } });
    await mcpPost(url, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const r = await mcpPost(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find', arguments: { query, limit } } });
    const c = r.result && r.result.content;
    if (!Array.isArray(c)) return '';
    const text = c.map((x) => x.text || '').join('\n').trim();
    return text ? '[Repo Recall]\n' + text.slice(0, 2000) + '\n[/Repo Recall]\n' : '';
  } catch {
    return '';
  }
}
