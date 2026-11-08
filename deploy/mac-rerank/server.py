"""Self-hosted reranker (BAAI/bge-reranker-v2-m3) for NexBot Core and Hindsight.

One process, one model on the Apple GPU (MPS, fp16). Both wire formats on POST /rerank:
  TEI     {query, texts, return_text?}             -> [{index, score[, text]}]  sorted by score
  Cohere  {model?, query, documents, top_n?}       -> {results:[{index, relevance_score}]}
GET /info (TEI shape, Hindsight calls it at start-up) and GET /health.

Scores are sigmoid(logit) in 0..1, like TEI's default and Cohere's relevance_score.
Only clients in RERANK_ALLOW may call. One GPU worker runs batches of at most RERANK_BATCH_TOKENS, shortest job
first; a bounded queue answers 429 (Hindsight retries those); scores are cached by (query, text).
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_DIR = os.environ.get("RERANK_MODEL_DIR", os.path.join(os.path.dirname(__file__), "model"))
MODEL_ID = os.environ.get("RERANK_MODEL_ID", "BAAI/bge-reranker-v2-m3")
MAX_TOKENS = int(os.environ.get("RERANK_MAX_TOKENS", "512"))          # query + text, per pair
QUERY_TOKENS = int(os.environ.get("RERANK_QUERY_TOKENS", "128"))
BATCH_TOKENS = int(os.environ.get("RERANK_BATCH_TOKENS", "4096"))    # padded tokens per forward pass
MAX_TEXTS = int(os.environ.get("RERANK_MAX_TEXTS", "1000"))           # per request
MAX_PENDING = int(os.environ.get("RERANK_MAX_PENDING", "600"))        # uncached pairs queued or running (~10 s of work)
MAX_BODY = int(os.environ.get("RERANK_MAX_BODY", str(16 * 1024 * 1024)))
CACHE_SIZE = int(os.environ.get("RERANK_CACHE", "200000"))
ALLOW = {a.strip() for a in os.environ.get("RERANK_ALLOW", "127.0.0.1,::1").split(",") if a.strip()}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rerank")

device = "mps" if torch.backends.mps.is_available() else "cpu"
dtype = torch.float16 if device == "mps" else torch.float32
tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR, dtype=dtype).to(device).eval()

executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="rerank")
cache: OrderedDict[bytes, float] = OrderedDict()
pending = 0
stats = {"requests": 0, "pairs": 0, "cached": 0, "rejected": 0, "errors": 0, "started": time.time()}


def _key(query: str, text: str) -> bytes:
    return hashlib.blake2b(f"{MAX_TOKENS}\0{query}\0{text}".encode(), digest_size=16).digest()


def _clip_query(query: str) -> str:
    ids = tokenizer(query, add_special_tokens=False, truncation=True, max_length=QUERY_TOKENS)["input_ids"]
    return tokenizer.decode(ids) if len(ids) >= QUERY_TOKENS else query


@torch.inference_mode()
def _forward(input_ids: list[list[int]], attention_mask: list[list[int]]) -> list[float]:
    batch = tokenizer.pad({"input_ids": input_ids, "attention_mask": attention_mask}, return_tensors="pt")
    logits = model(**{k: v.to(device) for k, v in batch.items()}).logits.view(-1).float()
    return torch.sigmoid(logits).tolist()


class Job:
    """One request's uncached pairs, cut into longest-first batches of at most BATCH_TOKENS padded tokens."""

    def __init__(self, query: str, texts: list[str]):
        enc = tokenizer([query] * len(texts), texts, truncation="only_second", max_length=MAX_TOKENS)
        self.ids, self.mask = enc["input_ids"], enc["attention_mask"]
        lengths = [len(ids) for ids in self.ids]
        order = sorted(range(len(texts)), key=lambda i: -lengths[i])
        self.batches: list[list[int]] = []
        start = 0
        while start < len(order):
            size = max(1, BATCH_TOKENS // lengths[order[start]])
            self.batches.append(order[start:start + size])
            start += size
        self.left = sum(lengths)
        self.lengths = lengths
        self.out = [0.0] * len(texts)
        self.done: asyncio.Future = asyncio.get_running_loop().create_future()


jobs: list[Job] = []
wake = asyncio.Event()


async def worker():
    """Single GPU worker. Shortest remaining job first, one batch at a time, so a 20-text Core request is not
    stuck behind a 300-candidate Hindsight recall."""
    loop = asyncio.get_running_loop()
    while True:
        while not jobs:
            wake.clear()
            await wake.wait()
        job = min(jobs, key=lambda j: j.left)
        chunk = job.batches.pop(0)
        try:
            scores = await loop.run_in_executor(executor, _forward, [job.ids[i] for i in chunk], [job.mask[i] for i in chunk])
        except Exception as e:  # noqa: BLE001
            jobs.remove(job)
            if not job.done.done():
                job.done.set_exception(e)
            continue
        for i, s in zip(chunk, scores):
            job.out[i] = s
        job.left -= sum(job.lengths[i] for i in chunk)
        if not job.batches:
            jobs.remove(job)
            log.info("scored n=%d tokens=%d max=%d", len(job.lengths), sum(job.lengths), max(job.lengths))
            if not job.done.done():
                job.done.set_result(job.out)


async def _score(query: str, texts: list[str]) -> list[float]:
    job = Job(query, texts)
    jobs.append(job)
    wake.set()
    return await job.done


async def rerank(query: str, texts: list[str]) -> list[float]:
    global pending
    query = _clip_query(query)
    keys = [_key(query, t) for t in texts]
    scores: list[float | None] = []
    for k in keys:
        s = cache.get(k)
        if s is not None:
            cache.move_to_end(k)
        scores.append(s)
    missing = [i for i, s in enumerate(scores) if s is None]
    stats["requests"] += 1
    stats["pairs"] += len(texts)
    stats["cached"] += len(texts) - len(missing)
    if missing:
        if pending + len(missing) > MAX_PENDING:
            stats["rejected"] += 1
            raise Overloaded()
        pending += len(missing)
        try:
            fresh = await _score(query, [texts[i] for i in missing])
        finally:
            pending -= len(missing)
        for i, s in zip(missing, fresh):
            scores[i] = s
            cache[keys[i]] = s
        while len(cache) > CACHE_SIZE:
            cache.popitem(last=False)
    return [float(s) for s in scores]  # type: ignore[arg-type]


class Overloaded(Exception):
    pass


class BadRequest(Exception):
    pass


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def guard(request: Request, call_next):
    host = request.client.host if request.client else ""
    if host not in ALLOW:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    size = request.headers.get("content-length")
    if size and size.isdigit() and int(size) > MAX_BODY:
        return JSONResponse({"error": "request too large"}, status_code=413)
    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_ID, "device": device, "pending": pending, "cache": len(cache),
            **{k: v for k, v in stats.items() if k != "started"}, "uptime": int(time.time() - stats["started"])}


