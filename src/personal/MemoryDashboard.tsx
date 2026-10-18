import { useEffect, useRef, useState } from 'react';
import { api, listModels, str, type State } from './api';
import { ModelPicker } from './components/ModelPicker';

type Summary = { enabled: number; model: string; version: number; totalTokens: number; incomplete: boolean };
export function MemoryDashboard({ state, active }: { state: State; active: boolean }) {
  const [summary, setSummary] = useState<Summary>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), saving = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setSummary(undefined); setError('');
    if (!active) return;
    const load = async () => {
      if (saving.current) return;
      try {
        const value = await api<Summary>('memory/summary', {});
        if (generation.current === current && !saving.current) {
          setSummary(previous => !previous || value.version >= previous.version ? value : previous);
          setError('');
        }
      } catch (failure) {
        if (generation.current === current) setError(failure instanceof Error ? failure.message : '读取失败');
      }
    };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { generation.current++; clearInterval(timer); };
  }, [active, state.sync.privacyEpoch]);
  async function save(change: { enabled?: boolean; model?: string }) {
    if (!summary || saving.current) return;
    const current = generation.current;
    saving.current = true; setBusy(true); setError('');
    try {
      const value = await api<Summary>('memory/settings', { enabled: !!summary.enabled, model: summary.model, ...change, version: summary.version });
      if (generation.current === current) setSummary(value);
    } catch (failure) {
      if (generation.current === current) {
        setError(failure instanceof Error ? failure.message : '保存失败');
        try {
          const value = await api<Summary>('memory/summary', {});
          if (generation.current === current) setSummary(value);
        } catch { /* Keep the last confirmed value until the next poll. */ }
      }
    } finally { saving.current = false; setBusy(false); }
  }
  return <section className="preferences-section memory-dashboard" data-memory-dashboard>
    <label className="preferences-toggle"><strong>开启长期记忆</strong><input type="checkbox" role="switch" name="personalMemoryEnabled" checked={!!summary?.enabled} disabled={!summary || busy} onChange={event => void save({ enabled: event.target.checked })}/></label>
    <p className="muted">开启后会增加 Token 消耗。</p>
    <div className="field"><span>记忆模型</span><ModelPicker key={JSON.stringify([state.config?.provider_id,state.config?.endpoint])} name="personalMemoryModel" label="选择记忆模型" value={summary?.model ?? ''} emptyLabel={`默认模型 · ${state.config?.default_model || '未配置'}`} disabled={!summary || busy} models={state.modelVisibility?.models} loadModels={()=>listModels({provider:str(state.config?.provider_id),endpoint:str(state.config?.endpoint),apiKey:''})} onChange={model=>void save({model})}/></div>
    <div className="memory-stats"><article><small>总 Token</small><strong data-memory-total>{summary ? `${summary.incomplete ? '≥ ' : ''}${summary.totalTokens.toLocaleString()}` : '—'}</strong></article></div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
