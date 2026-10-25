import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CbmClient } from "../src/cbm/client.js";
import type { CbmServices } from "../src/pi-tools/definitions.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A cbm binary that only answers `--version`. */
async function binaryReporting(version: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-cbm-lifecycle-test-"));
  temporaryDirectories.push(directory);
  const binaryPath = join(directory, "fake-codebase-memory.mjs");
  await writeFile(binaryPath, `#!/usr/bin/env node\nif (process.argv.includes("--version")) process.stdout.write("codebase-memory-mcp ${version}\\n");\n`);
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

function registerHandlers() {
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { handlers, pi };
}

describe("lifecycle cbm version notices", () => {
  it("tells the user once to upgrade a too-old cbm, not on every session", async () => {
    vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", await binaryReporting("0.9.0"));
    const { registerLifecycle } = await import("../src/extension/lifecycle.js");
    const { handlers, pi } = registerHandlers();
    const cbm = new CbmClient();
    const checkVersion = vi.spyOn(cbm, "checkVersion");
    const services = {
      cbm,
      indexing: { indexCurrentRepo: vi.fn().mockResolvedValue({ status: "skipped", reason: "outside any repository" }) },
      settings: { reload: vi.fn() },
    } as unknown as CbmServices;
    const notify = vi.fn();
    const context = { cwd: "/repo", signal: new AbortController().signal, ui: { setStatus: vi.fn(), notify } };

    registerLifecycle(pi, services);
    handlers.get("session_start")?.({}, context);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    handlers.get("session_shutdown")?.({}, context);
    handlers.get("session_start")?.({}, context);
    await checkVersion.mock.results[1]!.value;
    await new Promise((resolve) => setImmediate(resolve));
    handlers.get("session_shutdown")?.({}, context);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/0\.9\.0 is unsupported.*Upgrade codebase-memory-mcp/), "error");
  });
});

describe("lifecycle auto-refresh", () => {
  it.each([
    { primary: undefined, legacy: undefined, expectedInterval: 60_000 },
    { primary: "25", legacy: undefined, expectedInterval: 25 },
    { primary: undefined, legacy: "35", expectedInterval: 35 },
    { primary: "25", legacy: "35", expectedInterval: 25 },
    { primary: "0", legacy: "35", expectedInterval: 60_000 },
    { primary: "not-a-number", legacy: "35", expectedInterval: 60_000 },
  ])("uses $expectedInterval ms for primary=$primary legacy=$legacy", async ({ primary, legacy, expectedInterval }) => {
    vi.useFakeTimers();
    vi.stubEnv("PI_CBM_AUTO_REFRESH_INTERVAL_MS", primary ?? "");
    vi.stubEnv("CBM_AUTO_REFRESH_INTERVAL_MS", legacy ?? "");

    const { registerLifecycle } = await import("../src/extension/lifecycle.js");
    const { handlers, pi } = registerHandlers();
    const indexCurrentRepo = vi.fn().mockResolvedValue({ status: "indexed", project: "repo" });
    const services = {
      cbm: { checkVersion: async () => ({ status: "ok" }), takeVersionNotices: () => [] },
      indexing: { indexCurrentRepo },
      settings: { reload: vi.fn() },
    } as unknown as CbmServices;
    const context = {
      cwd: "/repo",
      signal: new AbortController().signal,
      ui: { setStatus: vi.fn() },
    };

    registerLifecycle(pi, services);
    handlers.get("session_start")?.({}, context);
    expect(indexCurrentRepo).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(expectedInterval - 1);
    expect(indexCurrentRepo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(indexCurrentRepo).toHaveBeenCalledTimes(2);

    handlers.get("session_shutdown")?.({}, context);
    await vi.advanceTimersByTimeAsync(expectedInterval * 2);
    expect(indexCurrentRepo).toHaveBeenCalledTimes(2);
  });
});
