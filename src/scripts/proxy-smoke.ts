// @ts-nocheck
/**
 * 代理冒烟：对运行中的 harness 验证
 *   ① HTTP 转发       ② 真实 RPC 转发 + 恶意 Origin 改写过围栏
 *   ③ openPath 拦截   ④ pickDirectory 拦截（选中/取消）
 *   ⑤ WebSocket 透传（events.host）
 *   ⑥ pickDirectory 降级开关（mock 上游：关闭=转发，开启=拦截）
 * 用法: node scripts/proxy-smoke.cjs [baseUrl]   （env DSH_BASE_URL 亦可）
 */
import * as http from 'node:http';
import { WebSocket } from 'ws';
import { createProxy } from '../proxy';

const BASE = process.env.DSH_BASE_URL || process.argv[2] || 'http://127.0.0.1:3082';
const opened = [];
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  let picked = '/home/g/project/dsh1';
  const proxy = await createProxy({
    baseUrl: BASE,
    onOpenPath: async (p) => { opened.push(p); },
    onPickDirectory: async () => picked,
  }).start();
  console.log(`代理: ${proxy.origin} -> ${BASE}\n`);

  // 1. HTTP 转发：根页面
  try {
    const res = await fetch(proxy.origin + '/');
    const text = await res.text();
    check('HTTP 转发 GET /', res.status === 200 && text.includes('__DSH_BOOT__'), `HTTP ${res.status}`);
  } catch (err) {
    check('HTTP 转发 GET /', false, err.message);
  }

  // 2. 真实 RPC 转发 + 恶意 Origin 改写过围栏（harness 自身收 403 的场景）
  try {
    const res = await fetch(proxy.origin + '/api/session.list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.example',
        referer: 'http://evil.example/',
      },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-list', method: 'session.list', payload: {} }),
    });
    const env = await res.json();
    check(
      'RPC 转发 + Origin 改写',
      res.status === 200 && env.type === 'server-response' && env.rpcId === 'smoke-list',
      `HTTP ${res.status}`
    );
  } catch (err) {
    check('RPC 转发 + Origin 改写', false, err.message);
  }

  // 3. openPath 拦截（不回源，本地应答 harness 契约）
  try {
    const res = await fetch(proxy.origin + '/api/host.openPath', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'smoke-open',
        method: 'host.openPath',
        payload: { path: '/tmp/dsh-smoke.txt' },
      }),
    });
    const env = await res.json();
    check(
      'openPath 拦截',
      res.status === 200 &&
        env.result && env.result.ok === true &&
        env.result.value && env.result.value.opened === true &&
        opened.length === 1 && opened[0] === '/tmp/dsh-smoke.txt',
      JSON.stringify(env.result || env)
    );
  } catch (err) {
    check('openPath 拦截', false, err.message);
  }

  // 4. pickDirectory 拦截：选中（回 path）
  try {
    picked = '/home/g/project/dsh1';
    const res = await fetch(proxy.origin + '/api/host.pickDirectory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-pick-1', method: 'host.pickDirectory', payload: {} }),
    });
    const env = await res.json();
    check(
      'pickDirectory 拦截（选中）',
      res.status === 200 &&
        env.result && env.result.ok === true &&
        env.result.value && env.result.value.path === '/home/g/project/dsh1',
      JSON.stringify(env.result || env)
    );
  } catch (err) {
    check('pickDirectory 拦截（选中）', false, err.message);
  }

  // 4b. pickDirectory 拦截：取消（回 path:null，与 harness 原生行为一致）
  try {
    picked = null;
    const res = await fetch(proxy.origin + '/api/host.pickDirectory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-pick-2', method: 'host.pickDirectory', payload: {} }),
    });
    const env = await res.json();
    check(
      'pickDirectory 拦截（取消）',
      res.status === 200 && env.result && env.result.ok === true && env.result.value && env.result.value.path === null,
      JSON.stringify(env.result || env)
    );
  } catch (err) {
    check('pickDirectory 拦截（取消）', false, err.message);
  }

  // 5. WS 透传（events.host；恶意 Origin 也应被改写后放行）
  await new Promise((resolve) => {
    const url = proxy.origin.replace(/^http/, 'ws') + '/api/events.host';
    const ws = new WebSocket(url, { headers: { origin: 'http://evil.example' } });
    let frames = 0;
    let finished = false;
    const finish = (ok, detail) => {
      if (finished) return;
      finished = true;
      check('WS 透传 events.host', ok, detail);
      resolve();
    };
    const timer = setTimeout(() => finish(true, `连接保持 1.2s，${frames} 帧`), 1200);
    ws.on('open', () => console.log('      WS events.host 已连接'));
    ws.on('message', () => { frames += 1; });
    ws.on('close', () => {
      clearTimeout(timer);
      finish(true, `连接已关闭，${frames} 帧`);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      finish(false, err.message);
    });
  });

  // 6. 降级开关（mock 上游，避免在真实 harness 上弹原生对话框）
  await (async () => {
    let forwardedHits = 0;
    const mock = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/host.pickDirectory') {
        forwardedHits += 1;
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let env = {};
          try { env = JSON.parse(raw || '{}'); } catch { /* noop */ }
          const body = JSON.stringify({
            type: 'server-response',
            rpcId: env.rpcId || '',
            result: { ok: true, value: { path: '/mock/forwarded' } },
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(body);
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('mock');
    });
    await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const mockBase = `http://127.0.0.1:${mock.address().port}`;

    // 关闭拦截：host.pickDirectory 应原样转发到上游
    const off = await createProxy({
      baseUrl: mockBase,
      interceptPickDirectory: false,
      onOpenPath: async () => {},
      onPickDirectory: async () => '/should-not-be-used',
    }).start();
    try {
      const res = await fetch(off.origin + '/api/host.pickDirectory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-fwd', method: 'host.pickDirectory', payload: {} }),
      });
      const env = await res.json();
      check(
        'pickDirectory 降级开关=关 → 转发上游',
        forwardedHits === 1 && env.result && env.result.ok === true && env.result.value.path === '/mock/forwarded',
        `hits=${forwardedHits}`
      );
    } catch (err) {
      check('pickDirectory 降级开关=关 → 转发上游', false, err.message);
    }
    await off.close();

    // 开启拦截：本地应答，上游不再收到请求
    const on2 = await createProxy({
      baseUrl: mockBase,
      interceptPickDirectory: true,
      onOpenPath: async () => {},
      onPickDirectory: async () => '/intercepted',
    }).start();
    try {
      const res = await fetch(on2.origin + '/api/host.pickDirectory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-int', method: 'host.pickDirectory', payload: {} }),
      });
      const env = await res.json();
      check(
        'pickDirectory 降级开关=开 → 本地拦截',
        forwardedHits === 1 && env.result && env.result.ok === true && env.result.value.path === '/intercepted',
        `hits=${forwardedHits}`
      );
    } catch (err) {
      check('pickDirectory 降级开关=开 → 本地拦截', false, err.message);
    }
    await on2.close();

    await new Promise((resolve) => mock.close(resolve));
  })();

  await proxy.close();
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('冒烟失败:', err); process.exit(1); });
