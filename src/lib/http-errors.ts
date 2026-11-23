// What a person sees when a request fails. Browser and parser messages
// ("Failed to fetch", "Unexpected token '<'…", "is not valid JSON") and the
// HTML error pages of a proxy are never shown as they are.

/** The line for a failed HTTP status when the server sent no wording of its own. */
export function httpErrorText(status: number): string {
  if (status === 0) return "网络连接失败，请检查网络后重试";
  if (status === 401) return "登录已过期，请重新登录";
  if (status === 403) return "没有权限执行这个操作";
  if (status === 404) return "当前服务版本不支持这个功能";
  if (status === 408 || status === 504) return "服务响应超时，请稍后重试";
  if (status === 413) return "内容太大，无法发送";
  if (status === 429) return "请求太频繁，请稍后再试";
  if (status === 502 || status === 503) return "服务暂时不可用，可能正在更新，请稍后重试";
  if (status >= 500) return "服务出错了，请稍后重试";
  return "请求失败，请稍后重试";
}

const TECHNICAL = [
  /failed to fetch/i,
  /networkerror/i,
  /network request failed/i,
  /load failed/i,
  /unexpected token/i,
  /not valid json/i,
  /unexpected end of json/i,
  /json\.parse/i,
  /failed to execute/i,
  /<\s*(!doctype|html|head|body)/i,
  /^(type|syntax|reference|range)error\b/i,
  /is not a function|cannot read propert|undefined is not/i,
];

/** True for wording that comes from the browser, a parser or a proxy page rather than from NexBot. */
export function isTechnicalMessage(message: string): boolean {
  return TECHNICAL.some((pattern) => pattern.test(message));
}

/** A thrown error as one line for the page: NexBot's own wording stays, technical wording becomes `fallback`. */
export function userErrorText(error: unknown, fallback = "操作失败，请稍后重试"): string {
  if (error instanceof DOMException && error.name === "AbortError") return "已取消";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = message.trim();
  if (!text) return fallback;
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(text)) return httpErrorText(0);
  if (isTechnicalMessage(text)) return fallback;
  return text;
}

/** The response body as JSON, or null when it is empty or not JSON (a proxy's HTML error page). */
export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T | null> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** The server's own `error` wording when it sent JSON with one, else the status line. */
export function responseErrorText(status: number, body: unknown): string {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" && error.trim() && !isTechnicalMessage(error) ? error.trim() : httpErrorText(status);
}

/** fetch that turns a network failure into an Error a person can read. */
export async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new Error(httpErrorText(0));
  }
}
