import { createHmac } from "node:crypto";

/**
 * Client updates served from the private OSS release mirror. A release script
 * uploads each installer under `nexbot/releases/<tag>/` and rewrites
 * `nexbot/releases/manifest.json`; Core reads that manifest and hands clients
 * short-lived signed download URLs, so installers download quickly in China
 * without GitHub and without exposing OSS credentials.
 */
export const updatePlatforms = ["windows", "android", "mac", "ios"] as const;
export type UpdatePlatform = typeof updatePlatforms[number];
export interface ReleaseFile { version: string; file: string; key: string; size: number; sha256: string }
export interface ReleaseManifest { version: 1; tag: string; publishedAt: string; notes: string; platforms: Partial<Record<UpdatePlatform, ReleaseFile>> }
export interface ClientUpdate { platform: UpdatePlatform; current: string; available: boolean; version?: string; file?: string; size?: number; sha256?: string; url?: string; notes?: string; tag?: string; publishedAt?: string }

export const manifestKey = "nexbot/releases/manifest.json";
const releaseKey = /^nexbot\/releases\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const semver = /^\d+\.\d+\.\d+$/;
/** OSS refuses to serve .apk/.ipa from its default domain (ApkDownloadForbidden), so Core relays these. */
export const relayedPlatforms: ReadonlySet<UpdatePlatform> = new Set(["android", "ios"]);
const installerTypes: Record<string, string> = { android: "application/vnd.android.package-archive", ios: "application/octet-stream" };

/** Numeric x.y.z comparison; anything malformed is never treated as newer. */
export function newerVersion(candidate: string, current: string) {
  if (!semver.test(candidate)) return false;
  if (!semver.test(current)) return true;
  const a = candidate.split(".").map(Number), b = current.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

/** Accepts only well-formed entries, so a bad manifest can never send a client elsewhere. */
export function parseManifest(value: unknown): ReleaseManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.tag !== "string" || !raw.platforms || typeof raw.platforms !== "object") return undefined;
  const platforms: ReleaseManifest["platforms"] = {};
  for (const platform of updatePlatforms) {
    const entry = (raw.platforms as Record<string, unknown>)[platform] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object") continue;
    const { version, file, key, size, sha256 } = entry;
    if (typeof version !== "string" || !semver.test(version) || typeof file !== "string" || typeof key !== "string" || !releaseKey.test(key) || !key.endsWith("/" + file)
      || !Number.isSafeInteger(size) || (size as number) < 1 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) continue;
    platforms[platform] = { version, file, key, size: size as number, sha256 };
  }
  return { version: 1, tag: raw.tag, publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : "", notes: typeof raw.notes === "string" ? raw.notes.slice(0, 2000) : "", platforms };
}

export class OssReleaseMirror {
  readonly origin: string;
  constructor(readonly config: { endpoint: string; bucket: string; accessKeyId: string; accessKeySecret: string }, readonly transport: typeof fetch = fetch, readonly now: () => number = Date.now) {
    const endpoint = new URL(config.endpoint.includes("://") ? config.endpoint : `https://${config.endpoint}`);
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) || endpoint.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)?oss-[a-z0-9-]+\.aliyuncs\.com$/.test(endpoint.hostname)) throw new Error("OSS 配置无效");
    if (!config.accessKeyId || !config.accessKeySecret) throw new Error("OSS 凭据缺失");
    this.origin = `https://${endpoint.hostname.startsWith(config.bucket + ".") ? endpoint.hostname : `${config.bucket}.${endpoint.hostname}`}`;
  }
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env) {
    if (!env.OSS_ENDPOINT || !env.OSS_BUCKET || !env.OSS_ACCESS_KEY_ID || !env.OSS_ACCESS_KEY_SECRET) return undefined;
    return new OssReleaseMirror({ endpoint: env.OSS_ENDPOINT, bucket: env.OSS_BUCKET, accessKeyId: env.OSS_ACCESS_KEY_ID, accessKeySecret: env.OSS_ACCESS_KEY_SECRET });
  }
  /** A GET URL valid for `seconds`, signed with OSS query-string authentication. */
  signedUrl(key: string, seconds = 3600) {
    if (key !== manifestKey && !releaseKey.test(key)) throw new Error("OSS 对象路径无效");
    const expires = Math.floor(this.now() / 1000) + seconds;
    const signature = createHmac("sha1", this.config.accessKeySecret).update(`GET\n\n\n${expires}\n/${this.config.bucket}/${key}`).digest("base64");
    return `${this.origin}/${key.split("/").map(encodeURIComponent).join("/")}?OSSAccessKeyId=${encodeURIComponent(this.config.accessKeyId)}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`;
  }
  /** Fetches a release object server-side; Core then streams it to the client. */
  async download(key: string) {
    if (!releaseKey.test(key)) throw new Error("OSS 对象路径无效");
    const response = await this.transport(this.signedUrl(key, 600), { redirect: "error", signal: AbortSignal.timeout(300_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`安装包返回 HTTP ${response.status}`); }
    return response;
  }
  async manifest() {
    const response = await this.transport(this.signedUrl(manifestKey, 120), { redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`发布清单返回 HTTP ${response.status}`); }
    return parseManifest(await response.json());
  }
}

