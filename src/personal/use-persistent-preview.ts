import { useEffect, useState, type RefObject } from "react";
import { cliImageId } from "../../shared/cli-images";
import { localCacheScope, queueLocalCache, readLocalCache } from "./local-content-cache";

export function usePersistentPreview(url: string, target: RefObject<HTMLElement | null>) {
  const [preview, setPreview] = useState<{ url: string; source: string; scope: string | undefined }>();
  const scope = localCacheScope();
  const eligible = !!scope && (!!cliImageId(url) || /^\/api\/attachments\/[a-zA-Z0-9_-]+\?preview=1$/.test(url));
  useEffect(() => {
    if (!eligible) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    const load = async () => {
      let bytes = await readLocalCache<Blob>(scope, "image:" + url, true);
      if (abort.signal.aborted || scope !== localCacheScope()) return;
      if (!bytes) {
        const response = await fetch(url, { signal: abort.signal, credentials: "same-origin", redirect: "error" });
        if (!response.ok) throw new Error(String(response.status));
        bytes = await response.blob();
        if (abort.signal.aborted || scope !== localCacheScope()) return;
        if (/^image\/(?:png|jpeg|webp)$/.test(bytes.type) && bytes.size <= 2 * 1024 * 1024) queueLocalCache(scope, "image:" + url, bytes);
      }
      objectUrl = URL.createObjectURL(bytes);
      setPreview({ url, scope, source: objectUrl });
    };
    const start = () => void load().catch(() => { if (!abort.signal.aborted) setPreview({ url, scope, source: url }); });
    const observer = typeof IntersectionObserver === "function" && target.current
      ? new IntersectionObserver((entries) => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); start(); } })
      : undefined;
    if (observer && target.current) observer.observe(target.current);
    else start();
    return () => { abort.abort(); observer?.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [eligible, scope, target, url]);
  return eligible ? (preview?.url === url && preview.scope === scope ? preview.source : undefined) : url;
}
