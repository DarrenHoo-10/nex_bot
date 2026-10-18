import { useEffect, useMemo, useRef, useState } from 'react';
import { api, listModels, str, type State } from './api';
import { ModelList } from './components/ModelPicker';

export function ModelVisibility({ state, refresh, active }: { state: State; refresh: () => Promise<void>; active: boolean }) {
  const [models, setModels] = useState<string[]>([]), [selection, setSelection] = useState<string[] | null>(state.modelVisibility?.models ?? null);
  const [version, setVersion] = useState(state.modelVisibility?.version ?? 0), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState(''), [custom, setCustom] = useState(''), [onlySelected, setOnlySelected] = useState(false), [dirty, setDirty] = useState(false);
  const alive = useRef(true), loaded = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!dirty) { setSelection(state.modelVisibility?.models ?? null); setVersion(state.modelVisibility?.version ?? 0); } }, [state.modelVisibility?.version, dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = async () => {
    if (loading) return; setLoading(true); setError('');
    try { const result = await listModels({ provider: str(state.config?.provider_id), endpoint: str(state.config?.endpoint), apiKey: '' }); if (alive.current) { setModels(result.models); setNotice(result.hasMore ? '服务仍有未返回的模型，可手动添加。' : ''); } }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '获取失败'); }
    finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => { if (active && !loaded.current) { loaded.current = true; void load(); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => [...new Set([...models, ...(selection ?? []), str(state.config?.default_model)].filter(Boolean))].sort(), [models, selection, state.config?.default_model]);
  const selected = useMemo(() => new Set(selection ?? all), [selection, all]);
  const edit = (value: string[] | null) => { setSelection(value); setDirty(true); setNotice(''); };
  const save = async () => {
    setBusy(true); setError('');
    try { const result = await api<{ models: string[] | null; version: number }>('models/visibility', { provider: state.config?.provider_id, endpoint: state.config?.endpoint, models: selection, version }); if (!alive.current) return; setVersion(result.version); setSelection(result.models); await refresh(); if (alive.current) { setDirty(false); setNotice('已保存'); } }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '保存失败'); }
    finally { if (alive.current) setBusy(false); }
  };
  return <section className="preferences-section" data-model-visibility>
    <div className="preferences-section-heading"><h3>显示的模型</h3><span className="preferences-status">{selection === null ? '全部显示' : `已选 ${selection.length} 个`}</span></div>
    <fieldset disabled={busy}>
      <div className="model-visibility-tools"><button type="button" onClick={() => edit(null)}>全部显示</button><button type="button" onClick={() => edit([])}>清空选择</button><button type="button" aria-pressed={onlySelected} onClick={() => setOnlySelected(!onlySelected)}>{onlySelected ? '查看全部' : '只看已选'}</button><button type="button" disabled={loading} onClick={() => void load()}>{loading ? '获取中…' : '刷新目录'}</button></div>
      <div className="model-visibility-list"><ModelList models={onlySelected ? [...selected] : all} selected={selected} onSelect={id => { if (busy) return; const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); edit([...next]); }}/></div>
      <div className="preferences-actions model-visibility-tools"><input aria-label="添加模型 ID" placeholder="手动添加模型 ID" value={custom} maxLength={200} onChange={e => setCustom(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (custom.trim()) { edit([...new Set([...selected, custom.trim()])]); setCustom(''); } } }}/><button type="button" disabled={!custom.trim()} onClick={() => { edit([...new Set([...selected, custom.trim()])]); setCustom(''); }}>添加</button></div>
      <div className="preferences-actions"><button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存显示模型'}</button>{notice && <span role="status">{notice}</span>}</div>
    </fieldset>
    {error && <p role="alert" className="model-error">{error}</p>}
  </section>;
}
