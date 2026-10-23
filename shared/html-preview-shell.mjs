// A trusted outer document owns the inner frame's navigation policy. A CSP in
// the generated document alone cannot prevent that document navigating itself.
export const HTML_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";

function contentBootstrap() {
  // WebRTC is not consistently covered by connect-src across WebViews. Remove
  // its constructors before any generated script, including legacy aliases.
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false });
  }
  const send = (type, height) => parent.postMessage({ channel: 'nex-html-content', type, height }, '*');
  let scheduled = false, previous = 0;
  const measure = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const height = Math.ceil(Math.max(document.body?.scrollHeight ?? 0, document.body?.getBoundingClientRect().height ?? 0) + 24);
      if (height > 0 && height !== previous) { previous = height; send('resize', height); }
    }, 100);
  };
  addEventListener('error', () => send('error'));
  addEventListener('unhandledrejection', () => send('error'));
  addEventListener('keydown', event => { if (event.key === 'Escape') send('escape'); });
  addEventListener('DOMContentLoaded', () => {
    send('ready'); measure();
    new ResizeObserver(measure).observe(document.body);
    new MutationObserver(measure).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  addEventListener('resize', measure);
}

function previewHost(bootstrap, policy) {
  let frame, id = '', lastResize = 0, failed = false;
  const send = (type, height) => parent.postMessage({ channel: 'nex-html-preview', id, type, height }, '*');
  addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (event.source === parent && data.channel === 'nex-html-init' && !frame) {
      if (typeof data.source !== 'string' || data.source.length > 500_000 || typeof data.id !== 'string' || data.id.length > 128) return;
      id = data.id;
      frame = document.createElement('iframe');
      frame.title = '交互内容';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'");
      frame.referrerPolicy = 'no-referrer';
      let loaded = false;
      frame.addEventListener('load', () => {
        if (loaded) { failed = true; send('error'); frame.remove(); }
        loaded = true;
      });
      // First policy wins; a later model-supplied CSP can only restrict it.
      const prefix = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy.replace('frame-src data:', "frame-src 'none'") + '"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light}body{margin:12px;font:14px system-ui;overflow-wrap:anywhere}*{box-sizing:border-box}</style><script>' + bootstrap + '<' + '/script></head><body>';
      const bytes = new TextEncoder().encode(prefix + data.source);
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      frame.src = 'data:text/html;base64,' + btoa(binary);
      document.body.append(frame);
      return;
    }
    if (!frame || event.source !== frame.contentWindow || data.channel !== 'nex-html-content') return;
    if (data.type === 'error') { if (!failed) send('error'); failed = true; }
    if (data.type === 'ready' && !failed) send('ready');
    if (data.type === 'escape') send('escape');
    if (data.type === 'resize' && typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0 && Date.now() - lastResize >= 80) {
      lastResize = Date.now(); send('resize', Math.min(900, Math.max(160, Math.ceil(data.height))));
    }
  });
}

/** Identical trusted shell is served by Core and bundled in Android/Apple. */
export function htmlPreviewShell() {
  const bootstrap = `(${contentBootstrap.toString()})()`;
  const script = `(${previewHost.toString()})(${JSON.stringify(bootstrap)},${JSON.stringify(HTML_PREVIEW_CSP)})`;
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + HTML_PREVIEW_CSP + '"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%;background:white}</style></head><body><script>' + script.replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
}
