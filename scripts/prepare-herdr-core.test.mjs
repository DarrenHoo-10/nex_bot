import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  HERDR_CORE_ASSETS,
  HERDR_CORE_VERSION,
  executableTarget,
  parsePrepareHerdrCoreArgs,
  releaseBytes,
  sha256,
  stagedPath,
  targetForCurrentHost,
  targetsForHost,
  targetsForPreparation,
  verifyPinnedBinary,
  verifySha256,
} from "./prepare-herdr-core.mjs";

describe("herdr-core download retries", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function mockDownload() {
    vi.useFakeTimers();
    vi.stubEnv("NEX_HERDR_CORE_ARCHIVE_DIR", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("downloads from the pinned release path and recovers from an HTTP 504", async () => {
    const fetchMock = mockDownload();
    const bytes = Buffer.from("downloaded release");
    fetchMock.mockResolvedValueOnce(new Response("gateway timeout", { status: 504 }))
      .mockResolvedValueOnce(new Response(bytes));
    const download = releaseBytes({ name: "herdr-core-windows-x86_64.zip" });
    await vi.runAllTimersAsync();
    expect(await download).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://releases.herdr.dev/core/0.1.21/herdr-core-windows-x86_64.zip",
    );
  });

  it("retries a network error and an interrupted response body", async () => {
    const fetchMock = mockDownload();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => { throw new TypeError("terminated"); } })
      .mockResolvedValueOnce(new Response("complete"));
    const download = releaseBytes({ name: "herdr-core-windows-x86_64.zip" });
    await vi.runAllTimersAsync();
    expect(await download).toEqual(Buffer.from("complete"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after three transient failures", async () => {
    const fetchMock = mockDownload();
    fetchMock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
    const result = expect(releaseBytes({ name: "x" })).rejects.toThrow(/HTTP 503/);
    await vi.runAllTimersAsync();
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails immediately for a missing pinned asset", async () => {
    const fetchMock = mockDownload();
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(releaseBytes({ name: "missing" })).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

const PINNED = {
  "darwin-arm64": {
    name: "herdr-core-macos-aarch64.tar.gz",
    sha256: "1ab38dd9270f63a8f794d6d60e8702eb0d1c85a72bda85d735e5eea43f05ffed",
    binarySha256: "ed3e400a36eb78d01e650e38b4591b032f189e5b382a47e353b3389b06510ede",
  },
  "darwin-x64": {
    name: "herdr-core-macos-x86_64.tar.gz",
    sha256: "e377e1d342cddce0346da5b2f3c281b9701e4731c00024c7c5028265e77a217f",
    binarySha256: "04817308cc884f1ee66a7cca182ff3ed4a399a4ad8cbed58bed740715b310142",
  },
  "win32-x64": {
    name: "herdr-core-windows-x86_64.zip",
    sha256: "a8984634c35b58ba82d0aec078d5a5e6004da01d5a25b3daf822ab5e31c7312b",
    binarySha256: "5304b33036e6f83d752751e8e4ca78ea484acf6b9247e72f2d3aecc02f696a6d",
  },
};

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function executableFixture(target) {
  const bytes = Buffer.alloc(128);
  if (target === "darwin-arm64" || target === "darwin-x64") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target === "darwin-arm64" ? 0x0100000c : 0x01000007, 4);
  } else {
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.write("PE\0\0", 0x40, "binary");
    bytes.writeUInt16LE(0x8664, 0x44);
  }
  return bytes;
}

describe("pinned herdr-core packaging", () => {
  it("pins the release, every archive and every executable", () => {
    expect(HERDR_CORE_VERSION).toBe("0.1.21");
    expect(Object.keys(HERDR_CORE_ASSETS).sort()).toEqual(Object.keys(PINNED).sort());
    for (const [target, pinned] of Object.entries(PINNED)) {
      const asset = HERDR_CORE_ASSETS[target];
      expect({ name: asset.name, sha256: asset.sha256, binarySha256: asset.binarySha256 }).toEqual(pinned);
      expect(asset.files[asset.executable]).toBe(asset.binarySha256);
      for (const digest of Object.values(asset.files)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("ships the ConPTY runtime and its licence on Windows only", () => {
    const windows = HERDR_CORE_ASSETS["win32-x64"].files;
    expect(Object.keys(windows)).toEqual(
      expect.arrayContaining(["conpty/conpty.dll", "conpty/x64/OpenConsole.exe", "LICENSE"]),
    );
    expect(Object.keys(HERDR_CORE_ASSETS["darwin-arm64"].files)).not.toContain("conpty/conpty.dll");
  });

  it("stages the licenses output as THIRD-PARTY-NOTICES.txt", () => {
    expect(stagedPath("win32-x64", "THIRD-PARTY-NOTICES/herdr-core.txt")).toBe("THIRD-PARTY-NOTICES.txt");
    expect(stagedPath("darwin-arm64", "THIRD-PARTY-NOTICES")).toBe("THIRD-PARTY-NOTICES.txt");
    expect(stagedPath("win32-x64", "conpty/conpty.dll")).toBe("conpty/conpty.dll");
  });

  it("stages both macOS architectures and only Windows x64 on Windows", () => {
    expect(targetsForHost("darwin")).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(targetsForHost("win32")).toEqual(["win32-x64"]);
    expect(() => targetsForHost("linux")).toThrow(/unsupported/);
    expect(targetForCurrentHost("darwin", "arm64")).toBe("darwin-arm64");
    expect(targetForCurrentHost("win32", "x64")).toBe("win32-x64");
    expect(() => targetForCurrentHost("win32", "arm64")).toThrow(/unsupported/);
    expect(targetsForPreparation({ current: true, platform: "darwin", arch: "x64" })).toEqual(["darwin-x64"]);
    expect(targetsForPreparation({ current: false, platform: "darwin", arch: "x64" })).toHaveLength(2);
  });

  it("accepts only --current and --root DIR", () => {
    expect(parsePrepareHerdrCoreArgs([])).toEqual({ current: false });
    expect(parsePrepareHerdrCoreArgs(["--current", "--root", "/srv"])).toEqual({ current: true, root: "/srv" });
    expect(() => parsePrepareHerdrCoreArgs(["--all"])).toThrow(/Usage:/);
    expect(() => parsePrepareHerdrCoreArgs(["--root"])).toThrow(/Usage:/);
    expect(() => parsePrepareHerdrCoreArgs(["--current", "--current"])).toThrow(/Usage:/);
  });

  it("exposes a build script that runs the preparation", () => {
    expect(packageJson.scripts["build:herdr-core"]).toBe("node scripts/prepare-herdr-core.mjs");
  });

  it("rejects altered release bytes", () => {
    const payload = Buffer.from("official bytes");
    const digest = sha256(payload);
    expect(verifySha256(payload, digest)).toBe(digest);
    expect(() => verifySha256(Buffer.from("altered"), digest)).toThrow(/SHA-256 verification/);
  });

  it("recognizes only the executable formats and architectures we ship", () => {
    for (const target of Object.keys(PINNED)) {
      expect(executableTarget(executableFixture(target))).toBe(target);
    }
    expect(() => executableTarget(Buffer.from("not an executable"))).toThrow(/unsupported/);
    const elf = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
    expect(() => executableTarget(elf)).toThrow(/unsupported/);
    const arm64Windows = executableFixture("win32-x64");
    arm64Windows.writeUInt16LE(0xaa64, 0x44);
    expect(() => executableTarget(arm64Windows)).toThrow(/unsupported/);
  });

  it("checks architecture before accepting a pinned executable", () => {
    const bytes = executableFixture("darwin-arm64");
    expect(() => verifyPinnedBinary(bytes, "darwin-x64")).toThrow(/architecture mismatch/);
    expect(() => verifyPinnedBinary(bytes, "darwin-arm64")).toThrow(/SHA-256 verification/);
    expect(() => verifyPinnedBinary(bytes, "linux-x64")).toThrow(/No pinned/);
  });
});
