import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const resource = fileURLToPath(new URL('../apps/apple/Packages/NexMarkdown/Sources/NexMarkdown/Resources/', import.meta.url));
const result = await build({ entryPoints: [fileURLToPath(new URL('../shared/chat-charts-native.ts', import.meta.url))], bundle: true, write: false, format: 'iife', target: 'safari17', minify: true, legalComments: 'none' });
const content = result.outputFiles[0].text;
if (process.argv.includes('--check')) {
  if (readFileSync(resource + 'chat-charts.js', 'utf8') !== content) throw new Error('Apple chart resource is stale: run node scripts/build-chat-charts.mjs');
} else { mkdirSync(resource, { recursive: true }); writeFileSync(resource + 'chat-charts.js', content); }
