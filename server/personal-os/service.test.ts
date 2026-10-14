import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { serviceOptions, serviceVault, serviceLock } from "./service.ts";

const directories: string[] = [];
function fixture() { const dir = mkdtempSync(path.join(os.tmpdir(), "nex-service-fixture-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("preserves the backend vault across restarts and never accepts a public or malformed key file", () => {
  const dir = fixture(), key = serviceVault(dir, "");
  expect(key).toHaveLength(32); expect(serviceVault(dir, "")).toEqual(key);
  if (process.platform !== "win32") expect(statSync(path.join(dir, "vault-key.bin")).mode & 0o077).toBe(0);
  expect(() => serviceVault(dir, "bad-key")).toThrow();
  const supplied = randomBytes(32).toString("base64"); expect(serviceVault(dir, supplied).toString("base64")).toBe(supplied);
  if (process.platform === "win32") return;
  const other = fixture(); symlinkSync(path.join(dir, "vault-key.bin"), path.join(other, "vault-key.bin"));
  expect(() => serviceVault(other, "")).toThrow("私有文件");
});
it("excludes a second service from the same database, then releases only its own lock", () => {
  const dir = fixture(), release = serviceLock(dir);
  expect(() => serviceLock(dir)).toThrow("已有后端");
  const original = readFileSync(path.join(dir, "service.lock"), "utf8");
  writeFileSync(path.join(dir, "service.lock"), JSON.stringify({ pid: process.pid, nonce: "another-owner" }));
  release(); expect(readFileSync(path.join(dir, "service.lock"), "utf8")).toContain("another-owner");
  writeFileSync(path.join(dir, "service.lock"), original); release();
  const next = serviceLock(dir); next();
});
it("restricts test identity to an explicit disposable directory and validates listening configuration", () => {
  const dir = fixture();
  expect(serviceOptions(["start", `--data-dir=${dir}`], {})).toMatchObject({ host: "127.0.0.1", port: 8799 });
  expect(serviceOptions(["init", "--fixture", `--data-dir=${dir}`], { NEX_IDENTITY_FIXTURE_URL: "http://127.0.0.1:5555" })).toMatchObject({ command: "init", fixtureOrigin: "http://127.0.0.1:5555" });
  expect(() => serviceOptions(["start", `--data-dir=${dir}`], { NEX_IDENTITY_FIXTURE_URL: "http://127.0.0.1:5555" })).toThrow("生产后端");
  expect(() => serviceOptions(["start", "--fixture", "--data-dir=/tmp/regular-service"], { NEX_IDENTITY_FIXTURE_URL: "http://127.0.0.1:5555" })).toThrow();
  expect(() => serviceOptions(["start", "--host=example.com"], {})).toThrow();
  expect(() => serviceOptions(["start", "--port=NaN"], {})).toThrow();
});
