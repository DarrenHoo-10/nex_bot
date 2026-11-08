"""Load and sanity check for the reranker: python bench.py http://host:port"""
import json
import random
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

base = sys.argv[1].rstrip("/")


def post(body):
    req = urllib.request.Request(base + "/rerank", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r), time.perf_counter() - started


# Relevance: a relevant answer must beat unrelated text, scores in 0..1.
docs = ["用户喜欢在周末去爬山，最常去的是香山。", "东京服务器的 Core 服务名叫 nexbot-core。", "Paris is the capital of France.",
        "用户的猫叫豆豆，是一只橘猫。", "The reranker runs on a Mac Air with an M4 chip."]
tei, _ = post({"query": "我的猫叫什么名字？", "texts": docs})
cohere, _ = post({"model": "BAAI/bge-reranker-v2-m3", "query": "Which city is the capital of France?", "documents": docs, "top_n": 2})
print("tei top:", tei[0], "| last:", tei[-1])
print("cohere:", cohere["results"])
assert tei[0]["index"] == 3 and cohere["results"][0]["index"] == 2

random.seed(7)
words = "记忆 检索 用户 任务 模型 服务器 配置 发布 会议 文档 计划 预算 项目 客户 数据 报告 部署 测试 版本 设备".split()
def text(n):
    return "".join(random.choice(words) for _ in range(n))

for label, n, size in [("core 20x~500tok", 20, 250), ("hindsight 128x~120tok", 128, 60), ("hindsight 300x~120tok", 300, 60)]:
    times = []
    for round_ in range(3):
        body = {"query": f"{text(10)} {round_}", "texts": [text(size) + str(i) for i in range(n)]}
        _, t = post(body)
        times.append(t)
    print(f"{label}: " + ", ".join(f"{t:.2f}s" for t in times))

# Hindsight shape: one recall of 300 candidates sent as 3 parallel requests, several recalls at once.
def recall(k):
    query = f"并发 {k} {text(8)}"
    with ThreadPoolExecutor(3) as pool:
        return max(pool.map(lambda c: post({"query": query, "texts": [text(60) + f"{k}-{c}-{i}" for i in range(100)]})[1], range(3)))

for parallel in (1, 4):
    started = time.perf_counter()
    with ThreadPoolExecutor(parallel) as pool:
        worst = max(pool.map(recall, range(parallel)))
    print(f"{parallel} concurrent recalls x300: wall {time.perf_counter() - started:.2f}s, slowest {worst:.2f}s")

# A Core-sized request while two Hindsight recalls are running.
with ThreadPoolExecutor(3) as pool:
    background = [pool.submit(recall, 100 + k) for k in range(2)]
    time.sleep(0.5)
    _, t = post({"query": "核心 请求", "texts": [text(250) + str(i) for i in range(20)]})
    print(f"core 20x~500tok during 2 recalls: {t:.2f}s (recalls {max(f.result() for f in background):.2f}s)")

# Repeat of the same recall is served from cache.
body = {"query": "缓存", "texts": [text(60) + str(i) for i in range(300)]}
post(body)
_, t = post(body)
print(f"cached 300: {t:.3f}s")
