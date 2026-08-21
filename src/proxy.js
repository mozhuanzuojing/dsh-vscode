'use strict';
/**
 * 本地反向代理（纯 Node，可独立测试）：
 *  - HTTP 转发：把 iframe（随机环回端口）的请求原样转发到 DSH harness，
 *    并将 Host / Origin / Referer 统一改写为 harness 自身 origin（通过 /api 浏览器信任围栏）。
 *  - openPath 拦截：POST /api/host.openPath 不再转发，转成宿主回调（vscode.open），
 *    按 harness 契约返回 { ok: true, value: { opened: true } }。
 *  - pickDirectory 拦截：POST /api/host.pickDirectory 转成宿主回调（vscode 原生目录选择器，
 *    Cursor 同款体验），选中回 { ok: true, value: { path } }，取消回 { path: null }
 *    （与 harness 原生对话框行为一致）。
 *  - WebSocket 透传：/api/events.mux、/api/events.host 等下行流双向转发（同样改写 Origin/Host）。
 */
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

const DEFAULT_BASE_URL = 'http://127.0.0.1:3082';
const OPEN_PATH_RE = /^\/api\/host\.openPath$/;
const PICK_DIRECTORY_RE = /^\/api\/host\.pickDirectory$/;
const SESSION_PROMPT_RE = /^\/api\/session\.prompt$/;

