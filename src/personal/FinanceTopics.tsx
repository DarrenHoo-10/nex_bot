import { str, type RecordRow } from './api';
import { messagePreview } from './message-media';

export interface FinanceTopic {
  conversationId: string;
  title: string;
  audience: 'public' | 'private';
  sourceContext: { chatName?: string; channel?: string; chatType?: string };
  last_activity_at: number;
  message_count: number;
  messages?: RecordRow[];
  read_seq?: number;
  unread_count: number;
  activeTask: { id: string; status: string } | null;
}

export function topicTimeline(messages: RecordRow[], topics: FinanceTopic[]) {
  const ids = new Set(topics.map(topic => topic.conversationId));
  const rows = messages.filter(message => !ids.has(str(message.conversation_id)));
  for (const topic of topics) {
    const rawPreview = str(topic.messages?.filter(message => message.role === "assistant").at(-1)?.content ?? "");
    rows.push({ id: topic.conversationId, kind: 'finance-topic', role: 'user', content: topic.title,
      preview: rawPreview ? messagePreview(rawPreview) : "",
      created_at: topic.last_activity_at, count: topic.message_count, unread: topic.unread_count, audience: topic.audience, source: topicSource(topic) });
  }
  return rows.sort((a, b) => Number(a.created_at) - Number(b.created_at));
}

/** Where a topic came from: the Feishu group's name, a Feishu private chat, or the app itself. */
export function topicSource(topic: FinanceTopic) {
  const source = topic.sourceContext ?? {};
  if (source.channel === 'feishu') return source.chatName ? '飞书 · ' + source.chatName : source.chatType === 'p2p' ? '飞书私聊' : '飞书话题';
  return topic.audience === 'public' ? '飞书话题' : '私人话题';
}

export function TopicBubble({ row, open }: { row: RecordRow; open: () => void }) {
  const unread = Number(row.unread) || 0;
  return <article className="message user" data-topic-id={str(row.id)} data-unread={unread > 0 ? "true" : undefined}><div className="message-body"><button type="button" className="bubble topic-bubble" onClick={open}>
    <strong>{row.content}</strong>{row.preview ? <span className="topic-preview">{str(row.preview)}</span> : null}<small className="topic-meta"><span>{row.source ?? (row.audience === 'public' ? '飞书话题' : '私人话题')} · {row.count} 条消息</span>{unread > 0 ? <span className="topic-unread-badge">{unread} 未读</span> : null}<span className="topic-chevron" aria-hidden="true">›</span></small>
  </button></div></article>;
}
