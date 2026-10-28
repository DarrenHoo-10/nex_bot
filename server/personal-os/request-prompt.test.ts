import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@earendil-works/pi-coding-agent';
import { applyRequestPrompt } from './request-prompt.ts';
import { dropStaleSystemEntries } from './context-tools.ts';

const prompt = { systemPrompt: 'STABLE', volatilePrompt: '<system-reminder>VOLATILE</system-reminder>' };
const volatile = { role: 'user', content: prompt.volatilePrompt };
const run = (provider: string, messages: unknown[]) => { const payload: { system?: unknown; messages: unknown[] } = { messages: structuredClone(messages) }; applyRequestPrompt(provider, payload, prompt); return payload; };

describe('request prompt injection', () => {
  const call = { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }, { id: 'c2' }] };
  const results = [{ role: 'tool', tool_call_id: 'c1', content: 'r1' }, { role: 'tool', tool_call_id: 'c2', content: 'r2' }];
  it('puts the volatile block before the input the model must answer (OpenAI)', () => {
    const history = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }];
    expect(run('openai', [{ role: 'system', content: 'OLD' }, ...history, { role: 'user', content: 'u2' }]).messages).toEqual([{ role: 'system', content: 'STABLE' }, ...history, volatile, { role: 'user', content: 'u2' }]);
    // A run of steered inputs stays together; the block precedes the whole run.
    expect(run('openai', [{ role: 'developer', content: 'OLD' }, ...history, { role: 'user', content: 'u2' }, { role: 'user', content: 'u3' }]).messages).toEqual([{ role: 'developer', content: 'STABLE' }, ...history, volatile, { role: 'user', content: 'u2' }, { role: 'user', content: 'u3' }]);
    expect(run('openai', [{ role: 'user', content: 'only' }]).messages).toEqual([{ role: 'system', content: 'STABLE' }, volatile, { role: 'user', content: 'only' }]);
  });
  it('appends after tool results and never splits a tool call from its results (OpenAI)', () => {
    const base = [{ role: 'user', content: 'u1' }, call, ...results];
    expect(run('openai', base).messages).toEqual([{ role: 'system', content: 'STABLE' }, ...base, volatile]);
    // The SDK's image follow-up after tool results is a user message: the block goes between them.
    const image = { role: 'user', content: [{ type: 'image_url' }] };
    expect(run('openai', [...base, image]).messages).toEqual([{ role: 'system', content: 'STABLE' }, ...base, volatile, image]);
  });
  it('makes the same messages a prefix of the next request once the volatile block is removed', () => {
    const first = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u1' }];
    const second = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u1' }, call, ...results];
    const third = [...second, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }];
    const strip = (messages: unknown[]) => messages.filter((m) => JSON.stringify(m) !== JSON.stringify(volatile));
    const [a, b, c] = [first, second, third].map((messages) => strip(run('openai', messages).messages));
    expect(b.slice(0, a.length)).toEqual(a);
    expect(c.slice(0, b.length)).toEqual(b);
  });
  it('adds the volatile block as a trailing text part after tool results and the cache breakpoint (Anthropic)', () => {
    const cached = { type: 'text', text: 'u2', cache_control: { type: 'ephemeral' } };
    const tool = { type: 'tool_result', tool_use_id: 't1', content: 'r1' };
    const part = { type: 'text', text: prompt.volatilePrompt };
    const input = run('anthropic', [{ role: 'user', content: [cached] }]);
    expect(input.system).toBe('STABLE');
    expect(input.messages).toEqual([{ role: 'user', content: [cached, part] }]);
    const continued = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] }, { role: 'user', content: [tool] }];
    expect(run('anthropic', continued).messages.at(-1)).toEqual({ role: 'user', content: [tool, part] });
    expect(run('anthropic', [{ role: 'user', content: 'plain' }]).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'plain' }, part] }]);
    expect(run('anthropic', [{ role: 'user', content: 'u' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }]).messages.at(-1)).toEqual({ role: 'user', content: [part] });
  });
  it('rejects a payload without messages', () => {
    expect(() => applyRequestPrompt('openai', {}, prompt)).toThrow('Invalid model messages');
  });
});

describe('dropping stale system entries', () => {
  const entry = (id: string, parentId: string | null, role: string, extra: object = {}) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message: { role, content: id, timestamp: 1 }, ...extra }) as unknown as FileEntry;
  const header = { type: 'session', version: 3, id: 's', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/' } as unknown as FileEntry;
  it('keeps the newest system entry, every other entry id and a valid parent chain', () => {
    const entries = [header, entry('s1', null, 'system'), entry('u1', 's1', 'user'), entry('a1', 'u1', 'assistant'), entry('s2', 'a1', 'system'), entry('u2', 's2', 'user'), entry('s3', 'u2', 'system'), entry('u3', 's3', 'user')];
    const kept = dropStaleSystemEntries(entries);
    expect(kept.map((e) => e.type === 'session' ? 'session' : e.id)).toEqual(['session', 'u1', 'a1', 'u2', 's3', 'u3']);
    const parents = Object.fromEntries(kept.flatMap((e) => e.type === 'session' ? [] : [[e.id, e.parentId]]));
    expect(parents).toEqual({ u1: null, a1: 'u1', u2: 'a1', s3: 'u2', u3: 's3' });
    expect(dropStaleSystemEntries(kept)).toBe(kept);
  });
  it('retains a stale system entry that a compaction still names', () => {
    const compaction = { type: 'compaction', id: 'k1', parentId: 'u2', timestamp: '2026-01-01T00:00:00.000Z', summary: 's', firstKeptEntryId: 'u2', tokensBefore: 1, details: { sourceFirst: 's1', sourceLast: 's2' } } as unknown as FileEntry;
    const entries = [header, entry('s1', null, 'system'), entry('u1', 's1', 'user'), entry('s2', 'u1', 'system'), entry('u2', 's2', 'user'), compaction, entry('s3', 'k1', 'system')];
    expect(dropStaleSystemEntries(entries).map((e) => e.type === 'session' ? 'session' : e.id)).toEqual(['session', 's1', 'u1', 's2', 'u2', 'k1', 's3']);
  });
});
