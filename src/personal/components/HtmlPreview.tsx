import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { HTML_PREVIEW_LIMIT, previewHeight } from '../../../shared/html-preview';

function PreviewFrame({ source, onStatus, fill = false }: { source: string; onStatus?: Dispatch<SetStateAction<string>>; fill?: boolean }) {
  const [height, setHeight] = useState(240);
  const iframe = useRef<HTMLIFrameElement>(null);
  const id = useMemo(() => crypto.randomUUID(), [source]);
  useEffect(() => { setHeight(240); onStatus?.('加载中'); }, [id, onStatus]);
  useEffect(() => {
    if (!onStatus) return undefined;
    let last = 0;
    const timer = setTimeout(() => onStatus(current => current === '加载中' ? '加载超时' : current), 10_000);
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== iframe.current?.contentWindow || !data || data.channel !== 'nex-html-preview' || data.id !== id) return;
      if (data.type === 'ready') { clearTimeout(timer); onStatus(current => current === '运行出错' ? current : ''); }
      if (data.type === 'error') { clearTimeout(timer); onStatus('运行出错'); }
      const next = previewHeight(data.height);
      if (data.type === 'resize' && next !== undefined && Date.now() - last >= 80) { last = Date.now(); setHeight(next); }
    };
    window.addEventListener('message', receive);
    return () => { clearTimeout(timer); window.removeEventListener('message', receive); };
  }, [id, onStatus]);
  return <iframe key={id} ref={iframe} title="HTML 交互预览" src="/html-preview.html" sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" style={fill ? undefined : { height }} onLoad={() => iframe.current?.contentWindow?.postMessage({ channel: 'nex-html-init', id, source }, '*')}/>;
}

export function HtmlPreview({ source, pending, complete }: { source: string; pending: boolean; complete: boolean }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [status, setStatus] = useState('加载中');
  const expand = useRef<HTMLButtonElement>(null), close = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLElement>(null);
  const runnable = !pending && complete && source.length <= HTML_PREVIEW_LIMIT;
  const label = pending ? '生成中' : !complete ? '内容未完成' : source.length > HTML_PREVIEW_LIMIT ? '内容过大' : status;
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
      if (event.key === 'Tab') {
        const focusable = dialog.current?.querySelectorAll<HTMLElement>('button,iframe');
        const first = focusable?.[0], last = focusable?.[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [fullscreen]);
  return <section className="html-preview" aria-label="HTML 预览">
    <div className="html-preview-toolbar"><span className="html-preview-status" role="status">{label}</span>
      {runnable && <button type="button" ref={expand} onClick={() => setFullscreen(true)} aria-haspopup="dialog" aria-label="全屏预览">全屏</button>}
    </div>
    {runnable && <PreviewFrame source={source} onStatus={setStatus}/>}
    {fullscreen && runnable && createPortal(
      <div className="html-preview-overlay">
        <section ref={dialog} className="html-preview-dialog" role="dialog" aria-modal="true" aria-label="HTML 全屏预览">
          <div className="html-preview-dialog-heading"><span className="html-preview-status" role="status">{label}</span><button type="button" ref={close} onClick={() => setFullscreen(false)} aria-label="关闭全屏预览">关闭</button></div>
          <PreviewFrame source={source} fill/>
        </section>
      </div>, document.body)}
  </section>;
}
