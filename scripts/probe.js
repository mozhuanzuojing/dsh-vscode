#!/usr/bin/env node
'use strict';
/**
 * harness 协议探针：验证根页面、RPC 信封、WebSocket 下行流。
 * 用法: node scripts/probe.js [baseUrl]    （env DSH_BASE_URL 亦可）
 */
const { WebSocket } = require('ws');

const BASE = process.env.DSH_BASE_URL || process.argv[2] || 'http://127.0.0.1:3082';

async function main() {
  console.log(`== 探针: ${BASE} ==`);

  // 1. 根页面
  const root = await fetch(BASE + '/');
  const html = await root.text();
  console.log(
    `[1] GET /            -> ${root.status} | __DSH_BOOT__=${html.includes('__DSH_BOOT__')} | title=${(html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''}`
  );

  // 2. RPC 信封（session.list 只读）
  const rpc = await fetch(BASE + '/api/session.list', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, host: new URL(BASE).host },
    body: JSON.stringify({ type: 'client-request', rpcId: 'probe-1', method: 'session.list', payload: {} }),
  });
  const envelope = await rpc.json();
  console.log(
    `[2] POST /api/session.list -> ${rpc.status} | type=${envelope.type} ok=${envelope.result && envelope.result.ok}`
  );

  // 3. WebSocket 下行流（events.host）
  await new Promise((resolve) => {
    const url = BASE.replace(/^http/, 'ws') + '/api/events.host';
    const ws = new WebSocket(url, { headers: { origin: BASE } });
    const timer = setTimeout(() => {
      console.log('[3] WS events.host -> 已连接，1s 内无帧（正常，事件驱动）');
      try { ws.close(); } catch {}
      resolve();
    }, 1000);
    ws.on('open', () => console.log('[3] WS events.host -> 已连接'));
    ws.on('message', (data) => {
      console.log(`[3] WS events.host -> 收到帧: ${String(data).slice(0, 120)}`);
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve();
    });
    ws.on('error', (err) => {
      console.log(`[3] WS events.host -> 失败: ${err.message}`);
      clearTimeout(timer);
      resolve();
    });
  });

  console.log('== 探针完成 ==');
  process.exit(0);
}

main().catch((err) => { console.error('探针失败:', err); process.exit(1); });
