import { randomUUID } from "node:crypto";
import { CoreStore } from "./store.ts";

export class ClientSync {
  readonly bootId = randomUUID();
  constructor(readonly store: CoreStore) {}
  snapshot() {
    return { cursor: Number(this.store.get("SELECT COALESCE(MAX(seq),0) seq FROM sync_events")!.seq), privacyEpoch: Number(this.store.get("SELECT privacy_epoch FROM sync_state WHERE id=1")!.privacy_epoch), coreId: String(this.store.get("SELECT core_id FROM workspaces WHERE id=?", this.store.workspace)!.core_id), bootId: this.bootId };
  }
  event(after: number) {
    const state = this.snapshot(), min = Number(this.store.get("SELECT COALESCE(MIN(seq),0) seq FROM sync_events")!.seq);
    return { ...state, reset: !Number.isSafeInteger(after) || after < min - 1 || after > state.cursor };
  }
  prune() { const { cursor } = this.snapshot(); if (cursor > 10_000) this.store.run("DELETE FROM sync_events WHERE seq<?", cursor - 10_000); }
}
