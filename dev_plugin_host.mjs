#!/usr/bin/env node
/**
 * 外部插件托管服务器（开发 / 真机验收用，**不是产品代码**）。
 *
 * 用途：把 `dev_plugin_sample.mjs` 当**一个外部插件包**发出去，用来验证阶段 7 的装载链路。
 * 顺带演示「插件源」必须满足的唯一硬要求：**带 CORS 头**（跨源下载需要它，否则浏览器直接拒）。
 *
 * 用法：
 *   node dev_plugin_host.mjs            # 默认 8793
 *   PORT=8899 node dev_plugin_host.mjs
 * 然后在苍玄助手「设置 · 能力 · 插件 · 外部插件」里填：http://127.0.0.1:8793/sample-plugin.js
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8793);
const here = dirname(fileURLToPath(import.meta.url));

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const url = req.url || '/';
  if (url.startsWith('/sample-plugin.js')) {
    const code = readFileSync(join(here, 'dev_plugin_sample.mjs'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(code), ...cors });
    res.end(code);
    return;
  }
  if (url === '/' || url.startsWith('/index')) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ ok: true, plugin: '/sample-plugin.js' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain', ...cors });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[plugin-host] http://127.0.0.1:' + PORT + '/sample-plugin.js');
});
