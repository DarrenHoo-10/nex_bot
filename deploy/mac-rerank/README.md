# 自建重排服务（Mac Air，bge-reranker-v2-m3）

东京的 Core 和 Hindsight 都用它做记忆重排，替代按量计费的硅基流动 `Qwen3-Reranker-8B`。

```
Core ──http://127.0.0.1:18081──┐
                               ├─ nex-rerank-proxy（东京）──ZeroTier──> Mac Air :8081（server.py，MPS fp16）
Hindsight ─http://172.18.0.1:18081┘
```

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| `server.py` | Mac `~/Services/nex-rerank/` | 模型服务；`/rerank` 同时支持 TEI 与 Cohere 格式，`/info`、`/health`；只放行 `RERANK_ALLOW` 中的地址 |
| `com.darrenhoo.nex-rerank.plist` | Mac `~/Library/LaunchAgents/` | launchd 常驻、崩溃重启；用 `caffeinate` 防止空闲睡眠 |
| `bench.py` | Mac 同目录 | 正确性与负载测试：`.venv/bin/python bench.py http://127.0.0.1:8081` |
| `tokyo-proxy.mjs` | 东京 `/opt/nex-rerank-proxy/` | 每 5 秒探测 Mac；Mac 不在线时立即返回 424，客户端不重试，直接降级 |
| `nex-rerank-proxy.service` | 东京 `/etc/systemd/system/` | 代理的 systemd 单元 |

## 安装（Mac）

```bash
mkdir -p ~/Services/nex-rerank/logs && cd ~/Services/nex-rerank
/opt/homebrew/bin/python3.13 -m venv .venv
.venv/bin/pip install torch transformers fastapi "uvicorn[standard]" huggingface_hub
.venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("BAAI/bge-reranker-v2-m3", local_dir="model", allow_patterns=["*.json","model.safetensors","sentencepiece.bpe.model","tokenizer*"])'
cp com.darrenhoo.nex-rerank.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.darrenhoo.nex-rerank.plist
```

更新 `server.py` 后：`launchctl kickstart -k gui/$(id -u)/com.darrenhoo.nex-rerank`。日志在 `logs/rerank.log`。

## 客户端配置

- Core（`/etc/nexbot/core.env`）：`NEX_RERANK_FORMAT=cohere`、`NEX_RERANK_BASE_URL=http://127.0.0.1:18081`、`NEX_RERANK_MODEL=BAAI/bge-reranker-v2-m3`，不设 Key。
- Hindsight（`/data/hindsight/.env`）：`RERANKER_PROVIDER=tei`、`RERANKER_TEI_URL=http://172.18.0.1:18081`、`RERANKER_1_PROVIDER=rrf`（兜底），每次检索的候选上限 `MAX_CANDIDATES_LOW/MID/HIGH=40/80/120`。

## 限制

- Mac 合盖、断网或关机时不重排：Core 退回不重排的排序（预算 1000 token），Hindsight 退回 `rrf`。`caffeinate` 只能阻止空闲睡眠，不能阻止合盖睡眠（电池供电时）。
- M4 实测每秒约 15–30 条（与长度有关），比原来的云端 8B 模型慢，排序质量也略低。
