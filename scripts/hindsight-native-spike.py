"""Isolated native storage/API gate; synthetic embeddings, no paid provider.

Run with uv run --no-project --with hindsight-all==0.10.3 python this_file.
This gate does not claim multilingual-model or extraction quality acceptance.
"""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import uuid


async def main():
    with tempfile.TemporaryDirectory(prefix="nex-hindsight-native-") as root:
        root = Path(root).resolve()
        for key in list(os.environ):
            if key.startswith("HINDSIGHT_"):
                del os.environ[key]
        os.environ.update({
            "HOME": str(root), "USERPROFILE": str(root), "LOCALAPPDATA": str(root),
            "HINDSIGHT_API_LLM_PROVIDER": "none", "HINDSIGHT_API_SKIP_LLM_VERIFICATION": "true",
            "HINDSIGHT_API_LOG_LEVEL": "error", "HINDSIGHT_API_TEXT_SEARCH_EXTENSION": "native",
        })
        from pg0 import Pg0
        from hindsight_api import MemoryEngine
        from hindsight_api.engine.embeddings import Embeddings
        from hindsight_api.engine.cross_encoder import CrossEncoderModel
        from hindsight_api.api.http import create_app
        import httpx

        class FixtureEmbeddings(Embeddings):
            provider_name = "fixture"
            dimension = 16
            async def initialize(self):
                pass
            async def encode(self, texts):
                return [[1.0] + [0.0] * 15 for _ in texts]

        class FixtureReranker(CrossEncoderModel):
            provider_name = "fixture"
            async def initialize(self):
                pass
            async def predict(self, pairs):
                return [1.0 for _ in pairs]

        pg = Pg0(name="nex-spike-" + uuid.uuid4().hex, data_dir=str(root / "postgres"),
                 config={"listen_addresses": "127.0.0.1", "max_connections": "20"})
        engine = None
        try:
            info = await asyncio.to_thread(pg.start)
            engine = MemoryEngine(db_url=info.uri, memory_llm_provider="none", embeddings=FixtureEmbeddings(),
                                  cross_encoder=FixtureReranker(), skip_llm_verification=True,
                                  pool_min_size=1, pool_max_size=4)
            await engine.initialize()
            app = create_app(engine, initialize_memory=False)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
                for bank in ["agent-a", "agent-b"]:
                    response = await client.put(f"/v1/default/banks/{bank}", json={"name": bank})
                    assert response.status_code == 200, response.text
                response = await client.post("/v1/default/banks/agent-a/memories", json={
                    "items": [{"content": "合成测试：用户偏好中文", "document_id": "source-1"}], "async": False})
                assert response.status_code == 200, response.text
                own = await client.get("/v1/default/banks/agent-a/documents/source-1")
                peer = await client.get("/v1/default/banks/agent-b/documents/source-1")
                assert own.status_code == 200 and peer.status_code == 404, (own.text, peer.text)
                response = await client.delete("/v1/default/banks/agent-a/documents/source-1")
                assert response.status_code == 200, response.text
                assert (await client.get("/v1/default/banks/agent-a/documents/source-1")).status_code == 404
            print(json.dumps({"passed": True, "release": "0.10.3", "cases": ["native-postgresql", "migrations", "real-http-api", "bank-isolation", "document-delete"], "limits": "synthetic embeddings and provider none; quality/LLM gates remain"}), flush=True)
        finally:
            if engine:
                await engine.close()
            await asyncio.to_thread(pg.stop)


if __name__ == "__main__":
    asyncio.run(main())
