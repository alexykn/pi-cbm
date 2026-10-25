import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnControl = vi.hoisted(() => ({ spy: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnControl.spy };
});

import { CbmVersionGate, evaluateCbmVersion, parseCbmVersion, SUPPORTED_CBM_VERSION_RANGE } from "../src/cbm/version.js";

class VersionChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  readonly kill = vi.fn();
}

/** One spawn per event: version output, a spawn error, or "hang" for a binary that never exits. */
function respondWith(events: Array<string | Error>): void {
  for (const event of events) {
    spawnControl.spy.mockImplementationOnce(() => {
      const child = new VersionChildProcess();
      queueMicrotask(() => {
        if (event === "hang") return;
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
  it("probes once per binary path and hands out the warning once", async () => {
    const gate = new CbmVersionGate();
    respondWith(["codebase-memory-mcp 0.13.0"]);

    const first = await gate.check("/tmp/pi-cbm-version-memo");
    const second = await gate.check("/tmp/pi-cbm-version-memo");

    expect(first.status).toBe("untested-newer");
    expect(second).toBe(first);
    expect(spawnControl.spy).toHaveBeenCalledTimes(1);
    expect(gate.takeNotices()).toEqual([{ level: "warning", message: expect.stringContaining(SUPPORTED_CBM_VERSION_RANGE) }]);
    expect(gate.takeNotices()).toEqual([]);
  });

  it("hands out a too-old binary as an error notice telling the user to upgrade", async () => {
    const gate = new CbmVersionGate();
    respondWith(["codebase-memory-mcp 0.9.0"]);

    expect((await gate.check("/tmp/pi-cbm-version-old")).status).toBe("too-old");
    expect(gate.takeNotices()).toEqual([{ level: "error", message: expect.stringMatching(/0\.9\.0 is unsupported.*Upgrade codebase-memory-mcp/) }]);
  });

  it("keeps state per gate, so a second client probes and warns on its own", async () => {
    respondWith(["codebase-memory-mcp 0.13.0", "codebase-memory-mcp 0.13.0"]);
    const first = new CbmVersionGate();
    const second = new CbmVersionGate();

    await first.check("/tmp/pi-cbm-version-shared");
    await second.check("/tmp/pi-cbm-version-shared");

    expect(spawnControl.spy).toHaveBeenCalledTimes(2);
    expect(first.takeNotices()).toHaveLength(1);
    expect(second.takeNotices()).toHaveLength(1);
  });

  it("caches an unknown result after a spawn error for a short TTL, then re-probes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const gate = new CbmVersionGate();
    respondWith([new Error("spawn ENOENT"), "codebase-memory-mcp 0.12.1"]);

    expect((await gate.check("/tmp/pi-cbm-version-retry")).status).toBe("unknown");
    expect((await gate.check("/tmp/pi-cbm-version-retry")).status).toBe("unknown");
    expect(spawnControl.spy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 60_001);
    const retried = await gate.check("/tmp/pi-cbm-version-retry");
    expect(retried).toMatchObject({ status: "ok", version: "0.12.1" });
    expect(spawnControl.spy).toHaveBeenCalledTimes(2);
  });

  it("lets an aborted caller stop waiting on a hung probe", async () => {
    const gate = new CbmVersionGate();
    respondWith(["hang"]);
    const controller = new AbortController();

    const waiting = gate.check("/tmp/pi-cbm-version-hang", controller.signal);
    controller.abort();

    await expect(waiting).rejects.toThrow(/cancelled/);
  });

  it("caches readable but unparseable output", async () => {
    const gate = new CbmVersionGate();
    respondWith(["not a version", "codebase-memory-mcp 0.12.1"]);

    expect((await gate.check("/tmp/pi-cbm-version-garbage")).status).toBe("unknown");
    expect((await gate.check("/tmp/pi-cbm-version-garbage")).status).toBe("unknown");
    expect(spawnControl.spy).toHaveBeenCalledTimes(1);
  });

  it("bypasses the probe when PI_CBM_SKIP_VERSION_CHECK=1", async () => {
    vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");

    await expect(new CbmVersionGate().check("/tmp/pi-cbm-version-skip")).resolves.toEqual({ status: "ok" });
    expect(spawnControl.spy).not.toHaveBeenCalled();
  });
});
