import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hash } from './store.ts';
import { createPersonalApp } from './index.ts';
import { StockHistory, type HistoryTransport } from './stock-history.ts';
import { startFakeModel } from '../runtime/pi/p0/fake-model.ts';
type Event = {
    id: number;
    cursor: number;
    sessionId: string;
    role?: 'user' | 'assistant';
    content?: string;
    createdAt?: number;
    deleted?: boolean;
};
async function fixture() {
    const dir = mkdtempSync(path.join(tmpdir(), 'nex-stock-history-')), fake = await startFakeModel(), key = randomBytes(32), events: Event[] = [], calls: number[] = [];
    const options = { dir, key, token: 'fixture', identity: false as const, hostDevice: false as const, memoryRuntime: false as const, modelCatalog: { fetchDisabled: true } };
    let app = await createPersonalApp(options), history: StockHistory;
    for (const session of ['owner-a', 'owner-b'])
        app.store.insert('user_sessions', { id: session, workspace_id: app.store.workspace, user_id: app.store.owner, token_hash: hash(session), protocol: 'local', revocation_mode: 'local', created_at: Date.now(), expires_at: Date.now() + 3600000 });
    const transport: HistoryTransport = { historyScope: async (session) => { if (!['owner-a', 'owner-b'].includes(session))
            throw Error('untrusted account'); return { issuer: 'https://identity.example.test', subject: session, instanceId: 'stock-fixture' }; }, historyPage: async (_session, after, limit) => { calls.push(after); const rows = events.filter(row => _session === 'owner-a' && row.cursor > after).slice(0, Math.min(limit, 7)); return { messages: rows, nextCursor: rows.at(-1)?.cursor ?? after, hasMore: events.some(row => _session === 'owner-a' && row.cursor > (rows.at(-1)?.cursor ?? after)), cursorVersion: 2, capabilities: { edits: true, deletions: true, transactionalChanges: true } }; } };
    const install = () => { history = new StockHistory(app.store, app.agents, app.runtime, transport); app.runtime.prepareConversation = conv => history.prepare(conv); };
    install();
    app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fake', apiKey: 'synthetic' });
    return { get app() { return app; }, get history() { return history; }, fake, events, calls, transport, async restart() { await history.close(); await app.close(); app = await createPersonalApp(options); install(); }, async close() { await history.close(); await app.close(); await fake.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function seed(events: Event[], count: number, sessionId = 'legacy-session') { for (let i = 1; i <= count; i++)
    events.push({ id: i, cursor: i, sessionId, role: i % 2 ? 'user' : 'assistant', content: 'historical ' + i + ' ' + ('synthetic evidence '.repeat(60)), createdAt: 1700000000000 + i }); }
it('imports exact pages once, scopes aliases, does not publish/run/retain, supports edits, durable cursors and deleted tombstones', async () => {
    const f = await fixture();
    try {
        seed(f.events, 16);
        const published = vi.fn();
        f.app.agents.onPublished = published;
        await f.history.sync('owner-a', 1);
        expect(f.app.store.all('SELECT * FROM stock_history_messages')).toHaveLength(7);
        expect(f.app.store.all('SELECT * FROM tasks')).toHaveLength(0);
        const list = await f.history.list('owner-a');
        expect(list.aliases).toHaveLength(1);
        const conversation = String(list.aliases[0].conversationId), bot = String(list.aliases[0].botId);
        expect(f.app.agents.topic(bot, conversation).audience).toBe('private');
        expect((await f.history.get('owner-a', 'legacy-session')).messages).toHaveLength(16);
        expect(published).not.toHaveBeenCalled();
        expect(f.app.agents.contacts()[0].unread_count).toBe(0);
        expect(f.app.store.all('SELECT * FROM memory_source_registry')).toHaveLength(0);
        await f.history.sync('owner-a');
        expect(f.app.store.all('SELECT * FROM stock_history_messages')).toHaveLength(16);
        expect(f.calls).toContain(16);
        await expect(f.history.get('owner-b', 'not-mine')).rejects.toThrow('别名不存在');
        await expect(f.history.list('untrusted')).rejects.toThrow('untrusted');
        f.events.push({ ...f.events[0], cursor: 17, content: 'edited history' });
        await f.history.sync('owner-a');
        expect((await f.history.get('owner-a', 'legacy-session')).messages[0].content).toBe('edited history');
        f.events.push({ id: 2, cursor: 18, sessionId: 'legacy-session', deleted: true });
        await f.history.sync('owner-a');
        expect((await f.history.get('owner-a', 'legacy-session')).messages).toHaveLength(15);
        await f.restart();
        expect((await f.history.list('owner-a')).aliases[0].conversationId).toBe(conversation);
        expect(f.calls.at(-1)).toBe(18);
        await f.history.remove('owner-a', 'legacy-session');
        await expect(f.history.send('owner-a', { sessionId: 'legacy-session', text: 'resume deleted', clientId: 'deleted' })).rejects.toThrow('已移除');
        f.events.push({ id: 2, cursor: 19, sessionId: 'legacy-session', role: 'assistant', content: 'resurrection attempt', createdAt: 1700000000020 });
        await f.history.sync('owner-a');
        expect((await f.history.list('owner-a')).aliases).toHaveLength(0);
        expect(f.app.store.all("SELECT * FROM agent_messages WHERE content='resurrection attempt'")).toHaveLength(0);
    }
    finally {
        await f.close();
    }
}, 30000);
it('hydrates real worker context, reports real compaction, removes only selected topic and cancels only exact queued input', async () => {
    const f = await fixture();
    try {
        seed(f.events, 16);
        await f.history.sync('owner-a');
        const info = await f.history.context('owner-a', 'legacy-session');
        expect(info.message_count).toBe(16);
        expect(info.history_tokens).toBeGreaterThan(1000);
        expect(info.compactable_message_count).toBeGreaterThan(0);
        const alias = (await f.history.list('owner-a')).aliases[0], bot = String(alias.botId), conv = String(alias.conversationId), before = info.history_tokens;
        f.fake.scripts.push({ kind: 'openai-text', text: 'Summary: historical research, synthetic evidence, no business writes.' });
        const compact = await f.history.compact('owner-a', 'legacy-session');
        expect(compact.compacted).toBe(true);
        expect(compact.context.history_tokens).toBeLessThan(before);
        expect(compact.context.summary?.covered_message_count).toBeGreaterThan(0);
        f.fake.scripts.push({ kind: 'openai-text', text: 'continued from imported history' });
        const sent = await f.history.send('owner-a', { sessionId: 'legacy-session', clientId: 'continue', text: 'continue my research' });
        expect(sent.conversationId).toBe(conv);
        const deadline = Date.now() + 25000;
        while (f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status !== 'succeeded' && Date.now() < deadline)
            await new Promise(r => setTimeout(r, 30));
        expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status).toBe('succeeded');
        const requests = f.fake.requests.filter(r => r.url.includes('completions'));
        expect(requests.at(-1)?.body).toContain('Summary: historical research');
        expect(requests.at(-1)?.body).toContain('historical 16');
        const kick = f.app.runtime.kick;
        f.app.runtime.kick = () => { };
        const other = f.app.agents.send(bot, 'unrelated topic', 'unrelated', undefined, { newConversation: true });
        const first = f.app.agents.send(bot, 'active topic input', 'active', undefined, { conversationId: conv });
        const queued = f.app.agents.send(bot, 'queued topic input', 'queued', undefined, { conversationId: conv });
        expect(queued.taskId).toBeNull();
        f.app.agents.cancelMessage(bot, conv, queued.messageId);
        expect(f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', first.taskId)?.ended_at).toBeNull();
        await f.history.remove('owner-a', 'legacy-session');
        expect(f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', other.taskId)?.ended_at).toBeNull();
        expect(f.app.agents.topicMessages(bot, other.conversationId)).toHaveLength(1);
        f.app.runtime.kick = kick;
    }
    finally {
        await f.close();
    }
}, 40000);
it('does not skip middle messages when paging forward beyond two hundred', async () => {
    const f = await fixture();
    try {
        seed(f.events, 215);
        await f.history.sync('owner-a', 50);
        const a = await f.history.get('owner-a', 'legacy-session', undefined, 0), b = await f.history.get('owner-a', 'legacy-session', undefined, Number(a.nextAfter));
        expect(a.messages).toHaveLength(200);
        expect(a.hasMore).toBe(true);
        expect(b.messages).toHaveLength(15);
        expect(b.hasMore).toBe(false);
        expect(new Set([...a.messages, ...b.messages].map(m => m.id)).size).toBe(215);
    }
    finally {
        await f.close();
    }
}, 30000);
it('rejects malformed cursor pages atomically and handles cursor-protocol upgrades without duplication or resurrection', async () => {
    const f = await fixture();
    try {
        f.events.push({ id: 100, cursor: 1, sessionId: 'migration', role: 'user', content: 'unchanged source', createdAt: 1700000000001 });
        let version = 1;
        f.transport.historyPage = async (_session, after) => version === 1 ? { messages: after ? [] : [{ id: 100, sessionId: 'migration', role: 'user', content: 'unchanged source', createdAt: 1700000000001 }], nextCursor: 100, hasMore: false } : { messages: after ? [] : f.events, nextCursor: after || 1, hasMore: false, cursorVersion: 2, capabilities: { deletions: true } };
        await f.history.sync('owner-a');
        const first = (await f.history.get('owner-a', 'migration')).messages[0].id;
        version = 2;
        await f.history.sync('owner-a');
        expect((await f.history.get('owner-a', 'migration')).messages[0].id).toBe(first);
        expect(f.app.store.get('SELECT COUNT(*) n FROM agent_messages')?.n).toBe(1);
        const cursor = f.app.store.get('SELECT cursor FROM stock_history_cursors')?.cursor;
        f.transport.historyPage = async () => ({ messages: [{ id: 101, cursor: 2, sessionId: 'migration', role: 'user', content: 'must roll back', createdAt: 1700000000002 }, { id: 102, cursor: 2, sessionId: 'migration', role: 'assistant', content: 'duplicate cursor', createdAt: 1700000000003 }], nextCursor: 2, hasMore: false, cursorVersion: 2 });
        await expect(f.history.sync('owner-a')).rejects.toThrow('游标乱序');
        expect(f.app.store.get('SELECT COUNT(*) n FROM agent_messages')?.n).toBe(1);
        expect(f.app.store.get('SELECT cursor FROM stock_history_cursors')?.cursor).toBe(cursor);
        f.transport.historyPage = async (_session, after) => ({ messages: after < 2 ? [{ id: 100, cursor: 2, sessionId: 'migration', deleted: true }] : [], nextCursor: 2, hasMore: false, cursorVersion: 2, capabilities: { deletions: true } });
        await f.history.sync('owner-a');
        expect((await f.history.list('owner-a')).aliases).toHaveLength(0);
        await expect(f.history.send('owner-a', { sessionId: 'migration', text: 'do not resurrect', clientId: 'after-delete' })).rejects.toThrow('已移除');
    }
    finally {
        await f.close();
    }
}, 30000);
