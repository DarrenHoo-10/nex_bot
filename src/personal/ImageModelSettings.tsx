import { useEffect, useMemo, useRef, useState } from 'react';
import { listModels, str, type State } from './api';
import { ModelSelection } from './components/ModelPicker';
import { useModelSelection } from './useModelSelection';

export function ImageModelSettings({ state, refresh, active }: { state: State; refresh: () => Promise<void>; active: boolean }) {
  const [models, setModels] = useState<string[]>([]), [loading, setLoading] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const autosave = useModelSelection('models/images', { provider: state.config?.provider_id, endpoint: state.config?.endpoint }, state.imageModelSelection ?? { models: [], version: 0 }, refresh);
  const selection = autosave.selection ?? [];
  const alive = useRef(true), loaded = useRef(false);
  const supported = state.config?.provider_id === 'openai';
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async () => {
    if (loading) return; setLoading(true); setError('');
    try { const result = await listModels({ provider: str(state.config?.provider_id), endpoint: str(state.config?.endpoint), apiKey: '' }); if (alive.current) { setModels(result.models); setNotice(result.hasMore ? '模型列表未全部返回' : ''); } }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '获取失败'); }
    finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => { if (active && supported && !loaded.current) { loaded.current = true; void load(); } }, [active, supported]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => [...new Set([...models, ...selection, ...(state.modelVisibility?.models ?? []), str(state.config?.default_model)].filter(Boolean))].sort(), [models, selection, state.modelVisibility?.models, state.config?.default_model]);
  const selected = useMemo(() => new Set(selection), [selection]);
  return <section className="preferences-section" aria-label="生图模型">
    <div className="preferences-section-heading"><h3>生图模型</h3><span className="preferences-status">{supported ? `已选 ${selection.length} 个` : state.config ? '当前模型连接不支持生图' : '请先连接模型'}</span></div>
    {supported && <fieldset>
      <ModelSelection models={all} selected={selected} label="选择生图模型" disabled={loading} onSelect={id => autosave.toggle(id, all)}/>
      {loading && <span role="status" className="preferences-status">获取中…</span>}
      {(autosave.busy || notice) && <span role="status" className="preferences-status">{autosave.busy ? '保存中…' : notice}</span>}
      {autosave.error && <p role="alert" className="model-error">{autosave.error}</p>}
    </fieldset>}
    {error && <p role="alert" className="model-error">{error} <button type="button" disabled={loading} onClick={() => void load()}>重试获取</button></p>}
  </section>;
}
