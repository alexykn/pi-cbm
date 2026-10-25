import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexCoordinator } from "../src/domain/index-coordinator.js";
import { IndexingService } from "../src/domain/indexing.js";
import { ProjectCatalog } from "../src/domain/project-catalog.js";

// Workers import the TypeScript source directly; Node strips the types.
const COORDINATOR_MODULE_PATH = fileURLToPath(new URL("../src/domain/index-coordinator.ts", import.meta.url));

const FAST_RETRY_OPTIONS = {
  retryRanges: [[1, 1] as const] as const,
  random: () => 0,
  heartbeatMs: 20,
  staleAfterMs: 100,
  queueLockStaleAfterMs: 100,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("IndexCoordinator", () => {
  it("allows only one indexer for a repository", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });

    const first = await coordinator.acquire(repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await coordinator.acquire(repo);
    expect(second).toEqual({ ok: false, reason: "another session is indexing; retry deferred" });

    await first.lease.release();
    const third = await coordinator.acquire(repo);
    expect(third.ok).toBe(true);
    if (third.ok) await third.lease.release();
  });

  it("limits different repositories to one global token by default", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const secondRepo = join(cacheDirectory, "second-repo");
    await mkdir(secondRepo);
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });

    const first = await coordinator.acquire(repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let secondSettled = false;
    const secondPromise = coordinator.acquire(secondRepo).then((result) => {
      secondSettled = true;
      return result;
    });
    await delay(10);
    expect(secondSettled).toBe(false);

    await first.lease.release();
    const second = await secondPromise;
    expect(second.ok).toBe(true);
    if (second.ok) await second.lease.release();
  });

  it("allows the configured number of repositories to index concurrently", async () => {
    vi.stubEnv("PI_CBM_MAX_CONCURRENT_INDEXES", "2");
    const { cacheDirectory, repo } = await createFixture();
    const secondRepo = join(cacheDirectory, "second-repo");
    const thirdRepo = join(cacheDirectory, "third-repo");
    await Promise.all([mkdir(secondRepo), mkdir(thirdRepo)]);
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });

    const first = await coordinator.acquire(repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const secondPromise = coordinator.acquire(secondRepo);
    await delay(10);
    const thirdPromise = coordinator.acquire(thirdRepo);
    const second = await secondPromise;
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    let thirdSettled = false;
    const trackedThird = thirdPromise.then((result) => {
      thirdSettled = true;
      return result;
    });
    await delay(10);
    expect(thirdSettled).toBe(false);

    await first.lease.release();
    const third = await trackedThird;
    expect(third.ok).toBe(true);

    await second.lease.release();
    if (third.ok) await third.lease.release();
  });

  it("processes repository requests in FIFO order", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const secondRepo = join(cacheDirectory, "second-repo");
    const thirdRepo = join(cacheDirectory, "third-repo");
    await Promise.all([mkdir(secondRepo), mkdir(thirdRepo)]);
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });

    const first = await coordinator.acquire(repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const secondPromise = coordinator.acquire(secondRepo);
    await delay(10);
    const thirdPromise = coordinator.acquire(thirdRepo);
    await delay(10);

    await first.lease.release();
    const second = await secondPromise;
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    let thirdSettled = false;
    const trackedThird = thirdPromise.then((result) => {
      thirdSettled = true;
      return result;
    });
    await delay(10);
    expect(thirdSettled).toBe(false);

    await second.lease.release();
    const third = await trackedThird;
    expect(third.ok).toBe(true);
    if (third.ok) await third.lease.release();
  });

  it("coalesces duplicate pending requests for one repository", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const occupiedRepo = join(cacheDirectory, "occupied-repo");
    await mkdir(occupiedRepo);
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });

    const occupied = await coordinator.acquire(occupiedRepo);
    expect(occupied.ok).toBe(true);
    if (!occupied.ok) return;

    const firstPending = coordinator.acquire(repo);
    await delay(10);
    const duplicate = await coordinator.acquire(repo);
    expect(duplicate).toEqual({ ok: false, reason: "another session is indexing; retry deferred" });

    await occupied.lease.release();
    const first = await firstPending;
    expect(first.ok).toBe(true);
    if (first.ok) await first.lease.release();
  });

  it("removes a cancelled request from the queue", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const occupiedRepo = join(cacheDirectory, "occupied-repo");
    await mkdir(occupiedRepo);
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });

    const occupied = await coordinator.acquire(occupiedRepo);
    expect(occupied.ok).toBe(true);
    if (!occupied.ok) return;

    const controller = new AbortController();
    const waiting = coordinator.acquire(repo, controller.signal);
    await delay(10);
    controller.abort();
    expect(await waiting).toEqual({ ok: false, reason: "indexing was cancelled" });

    await occupied.lease.release();
    const retry = await coordinator.acquire(repo);
    expect(retry.ok).toBe(true);
    if (retry.ok) await retry.lease.release();
  });

  it("uses the configured cache directory from the environment", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const configuredCache = join(cacheDirectory, "configured-cache");
    vi.stubEnv("CBM_CACHE_DIR", join(cacheDirectory, "legacy-cache"));
    vi.stubEnv("PI_CBM_CACHE_DIR", configuredCache);
    const coordinator = new IndexCoordinator(FAST_RETRY_OPTIONS);

    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const canonicalRepo = await realpath(repo);
    const key = createHash("sha256").update(canonicalRepo).digest("hex");
    await expect(stat(join(configuredCache, "pi-cbm", "locks", `${key}.lock`))).resolves.toBeDefined();
    await result.lease.release();
  });

  it("follows cbm's own CBM_CACHE_DIR when PI_CBM_CACHE_DIR is unset", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const configuredCache = join(cacheDirectory, "upstream-cache");
    vi.stubEnv("PI_CBM_CACHE_DIR", "");
    vi.stubEnv("CBM_CACHE_DIR", configuredCache);
    const coordinator = new IndexCoordinator(FAST_RETRY_OPTIONS);

    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const canonicalRepo = await realpath(repo);
    const key = createHash("sha256").update(canonicalRepo).digest("hex");
    await expect(stat(join(configuredCache, "pi-cbm", "locks", `${key}.lock`))).resolves.toBeDefined();
    await result.lease.release();
  });

  it("uses jittered one-to-two-second retries when the queue is occupied", async () => {
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const { cacheDirectory, repo } = await createFixture();
    const occupiedRepo = join(cacheDirectory, "occupied-repo");
    await mkdir(occupiedRepo);
    const coordinator = new IndexCoordinator({ cacheDirectory, random: () => 0.5, heartbeatMs: 0 });

    const occupied = await coordinator.acquire(occupiedRepo);
    expect(occupied.ok).toBe(true);
    if (!occupied.ok) return;

    const controller = new AbortController();
    const waiting = coordinator.acquire(repo, controller.signal);
    for (let attempt = 0; attempt < 100 && !timerSpy.mock.calls.some(([, delayValue]) => delayValue === 1_500); attempt += 1) {
      await delay(10);
    }
    const delays = timerSpy.mock.calls.map(([, delayValue]) => delayValue);
    expect(delays).toContain(1_500);

    controller.abort();
    expect(await waiting).toEqual({ ok: false, reason: "indexing was cancelled" });
    await occupied.lease.release();
  });

  it("uses one as the safe fallback for an invalid concurrency environment value", async () => {
    vi.stubEnv("PI_CBM_MAX_CONCURRENT_INDEXES", "not-a-number");
    const { cacheDirectory, repo } = await createFixture();
    const secondRepo = join(cacheDirectory, "second-repo");
    await mkdir(secondRepo);
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });

    const first = await coordinator.acquire(repo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let settled = false;
    const secondPromise = coordinator.acquire(secondRepo).then((result) => {
      settled = true;
      return result;
    });
    await delay(10);
    expect(settled).toBe(false);

    await first.lease.release();
    const second = await secondPromise;
    expect(second.ok).toBe(true);
    if (second.ok) await second.lease.release();
  });

  it("prevents overlapping same-repository indexers across processes", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const eventDirectory = join(cacheDirectory, "events");
    await mkdir(eventDirectory);

    const workerPath = fileURLToPath(new URL("./fixtures/coordinator-worker.mjs", import.meta.url));
    const modulePath = COORDINATOR_MODULE_PATH;
    await Promise.all([
      runWorker(workerPath, modulePath, cacheDirectory, repo, eventDirectory, "a"),
      runWorker(workerPath, modulePath, cacheDirectory, repo, eventDirectory, "b"),
    ]);

    const events = await readdir(eventDirectory);
    const intervals = events
      .filter((name) => name.includes("-start-"))
      .map((name) => {
        const parts = name.split("-");
        return { start: Number(parts[0]), label: parts[1] };
      })
      .sort((a, b) => a.start - b.start);
    const ends = new Map<string, number>();
    for (const name of events) {
      const parts = name.split("-");
      if (parts[2] === "end") ends.set(parts[1], Number(parts[0]));
    }

    expect(intervals.length).toBeGreaterThan(0);
    for (let index = 1; index < intervals.length; index += 1) {
      expect(intervals[index]!.start).toBeGreaterThanOrEqual(ends.get(intervals[index - 1]!.label)!);
    }
  });

  it("enforces the global limit across separate processes", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const secondRepo = join(cacheDirectory, "second-repo");
    const thirdRepo = join(cacheDirectory, "third-repo");
    const eventDirectory = join(cacheDirectory, "events");
    await Promise.all([mkdir(secondRepo), mkdir(thirdRepo), mkdir(eventDirectory)]);

    const workerPath = fileURLToPath(new URL("./fixtures/coordinator-worker.mjs", import.meta.url));
    const modulePath = COORDINATOR_MODULE_PATH;
    const workers = [
      runWorker(workerPath, modulePath, cacheDirectory, repo, eventDirectory, "a"),
      runWorker(workerPath, modulePath, cacheDirectory, secondRepo, eventDirectory, "b"),
      runWorker(workerPath, modulePath, cacheDirectory, thirdRepo, eventDirectory, "c"),
    ];
    await Promise.all(workers);

    const events = await readdir(eventDirectory);
    expect(events.some((name) => name.includes("skipped"))).toBe(false);
    const intervals = events
      .filter((name) => name.includes("-start-"))
      .map((name) => {
        const parts = name.split("-");
        return { label: parts[1], start: Number(parts[0]) };
      })
      .sort((a, b) => a.start - b.start);

    const ends = new Map<string, number>();
    for (const name of events) {
      const parts = name.split("-");
      if (parts[2] === "end") ends.set(parts[1], Number(parts[0]));
    }

    expect(intervals).toHaveLength(3);
    for (let index = 1; index < intervals.length; index += 1) {
      const previousEnd = ends.get(intervals[index - 1]!.label);
      expect(previousEnd).toBeDefined();
      expect(intervals[index]!.start).toBeGreaterThanOrEqual(previousEnd!);
    }
  });

  it("releases both coordination resources when indexing fails", async () => {
    const { cacheDirectory, repo } = await createFixture();
    let shouldFail = true;
    const cbm = {
      findGitRoot: async () => repo,
      callTool: async () => {
        if (shouldFail) throw new Error("index failed");
        return { ok: true, data: { project: "repo" }, rawText: "", stderr: "" };
      },
    } as unknown as ConstructorParameters<typeof IndexingService>[0];
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });
    const service = new IndexingService(cbm, { autoIndexNonGitDirectories: false }, coordinator, new ProjectCatalog(cbm));

    await expect(service.indexCurrentRepo(repo)).rejects.toThrow("index failed");
    shouldFail = false;
    const result = await service.indexCurrentRepo(repo);
    expect(result).toMatchObject({ status: "indexed", project: "repo" });
  });

  it("does not collapse POSIX paths containing a backslash", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const backslashRepo = join(cacheDirectory, "repo\\name");
    const slashRepo = join(cacheDirectory, "repo", "name");
    await Promise.all([mkdir(backslashRepo), mkdir(slashRepo, { recursive: true })]);
    const coordinator = new IndexCoordinator({ cacheDirectory, maxConcurrentIndexes: 2, ...FAST_RETRY_OPTIONS });

    const [first, second] = await Promise.all([coordinator.acquire(backslashRepo), coordinator.acquire(slashRepo)]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) await first.lease.release();
    if (second.ok) await second.lease.release();
  });

  it("recovers from malformed pending metadata", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const canonicalRepo = await realpath(repo);
    const key = createHash("sha256").update(canonicalRepo).digest("hex");
    const pendingDirectory = join(cacheDirectory, "pi-cbm", "index-pending");
    await mkdir(pendingDirectory, { recursive: true });
    await writeFile(join(pendingDirectory, `${key}.json`), "{malformed");

    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });
    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (result.ok) await result.lease.release();
  });

  it("does not let a recycled PID keep a pending request alive", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const canonicalRepo = await realpath(repo);
    const key = createHash("sha256").update(canonicalRepo).digest("hex");
    const pendingDirectory = join(cacheDirectory, "pi-cbm", "index-pending");
    await mkdir(pendingDirectory, { recursive: true });
    await writeFile(
      join(pendingDirectory, `${key}.json`),
      JSON.stringify({ key, requestId: "previous-request", repoPath: canonicalRepo, pid: process.pid, processInstanceId: "previous-process", startedAt: Date.now() }),
    );

    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });
    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (result.ok) await result.lease.release();
  });

  it("does not let a recycled PID keep a queue entry alive", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const queueDirectory = join(cacheDirectory, "pi-cbm", "index-queue");
    await mkdir(queueDirectory, { recursive: true });
    await writeFile(
      join(queueDirectory, "00000000000000000001-previous-key-previous-request.json"),
      JSON.stringify({
        key: "previous-key",
        requestId: "previous-request",
        repoPath: "/previous-repo",
        pid: process.pid,
        processInstanceId: "previous-process",
        startedAt: Date.now(),
      }),
    );

    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });
    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (result.ok) await result.lease.release();
  });

  it("removes malformed queue entries before claiming a slot", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const queueDirectory = join(cacheDirectory, "pi-cbm", "index-queue");
    await mkdir(queueDirectory, { recursive: true });
    await writeFile(join(queueDirectory, "00000000000000000001-corrupt.json"), "{malformed");

    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });
    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (result.ok) await result.lease.release();
    await expect(readdir(queueDirectory)).resolves.not.toContain("00000000000000000001-corrupt.json");
  });

  it("does not remove a replacement lock after ownership is lost", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const canonicalRepo = await realpath(repo);
    const key = createHash("sha256").update(canonicalRepo).digest("hex");
    const lockPath = join(cacheDirectory, "pi-cbm", "locks", `${key}.lock`);
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });

    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const replacement = { token: "foreign", pid: process.pid, processInstanceId: "foreign-process", startedAt: Date.now() };
    await writeFile(lockPath, JSON.stringify(replacement));
    await result.lease.release();

    await expect(readFile(lockPath, "utf8")).resolves.toBe(JSON.stringify(replacement));
  });

  it.each(["SIGINT", "SIGTERM"] as const)("cleans owned resources on %s", async (signal) => {
    if (process.platform === "win32") return;

    const { cacheDirectory, repo } = await createFixture();
    const eventDirectory = join(cacheDirectory, "events");
    await mkdir(eventDirectory);
    const workerPath = fileURLToPath(new URL("./fixtures/coordinator-signal-worker.mjs", import.meta.url));
    const modulePath = COORDINATOR_MODULE_PATH;
    const child = spawn(process.execPath, [workerPath, modulePath, cacheDirectory, repo, eventDirectory], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    try {
      await waitForPath(join(eventDirectory, "ready"));
      expect(child.kill(signal)).toBe(true);
      const exit = await waitForChild(child);
      expect(exit.signal).toBe(signal);

      for (const directory of ["locks", "index-slots", "index-queue", "index-pending"]) {
        await expect(readdir(join(cacheDirectory, "pi-cbm", directory))).resolves.toEqual([]);
      }
      await expect(stat(join(cacheDirectory, "pi-cbm", `process-${child.pid}.json`))).rejects.toThrow();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("reclaims resources after an uncatchable process crash", async () => {
    if (process.platform === "win32") return;

    const { cacheDirectory, repo } = await createFixture();
    const eventDirectory = join(cacheDirectory, "events");
    await mkdir(eventDirectory);
    const workerPath = fileURLToPath(new URL("./fixtures/coordinator-signal-worker.mjs", import.meta.url));
    const modulePath = COORDINATOR_MODULE_PATH;
    const child = spawn(process.execPath, [workerPath, modulePath, cacheDirectory, repo, eventDirectory], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    try {
      await waitForPath(join(eventDirectory, "ready"));
      expect(child.kill("SIGKILL")).toBe(true);
      await waitForChild(child);

      const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS, staleAfterMs: 60_000 });
      const result = await coordinator.acquire(repo);
      expect(result.ok).toBe(true);
      if (result.ok) await result.lease.release();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("does not reclaim a stale lease while its process instance is alive", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const markerRepo = join(cacheDirectory, "marker-repo");
    await mkdir(markerRepo);
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });
    const markerLease = await coordinator.acquire(markerRepo);
    expect(markerLease.ok).toBe(true);
    if (markerLease.ok) await markerLease.lease.release();

    const markerPath = join(cacheDirectory, "pi-cbm", `process-${process.pid}.json`);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { instanceId: string };
    const canonicalRepo = await realpath(repo);
    const key = createHash("sha256").update(canonicalRepo).digest("hex");
    const lockDirectory = join(cacheDirectory, "pi-cbm", "locks");
    const lockPath = join(lockDirectory, `${key}.lock`);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ token: "live", pid: process.pid, processInstanceId: marker.instanceId, startedAt: Date.now() }),
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const result = await coordinator.acquire(repo);
    expect(result).toEqual({ ok: false, reason: "another session is indexing; retry deferred" });
  });

  it("keeps one stable process identity across coordinators", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const first = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });
    const firstResult = await first.acquire(repo);
    expect(firstResult.ok).toBe(true);
    if (firstResult.ok) await firstResult.lease.release();

    const markerPath = join(cacheDirectory, "pi-cbm", `process-${process.pid}.json`);
    const firstMarker = JSON.parse(await readFile(markerPath, "utf8")) as { pid: number; instanceId: string };
    const second = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });
    const secondResult = await second.acquire(repo);
    expect(secondResult.ok).toBe(true);
    if (secondResult.ok) await secondResult.lease.release();

    const secondMarker = JSON.parse(await readFile(markerPath, "utf8")) as { pid: number; instanceId: string };
    expect(secondMarker).toEqual(firstMarker);
  });

  it("reclaims a stale lease when the PID belongs to another process instance", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS });
    const markerRepo = join(cacheDirectory, "marker-repo");
    await mkdir(markerRepo);
    const markerLease = await coordinator.acquire(markerRepo);
    expect(markerLease.ok).toBe(true);
    if (markerLease.ok) await markerLease.lease.release();

    const canonicalRepo = await realpath(repo);
    const key = createHash("sha256").update(canonicalRepo).digest("hex");
    const lockDirectory = join(cacheDirectory, "pi-cbm", "locks");
    const lockPath = join(lockDirectory, `${key}.lock`);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ token: "recycled", pid: process.pid, processInstanceId: "previous-process", startedAt: Date.now() }),
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (result.ok) await result.lease.release();
  });

  it("reclaims an old malformed lease record", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const canonicalRepo = await realpath(repo);
    const key = createHash("sha256").update(canonicalRepo).digest("hex");
    const lockDirectory = join(cacheDirectory, "pi-cbm", "locks");
    const lockPath = join(lockDirectory, `${key}.lock`);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(lockPath, "{malformed");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS, staleAfterMs: 1 });
    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (result.ok) await result.lease.release();
  });

  it("reclaims a stale lease whose owner process is gone", async () => {
    const { cacheDirectory, repo } = await createFixture();
    const canonicalRepo = await realpath(repo);
    const key = createHash("sha256").update(canonicalRepo).digest("hex");
    const lockDirectory = join(cacheDirectory, "pi-cbm", "locks");
    const lockPath = join(lockDirectory, `${key}.lock`);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ token: "dead", pid: 999_999_999, processInstanceId: "dead-process", startedAt: Date.now() }),
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const coordinator = new IndexCoordinator({ cacheDirectory, ...FAST_RETRY_OPTIONS, staleAfterMs: 1 });
    const result = await coordinator.acquire(repo);
    expect(result.ok).toBe(true);
    if (result.ok) await result.lease.release();
  });
});

async function createFixture(): Promise<{ cacheDirectory: string; repo: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-cbm-test-"));
  temporaryDirectories.push(directory);
  const repo = join(directory, "repo");
  const cacheDirectory = join(directory, "cache");
  await Promise.all([mkdir(repo), mkdir(cacheDirectory)]);
  return { cacheDirectory, repo };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => resolveChild({ code, signal }));
  });
}

function runWorker(
  workerPath: string,
  modulePath: string,
  cacheDirectory: string,
  repoPath: string,
  eventDirectory: string,
  label: string,
): Promise<void> {
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, [workerPath, modulePath, cacheDirectory, repoPath, "1", eventDirectory, label], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectWorker);
    child.on("close", (code) => {
      if (code === 0 || code === 2) {
        resolveWorker();
        return;
      }
      rejectWorker(new Error(`coordinator worker exited with ${code}: ${stderr}`));
    });
  });
}