@app.get("/info")
async def info():
    return {"model_id": MODEL_ID, "model_dtype": str(dtype).replace("torch.", ""), "model_type": {"reranker": {"id2label": {"0": "LABEL_0"}}},
            "max_input_length": MAX_TOKENS, "max_client_batch_size": MAX_TEXTS, "version": "nex-rerank-1"}


def _texts(body: dict) -> tuple[str, list[str], bool]:
    query = body.get("query")
    if not isinstance(query, str) or not query.strip():
        raise BadRequest("query is required")
    if "texts" in body:
        raw, tei = body["texts"], True
    elif "documents" in body:
        raw, tei = body["documents"], False
    else:
        raise BadRequest("texts or documents is required")
    if not isinstance(raw, list):
        raise BadRequest("texts must be a list")
    if len(raw) > MAX_TEXTS:
        raise BadRequest(f"at most {MAX_TEXTS} texts per request")
    texts = []
    for item in raw:
        text = item.get("text") if isinstance(item, dict) else item
        if not isinstance(text, str):
            raise BadRequest("every text must be a string")
        texts.append(text)
    return query, texts, tei


@app.post("/rerank")
@app.post("/v1/rerank")
async def rerank_endpoint(request: Request):
    started = time.perf_counter()
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise BadRequest("body must be an object")
        query, texts, tei = _texts(body)
        scores = await rerank(query, texts) if texts else []
    except BadRequest as e:
        return JSONResponse({"error": str(e), "error_type": "Validation"}, status_code=422)
    except Overloaded:
        return JSONResponse({"error": "busy", "error_type": "Overloaded"}, status_code=429, headers={"Retry-After": "1"})
    except ValueError:
        return JSONResponse({"error": "invalid JSON", "error_type": "Validation"}, status_code=422)
    except Exception:
        stats["errors"] += 1
        log.exception("rerank failed")
        return JSONResponse({"error": "rerank failed", "error_type": "Backend"}, status_code=500)
    ranked = sorted(range(len(scores)), key=lambda i: -scores[i])
    log.info("rerank %s n=%d ms=%d pending=%d", "tei" if tei else "cohere", len(texts), (time.perf_counter() - started) * 1000, pending)
    if tei:
        return [{"index": i, "score": scores[i], **({"text": texts[i]} if body.get("return_text") else {})} for i in ranked]
    top = body.get("top_n")
    if isinstance(top, int) and top > 0:
        ranked = ranked[:top]
    return {"id": hashlib.blake2b(os.urandom(8), digest_size=8).hexdigest(), "results": [{"index": i, "relevance_score": scores[i]} for i in ranked],
            "meta": {"billed_units": {"search_units": 1}}}


@app.on_event("startup")
async def start_worker():
    app.state.worker = asyncio.create_task(worker())


# Compile MPS kernels before the first real request.
_warm = tokenizer(["warm up"] * 4, ["warm up text"] * 4)
_forward(_warm["input_ids"], _warm["attention_mask"])
log.info("ready: %s on %s (%s), max_tokens=%d, allow=%s", MODEL_ID, device, dtype, MAX_TOKENS, ",".join(sorted(ALLOW)))
