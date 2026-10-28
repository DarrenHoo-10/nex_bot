import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { CALIBRATION, ModelCalibration, nextRatio } from './calibration.ts';

const scope = { provider: 'openai', endpoint: 'https://api.example.com/v1', model: 'm1' };
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('nex-calibration-')) throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function table() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nex-calibration-'));
  dirs.push(dir);
  const db = new DatabaseSync(path.join(dir, 'core.db'));
  dbs.push(db);
  db.exec('CREATE TABLE model_calibration(provider TEXT NOT NULL,endpoint TEXT NOT NULL,model TEXT NOT NULL,ratio REAL NOT NULL,samples INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(provider,endpoint,model)) STRICT');
  const store = { get: (sql: string, ...args: never[]) => db.prepare(sql).get(...args) as never, run: (sql: string, ...args: never[]) => db.prepare(sql).run(...args) };
  return { db, calibration: new ModelCalibration(store) };
}

it('seeds with the first sample, then moves by alpha 0.2 and stays inside [0.3, 1.5]', () => {
  expect(nextRatio(undefined, 600, 1000)).toBeCloseTo(0.6);
  expect(nextRatio(0.6, 1000, 1000)).toBeCloseTo(0.6 * 0.8 + 0.2);
  expect(nextRatio(undefined, 1, 10000)).toBe(CALIBRATION.min);
  expect(nextRatio(undefined, 50000, 2000)).toBe(CALIBRATION.max);
  expect(nextRatio(1.5, 1_000_000, 2000)).toBe(CALIBRATION.max);
  expect(nextRatio(0.3, 1, 1_000_000)).toBe(CALIBRATION.min);
  let ratio: number | undefined;
  for (let i = 0; i < 60; i++) ratio = nextRatio(ratio, 5000, 10000);
  expect(ratio).toBeCloseTo(0.5, 6);
});

it('persists the ratio per provider, endpoint and model with a sample count', () => {
  const { db, calibration } = table();
  expect(calibration.ratio(scope)).toBe(1);
  expect(calibration.record(scope, 3000, 6000)).toBeCloseTo(0.5);
  expect(calibration.record(scope, 4000, 5000)).toBeCloseTo(0.5 * 0.8 + 0.8 * 0.2);
  expect(calibration.ratio(scope)).toBeCloseTo(0.56);
  expect(db.prepare('SELECT samples FROM model_calibration').get()!.samples).toBe(2);
  expect(calibration.ratio({ ...scope, model: 'm2' })).toBe(1);
  expect(calibration.ratio({ ...scope, endpoint: 'https://other.example.com/v1' })).toBe(1);
  expect(calibration.ratio({ ...scope, provider: 'anthropic' })).toBe(1);
  calibration.record({ ...scope, model: 'm2' }, 9000, 6000);
  expect(calibration.ratio({ ...scope, model: 'm2' })).toBe(1.5);
  expect(calibration.ratio(scope)).toBeCloseTo(0.56);
});

it('ignores small estimates and unusable counts', () => {
  const { db, calibration } = table();
  expect(calibration.record(scope, 100, CALIBRATION.minEstimate - 1)).toBeUndefined();
  expect(calibration.record(scope, 0, 5000)).toBeUndefined();
  expect(calibration.record(scope, -5, 5000)).toBeUndefined();
  expect(calibration.record(scope, Number.NaN, 5000)).toBeUndefined();
  expect(calibration.record(scope, 5000, Number.POSITIVE_INFINITY)).toBeUndefined();
  expect(db.prepare('SELECT COUNT(*) n FROM model_calibration').get()!.n).toBe(0);
  expect(calibration.record(scope, 1000, CALIBRATION.minEstimate)).toBeCloseTo(0.5);
});
