import { describe, expect, it } from 'vitest';
import { htmlPreviewParts, previewHeight } from './html-preview';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HtmlPreview } from '../src/personal/components/HtmlPreview';

describe('explicit HTML preview blocks', () => {
  it('recognizes complete backtick and tilde fences amid ordinary Markdown', () => {
    const parts = htmlPreviewParts('前文\n\n```html-preview\n<button>你好</button>\n```\n\n后文\n\n~~~~html-preview\n<canvas></canvas>\n~~~~~');
    expect(parts.filter(p => p.kind === 'preview')).toEqual([
      { kind: 'preview', source: '<button>你好</button>', complete: true },
      { kind: 'preview', source: '<canvas></canvas>', complete: true },
    ]);
    expect(parts.filter(p => p.kind === 'markdown').map(p => p.source).join('')).toContain('后文');
  });
  it('does not execute ordinary code, nested examples or forged raw HTML', () => {
    for (const source of ['```html\n<script>alert(1)</script>\n```', '````markdown\n```html-preview\n<script>bad()</script>\n```\n````', '> ```html-preview\n> bad\n> ```', '- item\n\n  ```html-preview\n  bad\n  ```', '<pre><code class="language-html-preview">bad</code></pre>', '```html-preview example\nbad\n```']) {
      expect(htmlPreviewParts(source).every(p => p.kind === 'markdown'), source).toBe(true);
    }
  });
  it('rejects unfinished and mismatched closing fences, including CRLF', () => {
    for (const source of ['```html-preview\n<button>', '~~~~html-preview\r\nx\r\n~~~', '```html-preview\nx\n```trailer']) {
      expect(htmlPreviewParts(source).find(p => p.kind === 'preview')).toMatchObject({ complete: false });
    }
    expect(htmlPreviewParts('```html-preview\r\nx\r\n```')[0]).toMatchObject({ complete: true, source: 'x' });
  });
  it('never mounts a frame for any streaming prefix or incomplete/oversized block', () => {
    const source = '```html-preview\n<script>window.ran=1</script>\n```';
    for (let i = 0; i <= source.length; i++) for (const part of htmlPreviewParts(source.slice(0, i))) {
      if (part.kind === 'preview') expect(renderToStaticMarkup(React.createElement(HtmlPreview, { ...part, pending: true }))).not.toContain('<iframe');
    }
    expect(renderToStaticMarkup(React.createElement(HtmlPreview, { source: 'x', complete: false, pending: false }))).not.toContain('<iframe');
    expect(renderToStaticMarkup(React.createElement(HtmlPreview, { source: 'x'.repeat(500_001), complete: true, pending: false }))).not.toContain('<iframe');
  });
  it('bounds untrusted measurements and rejects nonnumeric values', () => {
    for (const value of [null, '400', {}, NaN, Infinity, -1, 0]) expect(previewHeight(value)).toBeUndefined();
    expect(previewHeight(1)).toBe(160); expect(previewHeight(1e100)).toBe(900); expect(previewHeight(400.2)).toBe(401);
  });
});
