// Stage a pinned herdr-core (`hc`) terminal runtime for every desktop target
// the client packages on this host. Agent mode runs Claude/Codex sessions in
// terminals that herdr-core owns, so they outlive the client process. Pass
// --current for development to stage only the platform and architecture
// running this script. The release archive is verified before extraction and
// every staged file is verified again on every reuse.
// Nothing is installed globally and herdr-core's own updater is never run;
// OpenMausBot updates this dependency with an ordinary reviewed app release.
// The digests below were read from
// https://releases.herdr.dev/core/0.1.21/manifest.json and re-checked against
// the downloaded archives; the script never trusts the remote manifest.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERDR_CORE_VERSION = "0.1.21";
export const HERDR_CORE_VERSION_OUTPUT = `hc ${HERDR_CORE_VERSION}`;

// Archive layout (0.1.21): Windows ships herdr-core.exe, conpty/ and a
// THIRD-PARTY-NOTICES/ directory; macOS ships herdr-core, LICENSE, a single
// THIRD-PARTY-NOTICES file and a signed "Herdr Core.app" that we do not use.
// `files` maps archive path -> staged path; each entry is pinned by digest.
export const HERDR_CORE_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "herdr-core-macos-aarch64.tar.gz",
    sha256: "1ab38dd9270f63a8f794d6d60e8702eb0d1c85a72bda85d735e5eea43f05ffed",
    executable: "herdr-core",
    binarySha256: "ed3e400a36eb78d01e650e38b4591b032f189e5b382a47e353b3389b06510ede",
    notices: "THIRD-PARTY-NOTICES",
    files: Object.freeze({
      "herdr-core": "ed3e400a36eb78d01e650e38b4591b032f189e5b382a47e353b3389b06510ede",
      LICENSE: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
      "THIRD-PARTY-NOTICES": "3f47db789d2ca84bba20126be453f76e6d06c3901655645a98bb353721b0aa44",
    }),
  }),
  "darwin-x64": Object.freeze({
    name: "herdr-core-macos-x86_64.tar.gz",
    sha256: "e377e1d342cddce0346da5b2f3c281b9701e4731c00024c7c5028265e77a217f",
    executable: "herdr-core",
    binarySha256: "04817308cc884f1ee66a7cca182ff3ed4a399a4ad8cbed58bed740715b310142",
    notices: "THIRD-PARTY-NOTICES",
    files: Object.freeze({
      "herdr-core": "04817308cc884f1ee66a7cca182ff3ed4a399a4ad8cbed58bed740715b310142",
      LICENSE: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
      "THIRD-PARTY-NOTICES": "3f47db789d2ca84bba20126be453f76e6d06c3901655645a98bb353721b0aa44",
    }),
  }),
  "win32-x64": Object.freeze({
    name: "herdr-core-windows-x86_64.zip",
    sha256: "a8984634c35b58ba82d0aec078d5a5e6004da01d5a25b3daf822ab5e31c7312b",
    executable: "herdr-core.exe",
    binarySha256: "5304b33036e6f83d752751e8e4ca78ea484acf6b9247e72f2d3aecc02f696a6d",
    notices: "THIRD-PARTY-NOTICES/herdr-core.txt",
    files: Object.freeze({
      "herdr-core.exe": "5304b33036e6f83d752751e8e4ca78ea484acf6b9247e72f2d3aecc02f696a6d",
      "conpty/conpty.dll": "39fba2713e2495117b1591ae8c32a3b904bea7aa66069cf7815e2844c76d75d8",
      "conpty/x64/OpenConsole.exe": "b7fd936c2668b87b9ecf7b3366dc6568afc1c6f981874cba3e955a1c35cf8160",
      LICENSE: "1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6",
      "THIRD-PARTY-NOTICES/herdr-core.txt": "0574542ad0acc8de676ec9b50083b2a527634314172f541e9454bf4b1157163b",
      "THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-LICENSE.txt":
        "5d177f23ecfeb0ea8e050b6a5a16355e1ae9a0b286436ca8f83ed08b3795be6b",
      "THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-NOTICE.md":
        "e7fbaadee6ab20c28b87730a510ee5f5815d8fb4bd88d1d54d282dc2a74c0726",
    }),
  }),
});

export function targetsForHost(platform) {
  // Desktop package targets only; the client has no Linux desktop build.
  if (platform === "darwin") return ["darwin-arm64", "darwin-x64"];
  if (platform === "win32") return ["win32-x64"];
  throw new Error(`herdr-core packaging is unsupported on ${platform}`);
}

export function targetForCurrentHost(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!Object.hasOwn(HERDR_CORE_ASSETS, target)) {
    throw new Error(`herdr-core development is unsupported on ${target}`);
  }
  return target;
}