/** 逐跳头（不得原样转发）；host/origin/referer 由代理统一改写。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'origin',
  'referer',
]);

/** 过滤转发头：去掉逐跳头与 proxy-* 前缀头。 */
function filterForwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name)) continue;
    if (name.startsWith('proxy-')) continue;
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function createProxy(options = {}) {
  const baseUrl = new URL(options.baseUrl || DEFAULT_BASE_URL);
  const onOpenPath = options.onOpenPath || (async () => { throw new Error('未配置 onOpenPath 处理函数'); });
  // 目录选择回调：resolve 为选中目录路径（string），或 null（用户取消）。
  // harness 以 "caller-signal-only" 调用（无默认超时），拦截器可挂起等用户操作完对话框。
  const onPickDirectory = options.onPickDirectory || (async () => { throw new Error('未配置 onPickDirectory 处理函数'); });
  // 降级开关：false 时不拦截，host.pickDirectory 原样转发给 harness 宿主（跨机拓扑逃生通道）。
  const interceptPickDirectory = options.interceptPickDirectory !== false;
  // 编辑器上下文共享对象：extension 侧实时更新 { block }，这里在 session.prompt 时前缀注入
  const editorContext = options.editorContext || { block: '' };
  const logger = options.logger || ((_level, _msg) => {});

  const stats = {
    httpRequests: 0,
    openPathCalls: 0,
    pickDirectoryCalls: 0,
    wsConnections: 0,
    wsFailures: 0,
    errors: 0,
    interceptedPaths: [],
    pickedPaths: [],
  };

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      stats.errors += 1;
      logger('error', `请求失败 ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      try {
        res.end(JSON.stringify({
          ok: false,
          error: { code: 'proxy-error', message: err.message, details: {} },
        }));
      } catch { /* socket 已断 */ }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));
  server.on('clientError', (_err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* noop */ }
  });

  async function handleHttp(req, res) {
    stats.httpRequests += 1;
    const target = new URL(req.url, baseUrl);

    // ── 拦截 host.openPath / host.pickDirectory（harness 契约：client-request 信封 → server-response 信封）──
    if (req.method === 'POST' && OPEN_PATH_RE.test(target.pathname)) {
      await interceptOpenPath(req, res);
      return;
    }
    if (req.method === 'POST' && PICK_DIRECTORY_RE.test(target.pathname) && interceptPickDirectory) {
      await handlePickDirectory(req, res);
      return;
    }
    // 编辑器联动：session.prompt 前缀注入当前文件/选区上下文（①③④ 的共用 seam）
    if (req.method === 'POST' && SESSION_PROMPT_RE.test(target.pathname)) {
      await forwardSessionPrompt(req, res, target);
      return;
    }

    const headers = filterForwardHeaders(req.headers);
    // 同源过围栏：一律改写为 harness 自身 origin
    headers.host = baseUrl.host;
    headers.origin = baseUrl.origin;
    headers.referer = baseUrl.origin + '/';

    // 记录最近会话（供选区命令直接发起 prompt）
    if (req.method === 'POST' && /^\/api\/session\./.test(target.pathname)) {
      trackSessionIdFromRequest(req, target.pathname);
    }
    const upstream = http.request({
      protocol: baseUrl.protocol,
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers,
    }, (upRes) => {
      // 响应头同样过滤逐跳/代理头，避免 connection/transfer-encoding 与 Node 自身帧管理冲突
      res.writeHead(upRes.statusCode || 502, filterForwardHeaders(upRes.headers));
      upRes.pipe(res);
    });

    upstream.on('error', (err) => {
      stats.errors += 1;
      logger('error', `上游 ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`proxy: 上游错误 ${err.message}`);
      } else {
        res.destroy();
      }
    });

    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  async function interceptOpenPath(req, res) {
    stats.openPathCalls += 1;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let envelope = {};
    try { envelope = JSON.parse(raw || '{}'); } catch { envelope = {}; }
    const payload = (envelope && typeof envelope === 'object' && 'payload' in envelope) ? envelope.payload : envelope;
    const rpcId = envelope && typeof envelope === 'object' && typeof envelope.rpcId === 'string' ? envelope.rpcId : '';
    const filePath = payload && typeof payload === 'object' ? payload.path : undefined;

    let result;
    if (typeof filePath === 'string' && filePath.length > 0) {
      stats.interceptedPaths.push(filePath);
      logger('info', `openPath ${rpcId || '-'} -> ${filePath}`);
      try {
        await onOpenPath(filePath);
        result = { ok: true, value: { opened: true } };
      } catch (err) {
        result = { ok: false, error: { code: 'bad-request', message: `vscode.open 失败: ${err.message}`, details: {} } };
      }
    } else {
      result = { ok: false, error: { code: 'bad-request', message: 'openPath 需要 string 类型的 payload.path', details: {} } };
    }

    sendJson(res, 200, { type: 'server-response', rpcId, result });
  }

  /** 目录选择拦截：不转发 harness，弹 VSCode 原生目录选择器（Cursor 同款体验）。 */
  async function handlePickDirectory(req, res) {
    stats.pickDirectoryCalls += 1;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let envelope = {};
    try { envelope = JSON.parse(raw || '{}'); } catch { envelope = {}; }
    const rpcId = envelope && typeof envelope === 'object' && typeof envelope.rpcId === 'string' ? envelope.rpcId : '';
    logger('info', `pickDirectory ${rpcId || '-'}`);

    let result;
    try {
      const path = await onPickDirectory(); // string（选中） | null（取消）
      if (path !== null && path !== undefined) stats.pickedPaths.push(path);
      result = { ok: true, value: { path: path ?? null } };
    } catch (err) {
      stats.errors += 1;
      logger('error', `pickDirectory 失败: ${err.message}`);
      result = {
        ok: false,
        error: { code: 'directory-picker-unavailable', message: `vscode 目录选择失败: ${err.message}`, details: { capability: 'vscode' } },
      };
    }
    sendJson(res, 200, { type: 'server-response', rpcId, result });
  }

  /** 安全回包：客户端已断（iframe 刷新/关闭）时不写坏 socket。 */
  function sendJson(res, status, obj) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(obj);
    try {
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    } catch { /* socket 已断 */ }
  }

  /** 从会话 RPC 的 body 里读取 sessionId，记录为最近会话（供选区命令直接发起 prompt）。 */
  function trackSessionIdFromRequest(req, _pathname) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const sid = envelope && envelope.payload && typeof envelope.payload.sessionId === 'string' ? envelope.payload.sessionId : '';
        if (sid) { proxy.lastSessionId = sid; }
      } catch { /* body 非 JSON，忽略 */ }
    });
  }

  /** session.prompt 转发：读 body，若编辑器上下文非空则前缀注入一条 text part，再转发。 */
  async function forwardSessionPrompt(req, res, target) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let envelope = {};
    try { envelope = JSON.parse(raw || '{}'); } catch { envelope = {}; }
    // 记录 sessionId
    if (envelope && envelope.payload && typeof envelope.payload.sessionId === 'string') {
      proxy.lastSessionId = envelope.payload.sessionId;
    }
    // 编辑器上下文注入（不污染用户意图：块状包裹，格式清晰）
    const block = editorContext && editorContext.block;
    if (block && envelope && Array.isArray(envelope.payload && envelope.payload.content)) {
      envelope.payload.content.unshift({ type: 'text', text: block });
      raw = JSON.stringify(envelope);
      logger('info', '已注入编辑器上下文到 session.prompt');
    }
    // 转发到上游
    const headers = filterForwardHeaders(req.headers);
    headers.host = baseUrl.host;
    headers.origin = baseUrl.origin;
    headers.referer = baseUrl.origin + '/';
    // content-length 按新 body 重算（去掉旧值，让 Node 重设）
    delete headers['content-length'];
    const body = Buffer.from(raw, 'utf8');
    const upstream = http.request({
      protocol: baseUrl.protocol,
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      method: 'POST',
      path: target.pathname + target.search,
      headers: { ...headers, 'content-length': String(body.length) },
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, filterForwardHeaders(upRes.headers));
      upRes.pipe(res);
    });
    upstream.on('error', (err) => {
      stats.errors += 1;
      logger('error', `session.prompt 上游失败: ${err.message}`);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('proxy: 上游错误'); }
      else res.destroy();
    });
    upstream.end(body);
  }

  function handleUpgrade(req, socket, head) {
    const target = new URL(req.url, baseUrl);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    logger('info', `WS 透传 ${req.url}`);

    const upstream = new WebSocket(target.toString(), {
      headers: {
        host: baseUrl.host,
        origin: baseUrl.origin,
        ...(req.headers['sec-websocket-protocol']
          ? { 'sec-websocket-protocol': req.headers['sec-websocket-protocol'] }
          : {}),
      },
      handshakeTimeout: 5000,
    });

    let settled = false;
    let clientWs = null;

    /** 拒绝/关闭客户端升级 socket（握手失败或客户端升级异常时用，避免客户端悬挂）。 */
    function rejectClientSocket(reason) {
      try {
        socket.write(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nproxy: WebSocket 握手失败 - ${reason}`);
        socket.destroy();
      } catch { /* noop */ }
    }

    // CRITICAL: 必须在 open 之前挂 error 监听——否则上游握手失败（连接拒绝/超时/非 101）
    // 会以无监听器的 'error' 事件炸掉扩展宿主进程。
    upstream.on('error', (err) => {
      logger('error', `WS 上游 ${req.url}: ${err.message}`);
      if (!settled) {
        stats.wsFailures += 1;
        rejectClientSocket(err.message);
      }
    });
    // ws 库在收到非 101 响应时发 'unexpected-response'（例如上游 403）。
    upstream.on('unexpected-response', (_uReq, uRes) => {
      stats.wsFailures += 1;
      const status = uRes && uRes.statusCode ? uRes.statusCode : '?';
      logger('error', `WS 上游非预期响应 ${req.url}: HTTP ${status}`);
      if (!settled) rejectClientSocket(`upstream HTTP ${status}`);
    });

    upstream.once('open', () => {
      settled = true;
      stats.wsConnections += 1;
      try {
        wss.handleUpgrade(req, socket, head, (ws) => { clientWs = ws; });
      } catch (err) {
        stats.wsFailures += 1;
        logger('error', `WS 客户端升级失败 ${req.url}: ${err.message}`);
        try { upstream.close(); } catch { /* noop */ }
        return;
      }
      if (!clientWs) {
        try { upstream.close(); } catch { /* noop */ }
        return;
      }
      clientWs.on('message', (data, isBinary) => {
        try { upstream.send(data, { binary: isBinary }); } catch { /* closed */ }
      });
      upstream.on('message', (data, isBinary) => {
        try { clientWs.send(data, { binary: isBinary }); } catch { /* closed */ }
      });
      clientWs.on('close', () => { try { upstream.close(); } catch { /* noop */ } });
      upstream.on('close', () => { try { clientWs.close(); } catch { /* noop */ } });
      clientWs.on('error', () => { try { upstream.close(); } catch { /* noop */ } });
      upstream.on('error', (err) => {
        stats.wsFailures += 1;
        logger('error', `WS 上游 ${req.url}: ${err.message}`);
        try { clientWs.close(); } catch { /* noop */ }
      });
    });

    socket.on('error', () => { try { upstream.close(); } catch { /* noop */ } });
    socket.on('close', () => {
      if (!settled) { try { upstream.close(); } catch { /* noop */ } }
    });
  }

  const proxy = {
    server,
    wss,
    stats,
    baseUrl: baseUrl.toString(),
    interceptPickDirectory,
    origin: '',
    port: 0,
    lastSessionId: '',

    start() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          proxy.port = server.address().port;
          proxy.origin = `http://127.0.0.1:${proxy.port}`;
          logger('info', `代理就绪 ${proxy.origin} -> ${baseUrl}`);
          resolve(proxy);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });
    },

    close() {
      return new Promise((resolve) => {
        for (const client of wss.clients) {
          try { client.terminate(); } catch { /* noop */ }
        }
        wss.close(() => {
          server.close(() => resolve());
          setTimeout(() => resolve(), 2000).unref?.();
        });
      });
    },
  };

  return proxy;
}

module.exports = { createProxy, DEFAULT_BASE_URL, OPEN_PATH_RE, PICK_DIRECTORY_RE };
