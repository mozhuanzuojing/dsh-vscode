import http from 'node:http';
import { WebSocket, WebSocketServer, RawData } from 'ws';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3082';
const OPEN_PATH_RE = /^\/api\/host\.openPath$/;
const PICK_DIRECTORY_RE = /^\/api\/host\.pickDirectory$/;
const SESSION_PROMPT_RE = /^\/api\/session\.prompt$/;

/** 逐跳头（不得原样转发）；host/origin/referer 由代理统一改写。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'origin', 'referer',
]);

function filterForwardHeaders(headers: http.IncomingHttpHeaders): Record<string, string | number | string[]> {
  const out: Record<string, string | number | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name)) continue;
    if (name.startsWith('proxy-')) continue;
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export interface ProxyOptions {
  baseUrl?: string;
  onOpenPath?: (path: string) => Promise<void>;
  onPickDirectory?: () => Promise<string | null>;
  interceptPickDirectory?: boolean;
  editorContext?: { block: string; recall?: () => Promise<string> };
  onSessionPrompt?: () => void;
  onMuxFrame?: (frame: { type: string; payload?: unknown; rpcId?: string }) => void;
  logger?: (level: string, msg: string) => void;
}
export interface ProxyStats {
  httpRequests: number; openPathCalls: number; pickDirectoryCalls: number;
  wsConnections: number; wsFailures: number; errors: number;
  interceptedPaths: string[]; pickedPaths: string[];
}
export interface ProxyHandle {
  server: http.Server; wss: WebSocketServer; stats: ProxyStats;
  baseUrl: string; interceptPickDirectory: boolean;
  origin: string; port: number; lastSessionId: string;
  requestedBaseUrl?: string; probeRange?: number[]; detectedBaseUrl?: boolean; detectedReason?: string;
  start(): Promise<ProxyHandle>; close(): Promise<void>;
}

export function createProxy(options: ProxyOptions = {}): ProxyHandle {
  const baseUrl = new URL(options.baseUrl || DEFAULT_BASE_URL);
  const onOpenPath = options.onOpenPath || (async () => { throw new Error('未配置 onOpenPath 处理函数'); });
  const onPickDirectory = options.onPickDirectory || (async () => { throw new Error('未配置 onPickDirectory 处理函数'); });
  const interceptPickDirectory = options.interceptPickDirectory !== false;
  const editorContext = options.editorContext || { block: '' };
  const onSessionPrompt = options.onSessionPrompt || (() => {});
  const onMuxFrame = options.onMuxFrame || (() => {});
  const logger = options.logger || ((_level: string, _msg: string) => {});

  const stats: ProxyStats = {
    httpRequests: 0, openPathCalls: 0, pickDirectoryCalls: 0,
    wsConnections: 0, wsFailures: 0, errors: 0, interceptedPaths: [], pickedPaths: [],
  };

  const proxy = {
    server: null as unknown as http.Server, wss: null as unknown as WebSocketServer, stats,
    baseUrl: baseUrl.toString(), interceptPickDirectory, origin: '', port: 0, lastSessionId: '',
    start() { return Promise.resolve(proxy as unknown as ProxyHandle); },
    close() { return Promise.resolve(); },
  };

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((err: Error) => {
      stats.errors += 1; logger('error', '请求失败 ' + req.method + ' ' + req.url + ': ' + err.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      try { res.end(JSON.stringify({ ok: false, error: { code: 'proxy-error', message: err.message, details: {} } })); }
      catch { /* socket 已断 */ }
    });
  });
  (proxy as any).server = server;

  const wss = new WebSocketServer({ noServer: true });
  (proxy as any).wss = wss;
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));
  server.on('clientError', (_err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* noop */ } });

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    stats.httpRequests += 1;
    const target = new URL(req.url || '/', baseUrl);
    if (req.method === 'POST' && OPEN_PATH_RE.test(target.pathname)) { await interceptOpenPath(req, res); return; }
    if (req.method === 'POST' && PICK_DIRECTORY_RE.test(target.pathname) && interceptPickDirectory) { await handlePickDirectory(req, res); return; }
    if (req.method === 'POST' && SESSION_PROMPT_RE.test(target.pathname)) { await forwardSessionPrompt(req, res, target); return; }

    const headers = filterForwardHeaders(req.headers);
    headers.host = baseUrl.host;
    headers.origin = baseUrl.origin;
    headers.referer = baseUrl.origin + '/';

    if (req.method === 'POST' && /^\/api\/session\./.test(target.pathname)) trackSessionIdFromRequest(req);

    const upstream = http.request({
      protocol: baseUrl.protocol, hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      method: req.method, path: target.pathname + target.search, headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, filterForwardHeaders(upRes.headers));
      upRes.pipe(res);
    });
    upstream.on('error', (err: Error) => {
      stats.errors += 1; logger('error', '上游 ' + req.method + ' ' + req.url + ': ' + err.message);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('proxy: 上游错误 ' + err.message); }
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  async function interceptOpenPath(req: http.IncomingMessage, res: http.ServerResponse) {
    stats.openPathCalls += 1;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let envelope: any = {};
    try { envelope = JSON.parse(raw || '{}'); } catch { envelope = {}; }
    const payload = (envelope && typeof envelope === 'object' && 'payload' in envelope) ? envelope.payload : envelope;
    const rpcId = envelope && typeof envelope === 'object' && typeof envelope.rpcId === 'string' ? envelope.rpcId : '';
    const filePath = payload && typeof payload === 'object' ? payload.path : undefined;
    let result: any;
    if (typeof filePath === 'string' && filePath.length > 0) {
      stats.interceptedPaths.push(filePath); logger('info', 'openPath ' + (rpcId || '-') + ' -> ' + filePath);
      try { await onOpenPath(filePath); result = { ok: true, value: { opened: true } }; }
      catch (err) { result = { ok: false, error: { code: 'bad-request', message: 'vscode.open 失败: ' + String((err as Error).message), details: {} } }; }
    } else { result = { ok: false, error: { code: 'bad-request', message: 'openPath 需要 string 类型的 payload.path', details: {} } }; }
    sendJson(res, 200, { type: 'server-response', rpcId, result });
  }

  async function handlePickDirectory(req: http.IncomingMessage, res: http.ServerResponse) {
    stats.pickDirectoryCalls += 1;
    let raw = ''; for await (const chunk of req) raw += chunk;
    let envelope: any = {}; try { envelope = JSON.parse(raw || '{}'); } catch { envelope = {}; }
    const rpcId = envelope && typeof envelope === 'object' && typeof envelope.rpcId === 'string' ? envelope.rpcId : '';
    logger('info', 'pickDirectory ' + (rpcId || '-'));
    let result: any;
    try {
      const path = await onPickDirectory();
      if (path !== null && path !== undefined) stats.pickedPaths.push(path);
      result = { ok: true, value: { path: path ?? null } };
    } catch (err) {
      stats.errors += 1;
      result = { ok: false, error: { code: 'directory-picker-unavailable', message: 'vscode 目录选择失败: ' + String((err as Error).message), details: { capability: 'vscode' } } };
    }
    sendJson(res, 200, { type: 'server-response', rpcId, result });
  }

  function sendJson(res: http.ServerResponse, status: number, obj: unknown) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(obj);
    try { res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); res.end(body); }
    catch { /* socket 已断 */ }
  }

  function trackSessionIdFromRequest(req: http.IncomingMessage) {
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { try { const env = JSON.parse(Buffer.concat(chunks).toString('utf8')); const sid = env && env.payload && typeof env.payload.sessionId === 'string' ? env.payload.sessionId : ''; if (sid) proxy.lastSessionId = sid; } catch { /* body 非 JSON */ } });
  }

  async function forwardSessionPrompt(req: http.IncomingMessage, res: http.ServerResponse, target: URL) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let envelope: any = {}; try { envelope = JSON.parse(raw || '{}'); } catch { envelope = {}; }
    if (envelope && envelope.payload && typeof envelope.payload.sessionId === 'string') proxy.lastSessionId = envelope.payload.sessionId;
    onSessionPrompt();
    let block = editorContext && editorContext.block;
    if (editorContext && editorContext.recall) {
      try {
        const recall = await Promise.race([editorContext.recall(), new Promise<string>((resolve) => setTimeout(() => resolve(''), 3000))]);
        if (recall) block = (block || '') + recall;
      } catch { /* recall 失败忽略 */ }
    }
    if (block && envelope && Array.isArray(envelope.payload && envelope.payload.content)) {
      envelope.payload.content.unshift({ type: 'text', text: block });
      raw = JSON.stringify(envelope); logger('info', '已注入编辑器上下文到 session.prompt');
    }
    const headers = filterForwardHeaders(req.headers);
    headers.host = baseUrl.host; headers.origin = baseUrl.origin; headers.referer = baseUrl.origin + '/';
    delete headers['content-length'];
    const body = Buffer.from(raw, 'utf8');
    const upstream = http.request({
      protocol: baseUrl.protocol, hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      method: 'POST', path: target.pathname + target.search,
      headers: { ...headers, 'content-length': String(body.length) },
    }, (upRes) => { res.writeHead(upRes.statusCode || 502, filterForwardHeaders(upRes.headers)); upRes.pipe(res); });
    upstream.on('error', (err: Error) => { stats.errors += 1; logger('error', 'session.prompt 上游失败: ' + err.message); if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('proxy: 上游错误'); } else res.destroy(); });
    upstream.end(body);
  }

  function handleUpgrade(req: http.IncomingMessage, socket: any, head: Buffer) {
    const target = new URL(req.url || '/', baseUrl);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const isMux = /\/api\/events\.mux/.test(req.url || '');
    logger('info', 'WS 透传 ' + req.url);
    const upstream = new WebSocket(target.toString(), {
      headers: { host: baseUrl.host, origin: baseUrl.origin, ...(req.headers['sec-websocket-protocol'] ? { 'sec-websocket-protocol': req.headers['sec-websocket-protocol'] as string } : {}) },
      handshakeTimeout: 5000,
    });
    let settled = false; let clientWs: WebSocket | null = null;
    function rejectClientSocket(reason: string) { try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nproxy: WebSocket 握手失败 - ' + reason); socket.destroy(); } catch { /* noop */ } }
    upstream.on('error', (err) => { logger('error', 'WS 上游 ' + req.url + ': ' + err.message); if (!settled) { stats.wsFailures += 1; rejectClientSocket(err.message); } });
    upstream.on('unexpected-response', (_uReq: unknown, uRes: { statusCode?: number }) => { const status = uRes.statusCode ?? '?'; logger('error', 'WS 上游非预期响应 ' + req.url + ': HTTP ' + status); if (!settled) { stats.wsFailures += 1; rejectClientSocket('upstream HTTP ' + status); } });
    upstream.once('open', () => {
      settled = true; stats.wsConnections += 1;
      try { wss.handleUpgrade(req, socket, head, (ws: WebSocket) => { clientWs = ws; }); }
      catch (err) { stats.wsFailures += 1; logger('error', 'WS 客户端升级失败 ' + req.url + ': ' + (err as Error).message); try { upstream.close(); } catch { /* noop */ } try { socket.destroy(); } catch { /* noop */ } return; }
      if (!clientWs) { try { upstream.close(); } catch { /* noop */ } try { socket.destroy(); } catch { /* noop */ } return; }
      clientWs.on('message', (data: RawData, isBinary: boolean) => { try { upstream.send(data, { binary: isBinary }); } catch { /* closed */ } });
      upstream.on('message', (data: RawData, isBinary: boolean) => {
        // 共享底座：tap mux 下行帧，把事件信号转给扩展（回合状态/工具/审批/问题）
        if (isMux && !isBinary) {
          try {
            const str = typeof data === 'string' ? data : data.toString();
            const f = JSON.parse(str);
            if (f && f.type === 'server-request' && typeof f.method === 'string') onMuxFrame({ type: f.method, payload: f.payload, rpcId: f.rpcId });
          } catch { /* 非 JSON 帧，忽略 */ }
        }
        try { clientWs!.send(data, { binary: isBinary }); } catch { /* closed */ }
      });
      clientWs.on('close', () => { try { upstream.close(); } catch { /* noop */ } });
      upstream.on('close', () => { try { clientWs!.close(); } catch { /* noop */ } });
      clientWs.on('error', () => { try { upstream.close(); } catch { /* noop */ } });
      upstream.on('error', (err) => { stats.wsFailures += 1; logger('error', 'WS 上游 ' + req.url + ': ' + err.message); try { clientWs!.close(); } catch { /* noop */ } });
    });
    socket.on('error', () => { try { upstream.close(); } catch { /* noop */ } });
    socket.on('close', () => { if (!settled) { try { upstream.close(); } catch { /* noop */ } } });
  }

  proxy.start = () => new Promise((resolve, reject) => {
    const onError = (err: Error) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); proxy.port = (server.address() as { port: number }).port; proxy.origin = 'http://127.0.0.1:' + proxy.port; logger('info', '代理就绪 ' + proxy.origin + ' -> ' + baseUrl); resolve(proxy as unknown as ProxyHandle); };
    server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
  });
  proxy.close = () => new Promise((resolve) => {
    for (const client of wss.clients) { try { client.terminate(); } catch { /* noop */ } }
    wss.close(() => { server.close(() => resolve()); setTimeout(() => resolve(), 2000).unref?.(); });
  });

  return proxy as unknown as ProxyHandle;
}
