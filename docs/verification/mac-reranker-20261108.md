# 自建重排：Mac Air 上的 bge-reranker-v2-m3（2026-11-08）

东京 Core 和 Hindsight 的记忆重排改用 Mac Air（M4，16 GB）上的 `BAAI/bge-reranker-v2-m3`，不再调用硅基流动 `Qwen3-Reranker-8B`（按量计费，每月上百美元）。服务文件与安装步骤见 [`deploy/mac-rerank/`](../../deploy/mac-rerank/README.md)。

本次没有改 Core 代码，也没有重新打包任何客户端，只改了服务器配置。

## 部署

- **Mac**：`~/Services/nex-rerank`（Python 3.13 venv，torch 2.15 MPS，transformers 5.22），launchd `com.darrenhoo.nex-rerank`，监听 `:8081`，只放行 `127.0.0.1` 和东京 ZeroTier 地址 `10.73.236.135`。其他来源返回 403，已从本机实测。
- **东京**：`nex-rerank-proxy.service` 监听 `127.0.0.1:18081`（Core）和 `172.18.0.1:18081`（Hindsight 所在的 docker 网桥），转发到 `10.73.236.92:8081`。
- **Core**：`/etc/nexbot/core.env` 改为 cohere 格式 + `http://127.0.0.1:18081` + `BAAI/bge-reranker-v2-m3`，删除了 `NEX_RERANK_API_KEY`，避免把硅基流动的 Key 发给自建服务。备份为 `core.env.bak-20261108-local-rerank`。重启前确认 6 个账户库都没有进行中的任务或例程，也没有账户级检索覆盖。
- **Hindsight**：`/data/hindsight/.env` 改为 TEI + 代理地址，加 `RERANKER_1_PROVIDER=rrf` 兜底，候选上限 40/80/120（low/mid/high，原来都是 300）。备份为 `.env.bak-20261108-rerank`。原来的 TEI 地址（`jiayu-desktop…:8081`）近 4 天只成功 3 次，其余全部失败。

## 验证

- **正确性**：「我的猫叫什么名字？」中相关文本 0.75，无关文本约 0.00002；Cohere 格式下相关文本 0.9997。用 Core 自己的 `rerank.ts` 经东京代理调用，cohere 和 tei 两种格式都返回 0.9856 / 0.0000 ×3，Core 的 0.3 阈值仍能区分。
- **性能（Mac 本机，fp16）**：Core 形状（20 条 × 约 500 token）约 1.25 秒；300 条 × 约 120 token 约 5.1 秒；4 个检索并发 22.5 秒；两个大检索进行中时 Core 请求 2.7 秒（按最短任务优先、分批调度）；重复请求命中缓存 3 毫秒。按批 4096 token 比 16384 略快。
- **真实 Hindsight 检索**：预热后，120 条候选（平均约 113 token）约 4.4 秒；冷启动第一次约 8 秒。
- **故障**：停掉 Mac 服务后，代理 5 秒内标记离线，请求立即返回 424（Hindsight 不重试 4xx，直接走 `rrf`；Core 直接降级）。launchd 约 5 秒内自动重启，代理随即恢复。
- **东京**：公网 `/health` 200，未登录 `/api/state` 401；Core 进程环境中重排为新配置，没有 Key；Hindsight 启动日志为 `TEI provider initialized (model: BAAI/bge-reranker-v2-m3)` 加 RRF 兜底。

## 限制

- 依赖 Mac 在线：`caffeinate` 只阻止空闲睡眠。电池供电时合盖仍会睡眠，此时检索照常进行，只是不重排。
- 质量与速度都低于原来的云端 8B 模型；Hindsight 每次检索的重排候选数从 300 降到 40–120。
- 没有在 NexBot 界面里手动点「测试保存」，也没有用真实账户发起对话来触发 Core 检索（那会写入用户数据）。Core 的检索路径只用它自己的客户端代码经代理验证过。
- 当天随后把 Hindsight 的反思模型改为 CPA 的 `glm-5.3-flash`（`HINDSIGHT_API_REFLECT_LLM_*`，Key 与地址沿用主模型，备份 `.env.bak-20261108-reflect`）。原来的 `grok-4.7` 返回 `503 auth_unavailable`，反思全部失败。改后真实反思可以完成。
- 反思恢复后，积压的 mental model 刷新任务同时涌来。两个问题随之出现：glm 被限流（`1302`）；重排排队超过 25 秒，代理超时后还把 Mac 误判为离线 5 秒。处理：反思的 LLM 并发限为 2（3 仍被限流）、首次重试等待 5 秒；mental model 刷新并发由 8 降到 2，整个反思时限由 300 秒放宽到 1200 秒。glm-5.3-flash 一次 4.1 万 token 输入、2257 token 输出的调用用了 356 秒；600 秒时限下 4 个刷新任务只完成 1 个（546 秒）。同一网关上短提示的输出速度：glm-5.3-flash 约 41 token/s，glm-5.3 约 94 token/s；代理遇到超时或 Mac 返回 429 时只让这一次请求返回 424，不再标记离线；Mac 的队列上限降到 600 对（约 10 秒的计算量）。
- 反思备用模型：darren-cpa（`https://darren.nexorai.com.cn`，Anthropic 格式）的 `claude-haiku-5-5`，强度 high。Hindsight 的 Anthropic 客户端会忽略 `REASONING_EFFORT`，所以强度用 `REFLECT_LLM_1_EXTRA_BODY={"output_config":{"effort":"high"}}` 放进请求体；策略为 `{"mode":"failover"}`。Hindsight 只有在主模型用完自身重试后才切换，所以 glm 改为单次超时 240 秒、重试 1 次，最慢约 8 分钟后切到 haiku。在东京直接用同样的请求体测过 darren-cpa（普通回答 3.1 秒、强制工具调用 1.7 秒、带 temperature 也是 200）；Hindsight 启动时的连接检查也通过了。备份为 `.env.bak-20261108-reflect-fallback`。第一次把策略写成纯文本 `failover`，导致 Hindsight 启动失败、停了约 2 分钟（要求 JSON），改正后恢复。
- 实际运行：glm 的大请求会被 `api.nexorai.com.cn` 前面的 Cloudflare 在约 100 秒时切断（HTTP 524），也会被限流（1302），之后会切到 haiku。切换后两个 refresh 完成（952 秒、979 秒）。但 haiku 每次都输出到 4096 token 的上限（Hindsight 的 Anthropic 客户端在未设置时默认 4096），因此加了 `HINDSIGHT_API_REFLECT_MAX_COMPLETION_TOKENS=16000`；这项改动之后还没有观察到完成的反思。
- retain（提取事实）原来用主模型 `grok-4.7`，因余额用完（`Grok Build usage balance exhausted`）一直失败，切换前 30 分钟内失败 8 次。已改为 darren-cpa 的 `claude-haiku-5-5`（`HINDSIGHT_API_RETAIN_LLM_*`，默认强度），`RETAIN_MAX_COMPLETION_TOKENS` 由 64000 改为 16000。备份为 `.env.bak-20261108-retain`。改后两次提取调用分别用 15 秒和 24 秒，输出 3186 和 5585 token，都超过原来的 4096 上限；随后一个批次存入 16 条记忆，没有错误。verification 和 consolidation 仍用 `grok-4.7`，本次未改。
