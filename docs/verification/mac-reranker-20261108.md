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
- 当天随后把 Hindsight 的反思模型改为 CPA 的 `glm-5.3-flash`（`HINDSIGHT_API_REFLECT_LLM_*`，Key 与地址沿用主模型，备份 `.env.bak-20261108-reflect`）。原来的 `grok-4.7` 返回 `503 auth_unavailable`，反思全部失败。改后真实反思可以完成，日志中没有 LLM 错误；其他操作仍用 `grok-4.7`。
