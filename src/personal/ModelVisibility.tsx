import { useEffect, useMemo, useRef, useState } from 'react';
import { listModels, str, type State } from './api';
import { ModelSelection } from './components/ModelPicker';
import { useModelSelection } from './useModelSelection';

const sameEndpoint = (a: unknown, b: unknown) => str(a as string).replace(/\/+$/, '') === str(b as string).replace(/\/+$/, '');

/**
 * The models offered in pickers. For the saved connection a choice saves at
 * once. For a connection still being edited it is kept as a draft that the
 * connection form saves together with the connection.
 */
export function ModelVisibility({ state, refresh, active, scope, models: fetched = [], onSelection }: {
  state: State; refresh: () => Promise<void>; active: boolean;
  scope: { provider: string; endpoint: string }; models?: string[]; onSelection?: (selection: string[] | null) => void;
}) {
  const saved = !!state.config && state.config.provider_id === scope.provider && sameEndpoint(state.config.endpoint, scope.endpoint);
  const [models, setModels] = useState<string[]>([]), [loading, setLoading] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const autosave = useModelSelection('models/visibility', { provider: state.config?.provider_id, endpoint: state.config?.endpoint }, state.modelVisibility ?? { models: null, version: 0 }, refresh);
  const [draft, setDraft] = useState<string[] | null>(null);
  const selection = saved ? autosave.selection : draft;
  const alive = useRef(true), loaded = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onSelection?.(selection); }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = async () => {
    if (loading) return; setLoading(true); setError('');
    try { const result = await listModels({ provider: str(state.config?.provider_id), endpoint: str(state.config?.endpoint), apiKey: '' }); if (alive.current) { setModels(result.models); setNotice(result.hasMore ? '服务仍有未返回的模型，可手动添加。' : ''); } }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '获取失败'); }
    finally { if (alive.current) setLoading(false); }
  };
  // Only the saved connection can be listed without the key typed in the form.
  useEffect(() => { if (active && saved && !loaded.current) { loaded.current = true; void load(); } }, [active, saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => [...new Set([...models, ...fetched, ...(selection ?? []), saved ? str(state.config?.default_model) : ''].filter(Boolean))].sort(), [models, fetched, selection, saved, state.config?.default_model]);
  const selected = useMemo(() => new Set(selection ?? all), [selection, all]);
  const toggle = (id: string) => {
    if (saved) { autosave.toggle(id, all); return; }
    const next = new Set(draft ?? all);
    if (next.has(id)) next.delete(id); else next.add(id);
    setDraft([...next]);
  };
  return <section className="preferences-section" data-model-visibility>
    <div className="preferences-section-heading"><h3>显示的模型</h3><span className="preferences-status">{selection === null ? '全部模型' : `已选 ${selection.length} 个`}</span></div>
    <fieldset>
      <ModelSelection models={all} selected={selected} label="选择显示的模型" disabled={loading} allowCustom onSelect={toggle}/>
      {loading && <span role="status" className="preferences-status">获取中…</span>}
      {(autosave.busy || notice) && <span role="status" className="preferences-status">{autosave.busy ? '保存中…' : notice}</span>}
      {saved && autosave.error && <p role="alert" className="model-error">{autosave.error}</p>}
    </fieldset>
    {error && <p role="alert" className="model-error">{error} <button type="button" disabled={loading} onClick={() => void load()}>重试获取</button></p>}
  </section>;
}