export function targetsForPreparation({
  current = false,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return current ? [targetForCurrentHost(platform, arch)] : targetsForHost(platform);
}

export function parsePrepareHerdrCoreArgs(args = []) {
  const options = { current: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = args[index + 1];
    if (argument === "--current" && !options.current) {
      options.current = true;
    } else if (argument === "--root" && !options.root && typeof next === "string" && next !== "") {
      options.root = next;
      index += 1;
    } else {
      throw new Error("Usage: node scripts/prepare-herdr-core.mjs [--current] [--root DIR]");
    }
  }
  return options;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function verifySha256(value, expected, label = "herdr-core asset") {
  const actual = sha256(value);
  if (actual !== expected) {
    throw new Error(`${label} failed SHA-256 verification (expected ${expected}, received ${actual})`);
  }
  return actual;
}

/** Identify the exact desktop target from the executable header without
 * invoking untrusted bytes. */
export function executableTarget(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);

  // 64-bit little-endian Mach-O. CPU types include ABI64 (0x01000000).
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    if (cpu === 0x0100000c) return "darwin-arm64";
    if (cpu === 0x01000007) return "darwin-x64";
    throw new Error(`unsupported herdr-core Mach-O CPU type 0x${cpu.toString(16)}`);
  }

  // PE32+ AMD64. e_lfanew points from the DOS header to PE\0\0.
  if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = bytes.readUInt32LE(0x3c);
    if (
      pe <= bytes.length - 6 &&
      bytes.subarray(pe, pe + 4).equals(Buffer.from([0x50, 0x45, 0, 0])) &&
      bytes.readUInt16LE(pe + 4) === 0x8664
    ) {
      return "win32-x64";
    }
  }

  throw new Error("herdr-core release has an unsupported executable format or architecture");
}

export function verifyPinnedBinary(value, target) {
  const asset = HERDR_CORE_ASSETS[target];
  if (!asset) throw new Error(`No pinned herdr-core asset for ${target}`);
  const actualTarget = executableTarget(value);
  if (actualTarget !== target) {
    throw new Error(`herdr-core architecture mismatch (expected ${target}, received ${actualTarget})`);
  }
  return verifySha256(value, asset.binarySha256, `${target} herdr-core executable`);
}

/** Staged file name for each archive entry: the notices file the binary prints
 * with --licenses becomes THIRD-PARTY-NOTICES.txt; every other entry (including
 * the ConPTY MIT licence in THIRD-PARTY-NOTICES/) keeps its archive path. */
export function stagedPath(target, archivePath) {
  return archivePath === HERDR_CORE_ASSETS[target].notices ? "THIRD-PARTY-NOTICES.txt" : archivePath;
}

function stagedFiles(target) {
  const asset = HERDR_CORE_ASSETS[target];
  return Object.fromEntries(
    Object.entries(asset.files).map(([archivePath, digest]) => [stagedPath(target, archivePath), digest]),
  );
}

function expectedManifest(target) {
  const asset = HERDR_CORE_ASSETS[target];
  return {
    version: HERDR_CORE_VERSION,
    target,
    releaseAsset: asset.name,
    releaseAssetSha256: asset.sha256,
    binarySha256: asset.binarySha256,
    files: stagedFiles(target),
  };
}

function targetRunsOnHost(target, platform = process.platform, arch = process.arch) {
  return target === `${platform}-${arch}`;
}

function probe(binary, args, maxBuffer) {
  return spawnSync(binary, args, {
    encoding: "buffer",
    windowsHide: true,
    timeout: 20_000,
    maxBuffer,
    // cwd never holds anything the probe could pick up.
    cwd: tmpdir(),
  });
}

/** `hc --version` prints exactly `hc 0.1.21`; `--licenses` prints the notices
 * file, which the archive also ships. A dual-architecture macOS package is
 * prepared in one invocation, so only the host's own target is executed. */
function executableIsGenuine(binary, target, noticesFile) {
  if (!targetRunsOnHost(target)) return true;
  const version = probe(binary, ["--version"], 1 << 20);
  if (version.status !== 0 || version.stdout.toString("utf8").trim() !== HERDR_CORE_VERSION_OUTPUT) {
    return false;
  }
  const licenses = probe(binary, ["--licenses"], 16 << 20);
  return licenses.status === 0 && licenses.stdout.equals(readFileSync(noticesFile));
}

export function verifyHerdrCoreDirectory(directory, target) {
  const asset = HERDR_CORE_ASSETS[target];
  if (!asset) throw new Error(`No pinned herdr-core asset for ${target}`);
  const files = stagedFiles(target);
  for (const [relative, digest] of Object.entries(files)) {
    const file = join(directory, relative);
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error(`${relative} is not a regular file`);
    const bytes = readFileSync(file);
    if (relative === asset.executable) verifyPinnedBinary(bytes, target);
    else verifySha256(bytes, digest, `${target} ${relative}`);
  }
  const binary = join(directory, asset.executable);
  if (!executableIsGenuine(binary, target, join(directory, "THIRD-PARTY-NOTICES.txt"))) {
    throw new Error(`${target} executable did not identify as ${HERDR_CORE_VERSION_OUTPUT}`);
  }
}

function directoryIsCurrent(directory, target) {
  const manifestFile = join(directory, "manifest.json");
  if (!existsSync(manifestFile)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest(target))) return false;
    verifyHerdrCoreDirectory(directory, target);
    return true;
  } catch {
    return false;
  }
}

