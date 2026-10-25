import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { htmlPreviewShell } from '../shared/html-preview-shell.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'nex-html-preview-'));
const localUi = process.argv.includes('--local-ui');
const output = path.resolve('release/html-preview', ...(localUi ? ['local-ui'] : [])); mkdirSync(output, { recursive: true });
const ui = path.join(directory, 'ui'); mkdirSync(ui);
await build({ entryPoints: ['scripts/testing/html-preview-fixture.tsx'], outfile: path.join(ui, 'fixture.js'), bundle: true, format: 'iife', jsx: 'automatic', platform: 'browser', define: { __APP_VERSION__: '"fixture"' }, loader: { '.svg': 'dataurl', '.png': 'dataurl' } });
writeFileSync(path.join(ui, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><link rel="stylesheet" href="/layout.css"><div id="root"></div><script src="/fixture.js"></script>');
writeFileSync(path.join(ui, 'layout.css'), 'body{margin:0;padding:16px;background:#f7f8fa;font:14px system-ui}main{max-width:1000px;margin:auto}h1{font-size:18px}*{box-sizing:border-box}pre{overflow:auto}');
writeFileSync(path.join(ui, 'html-preview.html'), htmlPreviewShell());
const { createPersonalApp } = await import(pathToFileURL(path.resolve('dist-personal/server/core/index.js')).href);
const core = await createPersonalApp({ dir: path.join(directory, 'core'), key: randomBytes(32), token: 'synthetic-html-preview', uiDir: ui, memoryRuntime: false, hostDevice: false, identity: false });
const leaks = [];
let shellRequests = 0;
core.server.prependListener('request', request => { if (request.url.startsWith('/leak')) leaks.push(request.url); if (request.url === '/html-preview.html') shellRequests++; });
const config = path.join(directory, 'config.json'); writeFileSync(config, JSON.stringify({ directory, output, origin: core.origin, ...(localUi ? { localUi: ui } : {}) }));
const electron = process.argv.find(a => a.startsWith('--electron='))?.slice(11) ?? path.resolve('dist-personal/electron/electron.exe');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
try {
  const child = spawn(electron, [path.resolve('scripts/testing/html-preview-electron.cjs'), config], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', data => { logs = (logs + data).slice(-3000); }); child.stderr.on('data', data => { logs = (logs + data).slice(-3000); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error('Owned preview fixture timed out')); }, 90000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(Error('Electron fixture failed: ' + logs)); });
  });
  const report = JSON.parse(readFileSync(path.join(directory, 'result.json'), 'utf8'));
  report.requestsBlocked = leaks.length === 0;
  if (localUi) { report.remoteShellRequests = shellRequests; assert.equal(shellRequests, 0, 'Bundled preview must not depend on a deployed Core route'); }
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.passed, true, JSON.stringify(report)); assert.deepEqual(leaks, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await core.close();
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
  catch { console.warn('Owned fixture retained for cleanup:', directory); }
}
