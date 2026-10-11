"""Build-time only: pinned, redistributable Windows runtime; never run at app startup.

Run with: uv run --with hindsight-all==0.10.3 python scripts/prepare-memory-runtime.py
The output is ignored build data. No local profiles or credentials are copied.
"""
import concurrent.futures
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import shutil
import sysconfig
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist-personal" / "memory-runtime"
OUT.mkdir(parents=True, exist_ok=True)
LOCK = ROOT / "scripts" / "memory-runtime-lock.json"
MODELS = {
    "embeddings": ("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "e8f8c211226b894fcb81acc59f3b34ba3efd5f42"),
    "reranker": ("cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", "1427fd652930e4ba29e8149678df786c240d8825"),
}

def download(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file():
        return
    temporary = target.with_name(target.name + ".download")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=90) as source, temporary.open("wb") as dest:
                shutil.copyfileobj(source, dest, length=1024 * 1024)
            temporary.replace(target)
            return
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 * (attempt + 1))

versions = {d.metadata["Name"].lower(): d.version for d in metadata.distributions()}
if versions.get("hindsight-api-slim") != "0.10.3":
    raise RuntimeError("Wrong Hindsight build environment")
if LOCK.exists() and json.loads(LOCK.read_text())["dependencies"] != versions:
    raise RuntimeError("Dependency drift: recreate build environment using memory-runtime-requirements.txt")
LOCK.write_text(json.dumps({"python": "3.12.10", "engine": "0.10.3", "dependencies": versions, "models": MODELS}, indent=2) + "\n")
(ROOT / "scripts" / "memory-runtime-requirements.txt").write_text("\n".join(f"{name}=={version}" for name, version in sorted(versions.items())) + "\n")
archive = OUT / "python-3.12.10-embed-amd64.zip"
download("https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip", archive)
python = OUT / "python"
python.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as bundle:
    bundle.extractall(python)
(python / "python312._pth").write_text("python312.zip\n.\nLib/site-packages\nLib/site-packages/win32\nLib/site-packages/win32/lib\nLib/site-packages/Pythonwin\nimport site\n")
site = python / "Lib" / "site-packages"
if not (OUT / ".dependencies-complete").exists():
    # uv's ephemeral purelib can be only an absolute-path overlay. Copy the
    # distribution roots, not that overlay or a pointer into a developer cache.
    roots = {Path(d.locate_file("")).resolve() for d in metadata.distributions()}
    for source in roots:
        shutil.copytree(source, site, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "_virtualenv*", "_uv_*"))
    overlay = site / "_uv_ephemeral_overlay.pth"
    if overlay.exists(): overlay.unlink()
    (site / "sitecustomize.py").write_text("import os\nfrom pathlib import Path\np=Path(__file__).parent/'pywin32_system32'\nif p.is_dir(): os.add_dll_directory(str(p))\n")
    (OUT / ".dependencies-complete").write_text("0.10.3")
print("Portable Python and locked dependencies prepared", flush=True)

def model(key, repo, revision):
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}/revision/{revision}", timeout=30) as stream:
        info = json.load(stream)
    if info["sha"] != revision:
        raise RuntimeError("Model revision mismatch")
    files = [x["rfilename"] for x in info["siblings"]]
    for filename in files:
        if "/" in filename and not filename.startswith("1_Pooling/"):
            continue
        if filename.endswith((".json", ".safetensors", ".txt", ".model", ".md")) or filename.startswith("LICENSE"):
            download(f"https://huggingface.co/{repo}/resolve/{revision}/{filename}", OUT / "models" / key / filename)
    print(f"Pinned model prepared: {key}", flush=True)

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    list(pool.map(lambda item: model(item[0], *item[1]), MODELS.items()))
checksums = {}
for directory in (OUT / "models").iterdir():
    for file in sorted(directory.rglob("*")):
        if file.is_file():
            with file.open("rb") as stream:
                checksums[file.relative_to(OUT).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
manifest = {"release": "0.10.3", "python": "python/python.exe", "pythonArchiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "models": {**{k: f"models/{k}" for k in MODELS}, "revisions": MODELS, "sha256": checksums}, "dependencies": versions}
(OUT / "runtime.json").write_text(json.dumps(manifest, indent=2) + "\n")
shutil.copyfile(LOCK, OUT / "build-lock.json")
print("Offline memory runtime manifest ready", flush=True)
