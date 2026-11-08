import { useEffect, useMemo, useRef, useState } from 'react';
import { listConnectionModels, type Connection, type State } from './api';
import { ModelSelection } from './components/ModelPicker';
import { useModelSelection } from './useModelSelection';

/**
 * 生图模型: image generation uses OpenAI-compatible providers (/images/generations), whichever is the default.
 * Pick a provider, then its image models; every enabled provider's selection is offered to the assistant.
 */
export function ImageModelSettings({ state, refresh, active }: { state: State; refresh: () => Promise<void>; active: boolean }) {
  const providers = (state.connections ?? []).filter((connection) => connection.provider === 'openai' && connection.enabled && connection.configured);
  const [chosen, setChosen] = useState('');
  const provider = providers.find((connection) => connection.id === chosen) ?? providers.find((connection) => connection.isDefault) ?? providers[0];
  const total = providers.reduce((count, connection) => count + (connection.imageModels?.models.length ?? 0), 0);
  return <section className="preferences-section" aria-label="生图模型">
    <div className="preferences-section-heading"><h3>生图模型</h3><span className="preferences-status">{providers.length ? `已选 ${total} 个` : state.connections?.length ? '需要 OpenAI 兼容的供应商' : '请先连接模型'}</span></div>
    {provider ? <fieldset>
      {providers.length > 1 ? <label className="field">供应商<select value={provider.id} onChange={(event) => setChosen(event.target.value)}>{providers.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}{connection.imageModels?.models.length ? `（已选 ${connection.imageModels.models.length}）` : ''}</option>)}</select></label> : null}
      <ProviderImageModels key={provider.id} connection={provider} refresh={refresh} active={active}/>
    </fieldset> : null}
  </section>;
}

function ProviderImageModels({ connection, refresh, active }: { connection: Connection; refresh: () => Promise<void>; active: boolean }) {
  const [models, setModels] = useState<string[]>([]), [loading, setLoading] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const autosave = useModelSelection('models/images', { connectionId: connection.id }, connection.imageModels ?? { models: [], version: 0 }, refresh);
  const selection = autosave.selection ?? [];
  const alive = useRef(true), loaded = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async () => {
    if (loading) return; setLoading(true); setError('');
    try { const result = await listConnectionModels(connection.id); if (alive.current) { setModels(result.models); setNotice(result.hasMore ? '模型列表未全部返回' : ''); } }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '获取失败'); }
    finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => { if (active && !loaded.current) { loaded.current = true; void load(); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => [...new Set([...models, ...selection, ...(connection.models ?? [])].filter(Boolean))].sort(), [models, selection, connection.models]);
  const selected = useMemo(() => new Set(selection), [selection]);
  return <>
    <ModelSelection models={all} selected={selected} label="选择生图模型" disabled={loading} onSelect={id => autosave.toggle(id, all)}/>
    {loading && <span role="status" className="preferences-status">获取中…</span>}
    {(autosave.busy || notice) && <span role="status" className="preferences-status">{autosave.busy ? '保存中…' : notice}</span>}
    {autosave.error && <p role="alert" className="model-error">{autosave.error}</p>}
    {error && <p role="alert" className="model-error">{error} <button type="button" disabled={loading} onClick={() => void load()}>重试获取</button></p>}
  </>;
}
