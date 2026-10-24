import { useEffect, useMemo, useRef, useState } from 'react';
import { HTML_PREVIEW_LIMIT, previewHeight } from '../../../shared/html-preview';
import './html-preview.css';

export function HtmlPreview({ source, pending, complete }: { source: string; pending: boolean; complete: boolean }) {
  const [run, setRun] = useState(0), [stopped, setStopped] = useState(false), [fullscreen, setFullscreen] = useState(false);
  const [status, setStatus] = useState('加载中'), [height, setHeight] = useState(240);
  const iframe = useRef<HTMLIFrameElement>(null), container = useRef<HTMLElement>(null), expand = useRef<HTMLButtonElement>(null);
  const id = useMemo(() => crypto.randomUUID(), [source, run]);
  const runnable = !pending && complete && source.length <= HTML_PREVIEW_LIMIT && !stopped;
  useEffect(() => { setStatus('加载中'); setHeight(240); }, [id]);
  useEffect(() => { setStopped(false); }, [source]);
  useEffect(() => {
    if (!runnable) return;
    let last = 0;
    const timer = setTimeout(() => setStatus(current => current === '加载中' ? '加载超时' : current), 10_000);
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== iframe.current?.contentWindow || !data || data.channel !== 'nex-html-preview' || data.id !== id) return;
      if (data.type === 'ready') { clearTimeout(timer); setStatus(current => current === '运行出错' ? current : ''); }
      if (data.type === 'error') { clearTimeout(timer); setStatus('运行出错'); }
      if (data.type === 'escape') setFullscreen(false);
      const next = previewHeight(data.height);
      if (data.type === 'resize' && next !== undefined && Date.now() - last >= 80) { last = Date.now(); setHeight(next); }
    };
    window.addEventListener('message', receive);
    return () => { clearTimeout(timer); window.removeEventListener('message', receive); };
  }, [id, runnable]);
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; expand.current?.focus();
    const close = () => setFullscreen(false);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const focusable = container.current?.querySelectorAll<HTMLElement>('button,iframe,summary');
        const first = focusable?.[0], last = focusable?.[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [fullscreen]);
  const label = pending ? '生成中' : !complete ? '内容未完成' : source.length > HTML_PREVIEW_LIMIT ? '内容过大' : stopped ? '已停止' : status;
  return <section ref={container} className={`html-preview${fullscreen ? ' html-preview-fullscreen' : ''}`} role={fullscreen ? 'dialog' : 'group'} aria-modal={fullscreen || undefined} aria-label="HTML 预览">
    <div className="html-preview-toolbar"><span>预览</span><span className="html-preview-status" role="status">{label}</span>
      {runnable && <button type="button" onClick={() => setStopped(true)}>停止</button>}
      {!pending && complete && source.length <= HTML_PREVIEW_LIMIT && <button type="button" onClick={() => { setStopped(false); setRun(value => value + 1); }}>重新运行</button>}
      <button type="button" ref={expand} onClick={() => setFullscreen(value => !value)} aria-label={fullscreen ? '退出全屏' : '全屏预览'}>{fullscreen ? '退出全屏' : '全屏'}</button>
    </div>
    {runnable && <iframe key={id} ref={iframe} title="HTML 交互预览" src="/html-preview.html" sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" style={{ height: fullscreen ? undefined : height }} onLoad={() => iframe.current?.contentWindow?.postMessage({ channel: 'nex-html-init', id, source }, '*')}/>}
    <details className="html-preview-source"><summary>源码</summary><pre><code>{source}</code></pre></details>
  </section>;
}