export class ClientUpdateSource {
  private cached?: { value: ReleaseManifest | undefined; until: number };
  private pending?: Promise<ReleaseManifest | undefined>;
  constructor(readonly mirror: Pick<OssReleaseMirror, "manifest" | "signedUrl"> & Partial<Pick<OssReleaseMirror, "download">> | undefined, readonly now: () => number = Date.now) {}
  /** One shared lookup every five minutes; an outage keeps the last good manifest. */
  manifest(): Promise<ReleaseManifest | undefined> {
    if (!this.mirror) return Promise.resolve(undefined);
    const at = this.now();
    if (this.cached && this.cached.until > at) return Promise.resolve(this.cached.value);
    this.pending ??= this.mirror.manifest()
      .then((value) => { this.cached = { value, until: at + 5 * 60_000 }; return value; })
      .catch(() => { const value = this.cached?.value; this.cached = { value, until: at + 60_000 }; return value; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /** The mirror URL, or a Core path for installers OSS will not serve directly. */
  private url(platform: UpdatePlatform, entry: ReleaseFile, origin?: string) {
    return origin && relayedPlatforms.has(platform) ? `${origin}/api/client/installer/${platform}/${encodeURIComponent(entry.file)}` : this.mirror!.signedUrl(entry.key);
  }
  /** The current installer for a relayed platform, streamed from the mirror. Undefined when `file` is not current. */
  async installer(platform: string, file: string) {
    if (!relayedPlatforms.has(platform as UpdatePlatform) || !this.mirror?.download) return undefined;
    const entry = (await this.manifest())?.platforms[platform as UpdatePlatform];
    if (!entry || entry.file !== file) return undefined;
    return { entry, type: installerTypes[platform], response: await this.mirror.download(entry.key) };
  }
  async check(platform: string, current: string, origin?: string): Promise<ClientUpdate> {
    if (!updatePlatforms.includes(platform as UpdatePlatform)) throw new Error("不支持的平台");
    const target = platform as UpdatePlatform, version = String(current).slice(0, 40);
    const manifest = await this.manifest(), entry = manifest?.platforms[target];
    if (!manifest || !entry || !newerVersion(entry.version, version)) return { platform: target, current: version, available: false };
    return { platform: target, current: version, available: true, version: entry.version, file: entry.file, size: entry.size, sha256: entry.sha256, url: this.url(target, entry, origin), notes: manifest.notes, tag: manifest.tag, publishedAt: manifest.publishedAt };
  }
  /** The newest mirrored installer per platform, for the public download page. */
  async downloads(origin?: string) {
    const manifest = await this.manifest();
    if (!manifest) return undefined;
    const result: Partial<Record<UpdatePlatform, { name: string; url: string; size: number; version: string; tag: string; publishedAt: string; sha256: string }>> = {};
    for (const platform of updatePlatforms) {
      const entry = manifest.platforms[platform];
      if (entry) result[platform] = { name: entry.file, url: this.url(platform, entry, origin), size: entry.size, version: entry.version, tag: manifest.tag, publishedAt: manifest.publishedAt, sha256: entry.sha256 };
    }
    return result;
  }
}
