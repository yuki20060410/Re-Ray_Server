// 管理画面を、偽のサーバー（js/mock.js）で開くための小さなサーバー（画面だけを試すとき）
// 使い方: リポジトリの直下で  npm run web:mock  → ブラウザで http://localhost:8080
// HTML をダブルクリックで開くと、ブラウザの決まりで JSON が読めないので、これを使う。
// 本物のサーバーにつなぐときは、これを使わず  npm run dev  → http://localhost:3000
// 2026-11-06: リポジトリの package.json が "type": "module" なので、require を import に書き直した

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.WEB_PORT) || 8080;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('見つかりません'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`管理画面（偽のサーバー）: http://localhost:${PORT}`));
