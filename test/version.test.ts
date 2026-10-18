import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnControl = vi.hoisted(() => ({ spy: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnControl.spy };
});

import {
  checkCbmVersion,
  consumeCbmVersionWarning,
  evaluateCbmVersion,
  parseCbmVersion,
  SUPPORTED_CBM_VERSION_RANGE,
} from "../src/cbm/version.js";

class VersionChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  readonly kill = vi.fn();
}

function respondWith(events: Array<string | Error>): void {
  for (const event of events) {
    spawnControl.spy.mockImplementationOnce(() => {
      const child = new VersionChildProcess();
      queueMicrotask(() => {
        if (event instanceof Error) child.emit("error", event);
        else {
          child.stdout.emit("data", Buffer.from(event));
          child.emit("close", 0, null);
        }
      });
      return child as unknown as ChildProcess;
    });
  }
}

function versionFixture(version: string): string {
  return readFileSync(new URL(`./fixtures/cbm-${version}/version.long-flag.json`, import.meta.url), "utf8");
}

beforeEach(() => {
  spawnControl.spy.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  consumeCbmVersionWarning();
});

describe("cbm version parsing", () => {
  it("parses the captured 0.12.1 --version output", () => {
    expect(parseCbmVersion(versionFixture("0.12.1"))).toEqual({ major: 0, minor: 12, patch: 1 });
  });

  it("parses the captured 0.9.0 --version output", () => {
    expect(parseCbmVersion(versionFixture("0.9.0"))).toEqual({ major: 0, minor: 9, patch: 0 });
  });

  it("accepts 0.12.x", () => {
    expect(evaluateCbmVersion({ major: 0, minor: 12, patch: 1 })).toEqual({ status: "ok", version: "0.12.1" });
  });

  it("rejects 0.9.0 with the version and reinstall guidance", () => {
    const check = evaluateCbmVersion(parseCbmVersion(versionFixture("0.9.0")));
    expect(check.status).toBe("too-old");
    expect(check.message).toContain("0.9.0");
    expect(check.message).toContain(SUPPORTED_CBM_VERSION_RANGE);
    expect(check.message).toContain("reinstall an earlier pi-cbm release");
  });

  it("warns but allows a newer 0.13.0", () => {
    const check = evaluateCbmVersion({ major: 0, minor: 13, patch: 0 });
    expect(check.status).toBe("untested-newer");
    expect(check.warning).toContain(SUPPORTED_CBM_VERSION_RANGE);
  });

  it("treats unparseable output as unknown and allowed", () => {
    const check = evaluateCbmVersion(parseCbmVersion("not a version"));
    expect(check.status).toBe("unknown");
    expect(check.warning).toBeTruthy();
  });
});

describe("cbm version gate", () => {
  it("probes once per binary path and surfaces the warning once", async () => {
    const binary = "/tmp/pi-cbm-version-memo";
    respondWith(["codebase-memory-mcp 0.13.0"]);

    const first = await checkCbmVersion(binary);
    const second = await checkCbmVersion(binary);

    expect(first.status).toBe("untested-newer");
    expect(second).toBe(first);
    expect(spawnControl.spy).toHaveBeenCalledTimes(1);
    expect(consumeCbmVersionWarning()).toContain(SUPPORTED_CBM_VERSION_RANGE);
    expect(consumeCbmVersionWarning()).toBeUndefined();
  });

  it("re-probes after a spawn error instead of caching the failure", async () => {
    const binary = "/tmp/pi-cbm-version-retry";
    respondWith([new Error("spawn ENOENT"), "codebase-memory-mcp 0.12.1"]);

    const first = await checkCbmVersion(binary);
    const second = await checkCbmVersion(binary);

    expect(first.status).toBe("unknown");
    expect(second.status).toBe("ok");
    expect(second.version).toBe("0.12.1");
    expect(spawnControl.spy).toHaveBeenCalledTimes(2);
  });

  it("caches readable but unparseable output", async () => {
    const binary = "/tmp/pi-cbm-version-garbage";
    respondWith(["not a version", "codebase-memory-mcp 0.12.1"]);

    expect((await checkCbmVersion(binary)).status).toBe("unknown");
    expect((await checkCbmVersion(binary)).status).toBe("unknown");
    expect(spawnControl.spy).toHaveBeenCalledTimes(1);
  });

  it("bypasses the probe when PI_CBM_SKIP_VERSION_CHECK=1", async () => {
    vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");

    await expect(checkCbmVersion("/tmp/pi-cbm-version-skip")).resolves.toEqual({ status: "ok" });
    expect(spawnControl.spy).not.toHaveBeenCalled();
  });
});
