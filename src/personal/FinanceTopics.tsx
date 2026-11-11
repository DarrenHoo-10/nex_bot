import { useRef } from 'react';
import { api, str, type RecordRow } from './api';
import './finance-topics.css';

export interface FinanceTopic {
  conversationId: string;
  title: string;
  audience: 'public' | 'private';
  sourceContext: { chatName?: string };
  last_activity_at: number;
  message_count: number;
  messages?: RecordRow[];
  unread_count: number;
  activeTask: { id: string; status: string } | null;
}
export type FinanceTask = RecordRow & { effects: RecordRow[] };

export function topicTimeline(messages: RecordRow[], topics: FinanceTopic[]) {
  const ids = new Set(topics.map(topic => topic.conversationId));
  const rows = messages.filter(message => !ids.has(str(message.conversation_id)));
  for (const topic of topics) {
    rows.push({ id: topic.conversationId, kind: 'finance-topic', role: 'user', content: topic.title,
      preview: topic.messages?.filter(message => message.role === "assistant").at(-1)?.content ?? "",
      created_at: topic.last_activity_at, count: topic.message_count, unread: topic.unread_count, audience: topic.audience });
  }
  return rows.sort((a, b) => Number(a.created_at) - Number(b.created_at));
}

export function TopicBubble({ row, open }: { row: RecordRow; open: () => void }) {
  return <article className="message user"><div className="message-body"><button type="button" className="bubble topic-bubble" onClick={open}>
    <strong>{row.content}</strong>{row.preview ? <span className="topic-preview">{str(row.preview)}</span> : null}<small>{row.audience === 'public' ? '飞书话题' : '私人话题'} · {row.count} 条消息{Number(row.unread) > 0 ? ' · ' + row.unread + ' 未读' : ''}　›</small>
  </button></div></article>;
}

export function TopicTasks({ tasks, botId, conversationId, run }: { tasks: FinanceTask[]; botId: string; conversationId: string; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const retries = useRef(new Map<string, string>());
  if (!tasks.length) return null;
  return <details className="finance-task-history"><summary>任务记录 · {tasks.length}</summary>
    {tasks.map(task => <div key={str(task.id)}><strong>{task.status}</strong> {str(task.objective).slice(0,120)}
      {task.effects.map(effect => <small key={str(effect.id)}>{effect.tool_name} · {effect.status}</small>)}
      {['failed','cancelled'].includes(str(task.status)) && <button type="button" onClick={() => void run(async () => {
        const id = str(task.id), clientId = retries.current.get(id) ?? crypto.randomUUID();
        retries.current.set(id,clientId);
        await api('agents/retry',{ botId, conversationId, taskId:id, clientId });
        retries.current.delete(id);
      })}>重试任务</button>}
    </div>)}
  </details>;
}