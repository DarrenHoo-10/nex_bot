// Report bounded transport metadata, never arbitrary exception messages,
// request headers, bodies, URL queries or credentials from a fetch cause.
export function modelConnectionError(error: unknown, url: URL): Error {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof value.code === "string" && /^[A-Z][A-Z0-9_]{1,70}$/.test(value.code)) codes.push(value.code);
    if (value.name === "TimeoutError" || value.name === "AbortError") codes.push(String(value.name));
    if (value.message === "bad port") codes.push("FETCH_BAD_PORT");
    current = value.cause;
  }
  const detail = codes.some((code) => /TIMEOUT|TimeoutError/.test(code)) ? "连接超时"
    : codes.some((code) => /ENOTFOUND|EAI_AGAIN/.test(code)) ? "域名解析失败"
    : codes.some((code) => /CERT|TLS|SSL/.test(code)) ? "TLS 证书或安全连接失败"
    : codes.includes("ECONNREFUSED") ? "服务拒绝连接"
    : codes.some((code) => /ECONNRESET|UND_ERR_SOCKET/.test(code)) ? "连接被服务端中断"
    : codes.includes("FETCH_BAD_PORT") ? "请求端口被网络运行时拒绝"
    : "连接失败";
  return new Error(`模型服务${detail}。请求地址：${url.origin}${url.pathname}。${codes.length ? `错误代码：${[...new Set(codes)].join(" / ")}。` : ""}请检查模型服务与网络连接；未自动重试。`);
}
