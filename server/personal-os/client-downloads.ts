/** Public client downloads for the web homepage. Every release is a GitHub
 * prerelease, so `releases/latest` never resolves; Core reads the release list
 * itself because the page's CSP keeps the browser on its own origin. */
const repository = "DarrenHoo-10/nex_bot";
export const releasesPage = `https://github.com/${repository}/releases`;
const releasesApi = `https://api.github.com/repos/${repository}/releases?per_page=20`;
const assetOrigin = `https://github.com/${repository}/releases/download/`;

export interface ClientDownload { name: string; url: string; size: number; version: string; tag: string; publishedAt: string }
export interface ClientDownloads { releasesPage: string; windows?: ClientDownload; android?: ClientDownload }
export interface ClientDownloadsOptions { fetch?: typeof fetch; now?: () => number; ttlMs?: number; failureTtlMs?: number }

interface GitHubAsset { name?: unknown; browser_download_url?: unknown; size?: unknown; state?: unknown }
interface GitHubRelease { draft?: unknown; tag_name?: unknown; published_at?: unknown; assets?: unknown }

const platforms = {
  windows: /^NexBot-(\d+\.\d+\.\d+)-x64-Client-Portable\.exe$/,
  // Unsigned APKs cannot be installed, so they are never offered.
  android: /^nexbot-(\d+\.\d+\.\d+)-(?!unsigned)[a-z]+\.apk$/,
} as const;

/** The newest published asset per platform; a release may carry only one platform. */
export function pickDownloads(releases: unknown): ClientDownloads {
  const result: ClientDownloads = { releasesPage };
  if (!Array.isArray(releases)) return result;
  for (const release of releases as Array<GitHubRelease | null>) {
    if (!release || typeof release !== "object" || release.draft !== false || typeof release.tag_name !== "string" || !Array.isArray(release.assets)) continue;
    for (const [platform, pattern] of Object.entries(platforms) as Array<[keyof typeof platforms, RegExp]>) {
      if (result[platform]) continue;
      for (const asset of release.assets as Array<GitHubAsset | null>) {
        if (!asset || typeof asset.name !== "string") continue;
        const match = pattern.exec(asset.name);
        if (!match || typeof asset.browser_download_url !== "string" || !asset.browser_download_url.startsWith(assetOrigin) || asset.state !== "uploaded") continue;
        result[platform] = { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0, version: match[1], tag: release.tag_name, publishedAt: String(release.published_at ?? "") };
        break;
      }
    }
  }
  return result;
}

export class ClientDownloadsSource {
  private cached?: { value: ClientDownloads; until: number };
  private pending?: Promise<ClientDownloads>;
  constructor(private readonly options: ClientDownloadsOptions = {}) {}
  /** Anonymous callers share one cached lookup, so the endpoint cannot amplify into GitHub's rate limit. */
  current(): Promise<ClientDownloads> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && this.cached.until > now) return Promise.resolve(this.cached.value);
    this.pending ??= this.load(now).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async load(now: number) {
    try {
      const response = await (this.options.fetch ?? fetch)(releasesApi, { headers: { Accept: "application/vnd.github+json", "User-Agent": "NexBot-Core" }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`GitHub releases ${response.status}`);
      const value = pickDownloads(await response.json());
      this.cached = { value, until: now + (this.options.ttlMs ?? 10 * 60_000) };
      return value;
    } catch {
      // Outages and rate limits keep the last good answer; with none, the page links to the release list.
      const value = this.cached?.value ?? { releasesPage };
      this.cached = { value, until: now + (this.options.failureTtlMs ?? 60_000) };
      return value;
    }
  }
}
