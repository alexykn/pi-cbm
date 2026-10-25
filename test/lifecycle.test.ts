import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CbmServices } from "../src/pi-tools/definitions.js";

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllEnvs();
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
    const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
    const pi = {
      on(event: string, handler: (event: unknown, context: unknown) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    const indexCurrentRepo = vi.fn().mockResolvedValue({ status: "indexed", project: "repo" });
    const services = {
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
