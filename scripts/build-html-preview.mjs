import { htmlPreviewShell } from '../shared/html-preview-shell.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const shell = htmlPreviewShell();
const resource = fileURLToPath(new URL('../apps/apple/Packages/NexMarkdown/Sources/NexMarkdown/Resources/html-preview.html', import.meta.url));
if (process.argv.includes('--check')) {
  if (readFileSync(resource, 'utf8') !== shell) throw new Error('HTML preview resource is stale: run node scripts/build-html-preview.mjs');
} else { writeFileSync(resource, shell); }
