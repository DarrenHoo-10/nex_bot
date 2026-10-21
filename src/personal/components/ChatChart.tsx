import { useEffect, useMemo, useRef } from 'react';
import { bindCharts, chartCSS, renderChart } from '../../../shared/chat-charts';

export function ChatChart({ source }: { source: string }) {
  const root = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderChart(source), [source]);
  useEffect(() => root.current ? bindCharts(root.current) : undefined, []);
  // Only our renderer emits markup; every model-provided string is escaped.
  return <div ref={root} className="chat-chart"><style>{chartCSS}</style><div dangerouslySetInnerHTML={{ __html: html }}/></div>;
}
