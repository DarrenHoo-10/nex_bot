import type { CoreStore } from "./store.ts";

// The offline estimate is conservative (about 1.5-2x too high for Chinese). Provider receipts
// calibrate it per model; the ratio only decides when context reduction starts, never whether a request fits.
export const CALIBRATION = { alpha: 0.2, min: 0.3, max: 1.5, minEstimate: 2000 } as const;
export interface ModelScope { provider: string; endpoint: string; model: string }

const clamp = (value: number) => Math.min(CALIBRATION.max, Math.max(CALIBRATION.min, value));
/** EMA of real/estimate, seeded by the first sample and always kept within the clamp. */
export function nextRatio(previous: number | undefined, real: number, estimate: number): number {
  const sample = real / estimate;
  return clamp(previous === undefined ? sample : previous * (1 - CALIBRATION.alpha) + sample * CALIBRATION.alpha);
}

export class ModelCalibration {
  constructor(private readonly store: Pick<CoreStore, "get" | "run">) {}
  /** 1 (no correction) until a receipt has been recorded. */
  ratio(scope: ModelScope): number {
    const row = this.store.get("SELECT ratio FROM model_calibration WHERE provider=? AND endpoint=? AND model=?", scope.provider, scope.endpoint, scope.model);
    return row ? Number(row.ratio) : 1;
  }
  /** Records one known-usage receipt; small requests and unusable counts are ignored. Returns the new ratio. */
  record(scope: ModelScope, real: number, estimate: number): number | undefined {
    if (!Number.isFinite(real) || real <= 0 || !Number.isFinite(estimate) || estimate < CALIBRATION.minEstimate) return undefined;
    const row = this.store.get("SELECT ratio FROM model_calibration WHERE provider=? AND endpoint=? AND model=?", scope.provider, scope.endpoint, scope.model);
    const ratio = nextRatio(row ? Number(row.ratio) : undefined, real, estimate);
    this.store.run("INSERT INTO model_calibration(provider,endpoint,model,ratio,samples,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(provider,endpoint,model) DO UPDATE SET ratio=excluded.ratio,samples=samples+1,updated_at=excluded.updated_at", scope.provider, scope.endpoint, scope.model, ratio, Date.now());
    return ratio;
  }
}