function extractionFailure(result) {
  return result.error?.message ?? String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
}

/** Windows ships bsdtar as System32\tar.exe, which reads zip files; a Git Bash
 * `tar` earlier on PATH is GNU tar and cannot. macOS bsdtar reads tar.gz. */
function tarCommand() {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

/** Retry transient download failures; callers still verify the pinned digest. */
export async function releaseBytes(asset) {
  const cacheDirectory = process.env.NEX_HERDR_CORE_ARCHIVE_DIR;
  const cached = cacheDirectory ? join(cacheDirectory, asset.name) : "";
  if (cached && existsSync(cached)) return readFileSync(cached);

  const url = `https://releases.herdr.dev/core/${HERDR_CORE_VERSION}/${asset.name}`;
  const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
  for (let attempt = 1; attempt <= 3; attempt++) {
    let failure;
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      await response.body?.cancel().catch(() => {});
      failure = new Error(`could not download ${asset.name}: HTTP ${response.status}`);
      if (!retryableStatuses.has(response.status)) throw failure;
    } catch (error) {
      // Node fetch reports network/body failures as TypeError; each attempt
      // has its own timeout, including reading the complete response body.
      if (!(error instanceof TypeError) && !["TimeoutError", "AbortError"].includes(error?.name)) throw error;
      failure = error;
    }
    if (attempt === 3) throw failure;
    const delay = 1_000 * 2 ** (attempt - 1);
    console.warn(`herdr-core download attempt ${attempt}/3 failed: ${failure.message}; retrying in ${delay}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function stageTarget(root, target) {
  const asset = HERDR_CORE_ASSETS[target];
  if (!asset) throw new Error(`No pinned herdr-core asset for ${target}`);

  const finalDirectory = join(root, "dist-native", "herdr-core", target);
  if (directoryIsCurrent(finalDirectory, target)) {
    console.log(`herdr-core ${HERDR_CORE_VERSION} already staged for ${target}`);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), `openmaus-herdr-core-${target}-`));
  try {
    const payload = await releaseBytes(asset);
    verifySha256(payload, asset.sha256, asset.name);

    const archive = join(scratch, basename(asset.name));
    writeFileSync(archive, payload, { mode: 0o600 });
    const extracted = join(scratch, "extracted");
    mkdirSync(extracted, { mode: 0o700 });
    const result = spawnSync(tarCommand(), ["-xf", archive, "-C", extracted], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`could not extract ${asset.name}: ${extractionFailure(result)}`);

    // Take only the pinned entries; anything else in the archive is ignored.
    // Symlinks and directories in their place are rejected.
    const verified = join(scratch, "verified");
    mkdirSync(verified, { mode: 0o700 });
    for (const [archivePath, digest] of Object.entries(asset.files)) {
      const source = join(extracted, ...archivePath.split("/"));
      if (!existsSync(source)) throw new Error(`${asset.name} did not contain ${archivePath}`);
      if (!lstatSync(source).isFile()) throw new Error(`${asset.name}: ${archivePath} is not a regular file`);
      const bytes = readFileSync(source);
      if (archivePath === asset.executable) verifyPinnedBinary(bytes, target);
      else verifySha256(bytes, digest, `${asset.name} ${archivePath}`);
      const destination = join(verified, ...stagedPath(target, archivePath).split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    const candidate = join(verified, asset.executable);
    if (!target.startsWith("win32-")) chmodSync(candidate, 0o700);
    if (!executableIsGenuine(candidate, target, join(verified, "THIRD-PARTY-NOTICES.txt"))) {
      throw new Error(`${target} executable did not identify as ${HERDR_CORE_VERSION_OUTPUT}`);
    }

    const parent = dirname(finalDirectory);
    mkdirSync(parent, { recursive: true });
    const stagedDirectory = mkdtempSync(join(parent, `.${target}-`));
    try {
      for (const relative of Object.keys(stagedFiles(target))) {
        const destination = join(stagedDirectory, ...relative.split("/"));
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(verified, ...relative.split("/")), destination);
      }
      if (!target.startsWith("win32-")) chmodSync(join(stagedDirectory, asset.executable), 0o755);
      writeFileSync(
        join(stagedDirectory, "manifest.json"),
        `${JSON.stringify(expectedManifest(target), null, 2)}\n`,
        { mode: 0o600 },
      );
      rmSync(finalDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      renameSync(stagedDirectory, finalDirectory);
    } catch (error) {
      rmSync(stagedDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      throw error;
    }
    console.log(`staged herdr-core ${HERDR_CORE_VERSION} for ${target}`);
  } finally {
    // Windows Defender can briefly retain the executable after the version
    // probe exits. Node retries EPERM for recursive removals when asked.
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

export async function prepareHerdrCore({
  root = join(dirname(fileURLToPath(import.meta.url)), ".."),
  platform = process.platform,
  arch = process.arch,
  current = false,
} = {}) {
  for (const target of targetsForPreparation({ current, platform, arch })) {
    await stageTarget(root, target);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await prepareHerdrCore(parsePrepareHerdrCoreArgs(process.argv.slice(2)));
}
