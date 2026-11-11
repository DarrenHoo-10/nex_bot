import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type Owner = "stock" | "paused" | "core";
type Channel = { appId: string; version: number; owner: Owner; reports?: {error?: string} };
const names = {stock: "nex_stock", core: "NexBot", paused: "已暂停"} as const;

export function FinanceChannelSettings({appId}: {appId: string}) {
  const [channel, setChannel] = useState<Channel>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const value = await api<Channel>("finance/channel", undefined, signal);
    if (value.appId === appId) setChannel(value);
  }, [appId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => controller.abort();
  }, [load]);

  async function transfer(owner: Owner) {
    if (!channel || busy) return;
    setBusy(true); setError("");
    try {
      const next = await api<Channel>("finance/channel", {appId, expectedVersion:channel.version, owner});
      setChannel(next);
    } catch (e) {
      const reason = e instanceof Error ? e.message : "通道切换失败";
      setError(reason.includes("FINANCE_STOCK_RECEIVER_STILL_RUNNING")
        ? "原飞书连接仍在运行。保持暂停，重启承载旧接收器的 Stock 进程后，再交给 NexBot。"
        : reason);
      await load().catch(() => {});
    } finally { setBusy(false); }
  }

  return <div aria-label="金融飞书通道">
    {channel && <><p>当前收发方 · <strong>{names[channel.owner]}</strong></p>
      <div className="actions">{channel.owner === "paused" ? <>
        <button disabled={busy} onClick={() => void transfer("core")}>交给 NexBot</button>
        <button disabled={busy} onClick={() => void transfer("stock")}>交给 nex_stock</button>
      </> : <button disabled={busy} onClick={() => void transfer("paused")}>暂停收发以切换</button>}</div>
      {channel.reports?.error && <p role="status">报告同步 · {channel.reports.error}</p>}
    </>}
    {error && <p role="alert" className="connector-feedback is-error">{error}</p>}
  </div>;
}
