// Isolated, browser-local design fixture. Never connects to Core or live accounts.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyRoot = process.env.NEX_TODO_DEPENDENCIES || root;
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const { build } = require('esbuild');
const outdir = path.join(root, '.todo-design-preview');
await fs.mkdir(outdir, { recursive: true });
await build({ entryPoints: [path.join(root, 'scripts/testing/todo-design/main.tsx')], outdir, bundle: true, format: 'esm', jsx: 'automatic', minify: false, nodePaths: [path.join(dependencyRoot, 'node_modules')], define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.png': 'file', '.svg': 'file', '.webp': 'file', '.jpg': 'file' }, assetNames: 'assets/[name]-[hash]', plugins: [{ name: 'asset-url', setup(b) { b.onResolve({ filter: /\?url$/ }, a => ({ path: path.resolve(a.resolveDir, a.path.slice(0, -4)) })); } }] });
await fs.writeFile(path.join(outdir, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NexBot · 待办设计预览</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  try {
    const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(outdir, '.' + (requested === '/' ? '/index.html' : requested));
    if (!file.startsWith(outdir + path.sep)) { res.writeHead(403); res.end(); return; }
    const bytes = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(process.env.NEX_TODO_PORT || 4318), '127.0.0.1', () => console.log(`NexBot Todo design fixture: http://127.0.0.1:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
