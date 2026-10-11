"""Owned local Hindsight v0.10.3 process. Configuration uses private stdin.

No paid API key or user-level Hindsight configuration is read by this daemon.
Production model files must be local and checksum-pinned; fixture ML is only
available through the explicit --fixture argument used by isolated tests.
"""
import asyncio
import hashlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import socket
import sys
import threading


async def run(config, fixture=False):
    logging.disable(logging.CRITICAL)
    for name in list(os.environ):
        if name.startswith(("HINDSIGHT_", "OPENAI_", "ANTHROPIC_")):
            del os.environ[name]
    data = Path(config["dataDir"]).resolve()
    data.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "HOME": str(data), "USERPROFILE": str(data), "LOCALAPPDATA": str(data),
        "HF_HOME": str(data / "model-cache"), "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "HINDSIGHT_API_LLM_PROVIDER": "openai", "HINDSIGHT_API_LLM_API_KEY": config["gatewayToken"],
        "HINDSIGHT_API_LLM_BASE_URL": config["gateway"] + "/v1", "HINDSIGHT_API_LLM_MODEL": "nex-configured",
        "HINDSIGHT_API_SKIP_LLM_VERIFICATION": "true", "HINDSIGHT_API_TEXT_SEARCH_EXTENSION": "native",
        "HINDSIGHT_API_LLM_MAX_CONCURRENT": "1", "HINDSIGHT_API_WORKERS": "1",
        "HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION": "false", "HINDSIGHT_API_LLM_MAX_RETRIES": "0",
        "HINDSIGHT_API_RETAIN_LLM_MAX_RETRIES": "0", "HINDSIGHT_API_LLM_TRACE_ENABLED": "false",
    })
    if importlib.metadata.version("hindsight-api-slim") != "0.10.3":
        raise RuntimeError("engine_release_mismatch")
    import httpx
    import uvicorn
    from openai import AsyncOpenAI
    from pg0 import Pg0
    from hindsight_api import MemoryEngine
    from hindsight_api.api.http import create_app
    from hindsight_api.engine import llm_wrapper
    from hindsight_api.engine.llm_trace import current_trace_context
    from hindsight_api.engine.providers.openai_compatible_llm import OpenAICompatibleLLM
    from hindsight_api.extensions.builtin.tenant import ApiKeyTenantExtension

    # Pinned provider factory boundary: every *actual* SDK HTTP attempt acquires
    # native operation context here, including deferred retain jobs. Headers
    # on the original retain request are intentionally not used as attribution.
    original_factory = llm_wrapper.create_llm_provider
    async def attribute(request):
        trace = current_trace_context()
        if not trace or not trace.bank_id or not trace.trace_id or not trace.operation:
            raise RuntimeError("missing_native_operation_context")
        purpose = {"consolidation": "consolidate"}.get(trace.operation, trace.operation)
        request.headers.update({"x-nex-bank": trace.bank_id, "x-nex-operation": trace.trace_id, "x-nex-purpose": purpose})

    def gateway_factory(*args, **kwargs):
        provider = original_factory(*args, **kwargs)
        if not isinstance(provider, OpenAICompatibleLLM):
            raise RuntimeError("unsupported_memory_transport")
        old_client = provider._client
        asyncio.create_task(old_client.close())
        provider._client = AsyncOpenAI(api_key=config["gatewayToken"], base_url=config["gateway"] + "/v1",
                                      max_retries=0, timeout=90,
                                      http_client=httpx.AsyncClient(event_hooks={"request": [attribute]}, trust_env=False))
        return provider
    llm_wrapper.create_llm_provider = gateway_factory

    if fixture:
        from hindsight_api.engine.embeddings import Embeddings
        from hindsight_api.engine.cross_encoder import CrossEncoderModel
        class FixtureEmbeddings(Embeddings):
            provider_name = "fixture"
            dimension = 16
            async def initialize(self): pass
            async def encode(self, texts): return [[1.0] + [0.0] * 15 for _ in texts]
        class FixtureReranker(CrossEncoderModel):
            provider_name = "fixture"
            async def initialize(self): pass
            async def predict(self, pairs): return [1.0 for _ in pairs]
        embeddings, reranker = FixtureEmbeddings(), FixtureReranker()
    else:
        manifest = config["models"]
        model_root = Path(manifest["root"]).resolve()
        directories = [(model_root / manifest[key]).resolve() for key in ["embeddings", "reranker"]]
        if not manifest["sha256"] or any(not directory.is_relative_to(model_root) or not directory.is_dir() for directory in directories):
            raise RuntimeError("memory_model_manifest_invalid")
        actual_files = {str(file.relative_to(model_root)).replace("\\", "/") for directory in directories for file in directory.rglob("*") if file.is_file()}
        if actual_files != set(manifest["sha256"]):
            raise RuntimeError("memory_model_manifest_incomplete")
        for filename, checksum in manifest["sha256"].items():
            file = (Path(manifest["root"]) / filename).resolve()
            if not file.is_relative_to(Path(manifest["root"]).resolve()) or hashlib.sha256(file.read_bytes()).hexdigest() != checksum:
                raise RuntimeError("memory_model_integrity_failed")
        from hindsight_api.engine.embeddings import LocalSTEmbeddings
        from hindsight_api.engine.cross_encoder import LocalSTCrossEncoder
        embeddings = LocalSTEmbeddings(model_name=str(directories[0]), force_cpu=True)
        reranker = LocalSTCrossEncoder(model_name=str(directories[1]), force_cpu=True, max_concurrent=1)
    pg = Pg0(name=config["namespace"], data_dir=str(data / "postgres"), password=config["pgPassword"],
             config={"listen_addresses": "127.0.0.1", "max_connections": "20"})
    engine = None
    try:
        info = await asyncio.to_thread(pg.start)
        engine = MemoryEngine(db_url=info.uri, memory_llm_provider="openai", memory_llm_api_key=config["gatewayToken"],
                              memory_llm_base_url=config["gateway"] + "/v1", memory_llm_model="nex-configured",
                              embeddings=embeddings, cross_encoder=reranker, pool_min_size=1, pool_max_size=4,
                              skip_llm_verification=True, tenant_extension=ApiKeyTenantExtension({"api_key": config["serviceToken"]}))
        await engine.initialize()
        app = create_app(engine, initialize_memory=False)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
        async def ready():
            while not server.started:
                await asyncio.sleep(.05)
            print(json.dumps({"type": "ready", "endpoint": f"http://127.0.0.1:{sock.getsockname()[1]}", "release": "0.10.3"}), flush=True)
        def control():
            # EOF means Core exited. Stop only this managed process/database.
            sys.stdin.readline()
            server.should_exit = True
        threading.Thread(target=control, daemon=True).start()
        reporter = asyncio.create_task(ready())
        try: await server.serve(sockets=[sock])
        finally: reporter.cancel(); sock.close()
    finally:
        if engine: await engine.close()
        await asyncio.to_thread(pg.stop)


if __name__ == "__main__":
    try:
        config = json.loads(sys.stdin.readline())
        asyncio.run(run(config, "--fixture" in sys.argv))
    except Exception as error:
        # Provider exceptions may embed keys/contents. Never pipe them into UI
        # logs; Core exposes sanitized health/operation codes instead.
        event = {"type": "error", "code": "memory_engine_start_failed"}
        if "--fixture" in sys.argv:
            import traceback
            event["diagnostic"] = type(error).__name__ + " " + ",".join(f"{Path(frame.filename).name}:{frame.lineno}" for frame in traceback.extract_tb(error.__traceback__))
        print(json.dumps(event), flush=True)
        sys.exit(1)
