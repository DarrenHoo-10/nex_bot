import { useEffect, useRef, useState } from "react";
import { api } from "./api";

interface Limits {
  manual: { contextWindow: number | null; maxOutputTokens: number | null };
  contextWindow: number; maxOutputTokens: number;
  source: { contextWindow: string; maxOutputTokens: string };
  status: string; matched: string | null; refresh?: string;
  automatic: { contextWindow: number; maxOutputTokens: number; source: { contextWindow: string; maxOutputTokens: string } };
}

export function ModelLimitsFields({ provider, endpoint, model, scopeKey, active, onReady, onEdit }: {
  provider: string; endpoint: string; model: string; scopeKey: string; active: boolean;
  onReady: (key: string) => void; onEdit: () => void;
}) {
  const [limits, setLimits] = useState<Limits>();
  const [context, setContext] = useState(""), [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const edited = useRef({ context: false, output: false });
  useEffect(() => {
    if (!active || !model.trim()) return;
    let cancelled = false;
    const apply = (value: Limits) => {
      if (cancelled) return;
      setLimits(value);
      if (!edited.current.context) setContext(value.manual.contextWindow?.toString() ?? "");
      if (!edited.current.output) setOutput(value.manual.maxOutputTokens?.toString() ?? "");
    };
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const scope = { provider, endpoint, model };
          const cached = await api<Limits>("models/limits", scope);
          if (cancelled) return;
          apply(cached); onReady(scopeKey); setError("");
          if (cached.manual.contextWindow !== null && cached.manual.maxOutputTokens !== null && !retry) return;
          setLoading(true);
          const result = await api<Limits>("models/limits/refresh", { ...scope, force: retry > 0 });
          if (cancelled) return;
          apply(result);
          if (result.refresh === "failed") setError("联网识别失败，使用缓存或默认值");
        } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : "读取模型参数失败"); }
        finally { if (!cancelled) setLoading(false); }
      })();
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [provider, endpoint, model, scopeKey, active, onReady, retry]);
  const source = (field: "contextWindow" | "maxOutputTokens") => limits?.automatic.source[field] === "models.dev" ? "models.dev" : "默认";
  const autoContext = limits?.automatic.contextWindow;
  const autoOutput = limits && Math.min(limits.automatic.maxOutputTokens, context ? Number(context) : limits.automatic.contextWindow);
  return <div className="model-limits" data-model-limits>
    <div className="preferences-section-heading"><h3>模型参数</h3><button type="button" disabled={loading || !model.trim()} onClick={() => setRetry(value => value + 1)}>{loading ? "识别中…" : "联网识别"}</button></div>
    <div className="preferences-form-grid">
      <label className="field">上下文窗口（Token）<input name="contextWindow" type="number" min="1024" max="10000000" step="1" disabled={!limits} value={context} placeholder={autoContext ? `自动 · ${autoContext.toLocaleString()}` : "读取中…"} onChange={event => { edited.current.context = true; setContext(event.target.value); onEdit(); }}/><small>{context ? "手动配置" : `${source("contextWindow")} · ${autoContext?.toLocaleString() ?? "—"}`}</small></label>
      <label className="field">最大输出 Token<input name="maxOutputTokens" type="number" min="1" max={context ? Number(context) : autoContext ?? 10000000} step="1" disabled={!limits} value={output} placeholder={autoOutput ? `自动 · ${autoOutput.toLocaleString()}` : "读取中…"} onChange={event => { edited.current.output = true; setOutput(event.target.value); onEdit(); }}/><small>{output ? "手动配置" : `${source("maxOutputTokens")} · ${autoOutput?.toLocaleString() ?? "—"}`}</small></label>
    </div>
    <small role="status">{limits?.status === "ambiguous" ? "目录中存在不同配置，请手动填写" : limits?.status === "unknown" ? "未识别到此模型，使用默认值；可手动填写" : "留空自动识别，手动值优先"}</small>
    {error && <small className="model-error" role="alert">{error}</small>}
  </div>;
}
