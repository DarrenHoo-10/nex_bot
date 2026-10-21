import { useEffect, useMemo, useRef, useState } from 'react';
import { listModels, str, type State } from './api';
import { ModelSelection } from './components/ModelPicker';
import { useModelSelection } from './useModelSelection';

export function ModelVisibility({ state, refresh, active }: { state: State; refresh: () => Promise<void>; active: boolean }) {
  const [models, setModels] = useState<string[]>([]), [loading, setLoading] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const autosave = useModelSelection('models/visibility', { provider: state.config?.provider_id, endpoint: state.config?.endpoint }, state.modelVisibility ?? { models: null, version: 0 }, refresh);
  const selection = autosave.selection;
  const alive = useRef(true), loaded = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async () => {
    if (loading) return; setLoading(true); setError('');
    try { const result = await listModels({ provider: str(state.config?.provider_id), endpoint: str(state.config?.endpoint), apiKey: '' }); if (alive.current) { setModels(result.models); setNotice(result.hasMore ? '服务仍有未返回的模型，可手动添加。' : ''); } }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '获取失败'); }
    finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => { if (active && !loaded.current) { loaded.current = true; void load(); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => [...new Set([...models, ...(selection ?? []), str(state.config?.default_model)].filter(Boolean))].sort(), [models, selection, state.config?.default_model]);
  const selected = useMemo(() => new Set(selection ?? all), [selection, all]);
  return <section className="preferences-section" data-model-visibility>
    <div className="preferences-section-heading"><h3>显示的模型</h3><span className="preferences-status">{selection === null ? '全部模型' : `已选 ${selection.length} 个`}</span></div>
    <fieldset>
      <ModelSelection models={all} selected={selected} label="选择显示的模型" disabled={loading} allowCustom onSelect={id => autosave.toggle(id, all)}/>
      {loading && <span role="status" className="preferences-status">获取中…</span>}
      {(autosave.busy || notice) && <span role="status" className="preferences-status">{autosave.busy ? '保存中…' : notice}</span>}
      {autosave.error && <p role="alert" className="model-error">{autosave.error}</p>}
    </fieldset>
    {error && <p role="alert" className="model-error">{error} <button type="button" disabled={loading} onClick={() => void load()}>重试获取</button></p>}
  </section>;
}
