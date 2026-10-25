import { useEffect, useRef, useState } from 'react';
import { api } from './api';

type Selection = { models: string[] | null; version: number };

export function useModelSelection(route: string, scope: { provider: unknown; endpoint: unknown }, initial: Selection, refresh: () => Promise<void>) {
  const [selection, setSelection] = useState(initial.models), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const confirmed = useRef(initial), draft = useRef(initial.models), revision = useRef(0), saving = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!saving.current && initial.version > confirmed.current.version) {
      confirmed.current = initial; draft.current = initial.models; setSelection(initial.models);
    }
  }, [initial.version, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      // Serialize writes, keeping rapid selections in the draft until the previous
      // response supplies the next version. Continue pending writes after navigation.
      for (;;) {
        const sent = revision.current;
        const result = await api<Selection>(route, { ...scope, models: draft.current, version: confirmed.current.version });
        confirmed.current = result;
        if (sent === revision.current) {
          draft.current = result.models;
          if (alive.current) { setSelection(result.models); }
          break;
        }
      }
    } catch (error) {
      draft.current = confirmed.current.models;
      if (alive.current) { setSelection(draft.current); setError(`未保存：${error instanceof Error ? error.message : '请重新选择'}`); }
    } finally {
      saving.current = false;
      if (alive.current) { setBusy(false); void refresh().catch(() => {}); }
    }
  };
  const toggle = (model: string, all: string[]) => {
    const next = new Set(draft.current ?? all);
    if (next.has(model)) next.delete(model); else next.add(model);
    draft.current = [...next]; revision.current++; setSelection(draft.current); setError('');
    void persist();
  };
  return { selection, toggle, busy, error };
}
