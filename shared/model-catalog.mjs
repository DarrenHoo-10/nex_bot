export function catalogSettings(input, saved) {
  if (!input || !["openai", "anthropic"].includes(input.provider)) throw new Error("请选择 API 协议");
  let url;
  try { url = new URL(input.endpoint); } catch { throw new Error("请输入有效的 API 基础地址"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("请使用 HTTPS 地址，本机服务可使用 HTTP");
  const endpoint = url.toString().replace(/\/+$/, "");
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const retained = saved && saved.provider === input.provider && saved.endpoint.replace(/\/+$/, "") === endpoint ? saved.apiKey : "";
  if (!apiKey && !retained) throw new Error("请填写 API Key 后获取模型列表");
  if ((apiKey || retained).length > 8192) throw new Error("API Key 过长");
  return { provider: input.provider, endpoint, apiKey: apiKey || retained };
}

export async function fetchModelCatalog(input, fetcher = fetch) {
  const { provider, endpoint, apiKey } = catalogSettings(input);
  const address = endpoint + (provider === "anthropic" && !endpoint.endsWith("/v1") ? "/v1/models" : "/models");
  const headers = provider === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${apiKey}` };
  let response;
  try { response = await fetcher(address, { headers, redirect: "error", signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error("无法获取模型列表，请检查服务地址或网络连接"); }
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 403].includes(response.status)) throw new Error("API Key 无效或没有读取模型列表的权限");
    if (response.status === 404) throw new Error("此地址未提供模型列表，可手动填写模型 ID");
    throw new Error(`获取模型列表失败（${response.status}），请稍后重试`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务未返回模型列表");
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("模型列表响应过大，请手动填写模型 ID"); }
      chunks.push(value);
    }
  } catch (error) { if (size > 2 * 1024 * 1024) throw error; throw new Error("读取模型列表失败，请重试"); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("服务返回的模型列表格式无效"); }
  if (!Array.isArray(body.data)) throw new Error("服务返回的模型列表格式无效");
  const models = [...new Set(body.data.map(item => item?.id).filter(id => typeof id === "string" && id.trim() && id.length <= 200))].sort();
  return { models: models.slice(0, 1000), hasMore: body.has_more === true || models.length > 1000 };
}
