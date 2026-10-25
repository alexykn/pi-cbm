import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CbmClient } from "../src/cbm/client.js";
import { IndexCoordinator } from "../src/domain/index-coordinator.js";
import { IndexingService } from "../src/domain/indexing.js";
import { OutputService } from "../src/domain/output.js";
import { ProjectCatalog } from "../src/domain/project-catalog.js";
import { ProjectResolver } from "../src/domain/project-resolver.js";
import { QueryService } from "../src/domain/query.js";
import type { TraceService } from "../src/domain/trace.js";

const FAKE_CBM = fileURLToPath(new URL("./fixtures/fake-cbm.mjs", import.meta.url));
const traceStub = { enrichTraceLocations: async (data: unknown) => data } as unknown as TraceService;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type Workspace = { root: string; cacheDirectory: string; statePath: string };
type Session = ReturnType<typeof session>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function git(root: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: root });
}

/** Push every file and directory below `root` (except .git) `ageMs` into the past. */
async function backdate(root: string, ageMs: number) {
  const time = new Date(Date.now() - ageMs);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (path.split("/").includes(".git")) continue;
    await utimes(path, time, time);
  }
  await utimes(root, time, time);
}

/** A repo whose files are a minute old, a cache dir, and the fake cbm's state. */
async function workspace(files: Record<string, string>, options: { git?: boolean } = {}): Promise<Workspace> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-cbm-freshness-")));
  temporaryDirectories.push(base);
  const root = join(base, "repo");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  if (options.git !== false) {
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
  }
  await backdate(root, 60_000);

  const cacheDirectory = join(base, "cache");
  await mkdir(cacheDirectory);
  const statePath = join(base, "fake-cbm-state.json");
  await writeFile(statePath, JSON.stringify({ projects: [] }));
  await writeFile(`${statePath}.log`, "");
  vi.stubEnv("PI_CBM_BIN", FAKE_CBM);
  vi.stubEnv("PI_CBM_SKIP_VERSION_CHECK", "1");
  vi.stubEnv("FAKE_CBM_STATE", statePath);
  return { root, cacheDirectory, statePath };
}

/** Projects cbm already knows, each indexed (by some other client) `indexedAgoMs` ago. */
async function knownProjects(ws: Workspace, projects: Array<{ name: string; indexedAgoMs: number }>) {
  const state = { projects: projects.map(({ name, indexedAgoMs }) => ({ name, root_path: ws.root, indexed_at: isoSeconds(Date.now() - indexedAgoMs) })) };
  await writeFile(ws.statePath, JSON.stringify(state));
}

/** A pi session: its own client, catalog and coordinator over the shared cache dir. */
function session(ws: Workspace, coordinator = new IndexCoordinator({ cacheDirectory: ws.cacheDirectory })) {
  const cbm = new CbmClient();
  const catalog = new ProjectCatalog(cbm);
  const indexing = new IndexingService(cbm, { autoIndexNonGitDirectories: true }, coordinator, catalog);
  const query = new QueryService(cbm, new ProjectResolver(cbm, catalog), catalog, indexing, new OutputService(), traceStub);
  return { indexing, query };
}

async function detectChanges(s: Session, ws: Workspace, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<string> {
  const result = await s.query.executeQueryTool("Change impact results", "detect_changes", params, { cwd: ws.root, signal });
  return String((result.details.data as Record<string, unknown>).index_freshness);
}

async function loggedCalls(ws: Workspace, tool: string): Promise<Array<Record<string, unknown>>> {
  const lines = (await readFile(`${ws.statePath}.log`, "utf8")).split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.tool === tool);
}

const indexCalls = (ws: Workspace) => loggedCalls(ws, "index_repository");
const finishedIndexes = (ws: Workspace) => loggedCalls(ws, "index_repository:done");
const holdIndexes = (ws: Workspace) => writeFile(`${ws.statePath}.hold`, "");
const releaseIndexes = (ws: Workspace) => unlink(`${ws.statePath}.hold`);

/** A coordinator whose `acquire` waits for `gate`: its session checks now but gets the lease only after `gate` settled. */
function gatedCoordinator(ws: Workspace, gate: Promise<unknown>) {
  const coordinator = new IndexCoordinator({ cacheDirectory: ws.cacheDirectory });
  const acquire = coordinator.acquire.bind(coordinator);
  coordinator.acquire = async (...args: Parameters<typeof acquire>) => {
    await gate.catch(() => undefined);
    return acquire(...args);
  };
  return coordinator;
}

/** Wait until `count` freshness checks asked cbm for its index time, so a later check's verdict is fixed. */
async function waitForStatusCalls(ws: Workspace, count: number) {
  await vi.waitFor(async () => expect(await loggedCalls(ws, "index_status")).toHaveLength(count), { timeout: 10_000 });
}

async function waitForIndexStart(ws: Workspace) {
  await vi.waitFor(async () => expect(await indexCalls(ws)).toHaveLength(1), { timeout: 10_000 });
}

/** Wait for a background index to finish and release its lease, so nothing still writes to the cache dir. */
async function waitForBackgroundIndex(ws: Workspace) {
  await vi.waitFor(async () => expect(await finishedIndexes(ws)).toHaveLength(1), { timeout: 10_000 });
  const probe = new IndexCoordinator({ cacheDirectory: ws.cacheDirectory });
  await vi.waitFor(async () => {
    const lease = await probe.acquire(ws.root);
    if (lease.ok) await lease.lease.release();
    expect(lease.ok).toBe(true);
  }, { timeout: 10_000 });
}

const STALE = [{ name: "repo", indexedAgoMs: 90_000 }];
const FILES = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" };

// Every cbm call spawns the fake binary, which takes seconds on a loaded machine.
describe("detect_changes index freshness", { timeout: 15_000 }, () => {
  it("does not re-index, in any session, when nothing changed since the last index started", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);

    expect(await detectChanges(session(ws), ws)).toMatch(/^fresh: re-indexed/);
    expect(await detectChanges(session(ws), ws)).toMatch(/^fresh: no changes/);
    expect(await indexCalls(ws)).toHaveLength(1);
  });

  it("re-indexes after a file was edited while the previous index was running", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    const s = session(ws);
    await holdIndexes(ws);
    const first = detectChanges(s, ws);
    await waitForIndexStart(ws);
    await writeFile(join(ws.root, "src/a.ts"), "export const a = 2;\n");
    // cbm stamps indexed_at at completion, to the second. Finishing 2 s after the edit puts the edit
    // outside that stamp's 1 s slack, so only the index start time can flag it.
    await sleep(2_100);
    await releaseIndexes(ws);
    await first;

    expect(await detectChanges(s, ws)).toMatch(/^fresh: re-indexed/);
    expect(await indexCalls(ws)).toHaveLength(2);
  });

  it("re-indexes after a tracked file is deleted, but not for a deletion older than the graph", async () => {
    const ws = await workspace({ ...FILES, "src/old.ts": "export const old = 1;\n" });
    await unlink(join(ws.root, "src/old.ts"));
    await utimes(join(ws.root, "src"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await knownProjects(ws, [{ name: "repo", indexedAgoMs: 30_000 }]);
    const s = session(ws);

    expect(await detectChanges(s, ws)).toMatch(/^fresh: no changes/);
    await unlink(join(ws.root, "src/b.ts"));
    expect(await detectChanges(s, ws)).toMatch(/^fresh: re-indexed/);
    expect(await indexCalls(ws)).toHaveLength(1);
  });

  it("re-indexes for a new untracked file, but not for changes to gitignored files", async () => {
    const ws = await workspace({ ...FILES, ".gitignore": "build/\n", "build/out.js": "1\n" });
    await knownProjects(ws, [{ name: "repo", indexedAgoMs: 30_000 }]);
    const s = session(ws);

    await writeFile(join(ws.root, "build/out.js"), "2\n");
    await writeFile(join(ws.root, "build/new.js"), "3\n");
    expect(await detectChanges(s, ws)).toMatch(/^fresh: no changes/);
    await writeFile(join(ws.root, "src/new.ts"), "export const fresh = 1;\n");
    expect(await detectChanges(s, ws)).toMatch(/^fresh: re-indexed/);
    expect(await indexCalls(ws)).toHaveLength(1);
  });

  it("re-indexes the requested project when two projects share its root", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, [...STALE, { name: "custom", indexedAgoMs: 90_000 }]);

    await detectChanges(session(ws), ws, { project: "custom" });
    expect(await indexCalls(ws)).toEqual([expect.objectContaining({ name: "custom", repo_path: ws.root })]);
  });

  it("waits for another session's index and re-checks instead of indexing again", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    await holdIndexes(ws);
    const otherIndex = session(ws).indexing.indexCurrentRepo(ws.root);
    await waitForIndexStart(ws);

    let settled = false;
    const answer = detectChanges(session(ws), ws).finally(() => {
      settled = true;
    });
    await sleep(500);
    expect(settled).toBe(false);
    await releaseIndexes(ws);

    expect(await answer).toMatch(/^fresh: no changes/);
    await otherIndex;
    expect(await indexCalls(ws)).toHaveLength(1);
  });

  it("answers stale on timeout and lets the index finish in the background", async () => {
    vi.stubEnv("PI_CBM_FRESH_INDEX_TIMEOUT_MS", "500");
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    // Another session holds the repo lease, so the refresh cannot start before the timeout.
    const other = await new IndexCoordinator({ cacheDirectory: ws.cacheDirectory }).acquire(ws.root);
    if (!other.ok) throw new Error(other.reason);

    expect(await detectChanges(session(ws), ws)).toMatch(/^stale: re-index queued since .+; changes after .+ may be missing/);
    expect(await indexCalls(ws)).toHaveLength(0);
    await other.lease.release();

    await waitForBackgroundIndex(ws);
  });

  it("stops a cancelled caller's wait without stopping the running index", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    await holdIndexes(ws);
    const controller = new AbortController();
    const answer = detectChanges(session(ws), ws, {}, controller.signal);
    await waitForIndexStart(ws);

    controller.abort();
    await expect(answer).rejects.toThrow(/cancelled/);
    await releaseIndexes(ws);
    await waitForBackgroundIndex(ws);
  });

  it("does not re-index when another session indexed between this call's check and its lease", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    await holdIndexes(ws);
    const first = session(ws).indexing.indexCurrentRepo(ws.root);
    await waitForIndexStart(ws);

    const second = detectChanges(session(ws, gatedCoordinator(ws, first)), ws);
    await waitForStatusCalls(ws, 2);
    await releaseIndexes(ws);

    expect(await first).toMatchObject({ status: "indexed" });
    expect(await second).toMatch(/^fresh: no changes/);
    expect(await indexCalls(ws)).toHaveLength(1);
  });

  it("notices a freed lease promptly however long it has been waiting", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    await holdIndexes(ws);
    const otherIndex = session(ws).indexing.indexCurrentRepo(ws.root);
    await waitForIndexStart(ws);
    // A coordinator whose later retries would outlast the deadline, so only a capped backoff answers fresh.
    const coordinator = new IndexCoordinator({ cacheDirectory: ws.cacheDirectory, retryRanges: [[20, 20], [60_000, 60_000]] });
    const acquire = vi.spyOn(coordinator, "acquire");
    vi.stubEnv("PI_CBM_FRESH_INDEX_TIMEOUT_MS", "10000");
    const answer = detectChanges(session(ws, coordinator), ws);
    await vi.waitFor(() => expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    await releaseIndexes(ws);

    expect(await otherIndex).toMatchObject({ status: "indexed" });
    expect(await answer).toMatch(/^fresh: no changes/);
  });

  it("lets a call made during another call's refresh wait on that same re-index", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    const s = session(ws);
    await holdIndexes(ws);
    const first = detectChanges(s, ws);
    await waitForIndexStart(ws);
    // The index is held, so the second call times out: on the running shared re-index, or, had it
    // started its own refresh, on one still queued behind the first one's lease.
    vi.stubEnv("PI_CBM_FRESH_INDEX_TIMEOUT_MS", "500");
    expect(await detectChanges(s, ws)).toMatch(/^stale: re-index running since .+; changes after .+ may be missing/);
    expect(await finishedIndexes(ws)).toHaveLength(0);
    await releaseIndexes(ws);

    expect(await first).toMatch(/^fresh: re-indexed/);
    expect(await indexCalls(ws)).toHaveLength(1);
  });

  it("re-indexes for an edit made after the joined refresh started indexing", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    const s = session(ws);
    await holdIndexes(ws);
    const first = detectChanges(s, ws);
    await waitForIndexStart(ws);
    await writeFile(join(ws.root, "src/a.ts"), "export const a = 3;\n");
    // No public signal marks the join, so watch the private wait both calls go through.
    const awaitRefresh = vi.spyOn(s.indexing as unknown as { awaitRefresh: () => Promise<unknown> }, "awaitRefresh");
    const second = detectChanges(s, ws);
    await vi.waitFor(() => expect(awaitRefresh).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await releaseIndexes(ws);

    expect(await first).toMatch(/^fresh: re-indexed/);
    expect(await second).toMatch(/^fresh: re-indexed/);
    expect(await indexCalls(ws)).toHaveLength(2);
  });

  it("re-indexes for an edit made less than a second before another client's index stamp", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, [{ name: "repo", indexedAgoMs: 0 }]);
    const state = JSON.parse(await readFile(ws.statePath, "utf8")) as { projects: Array<{ indexed_at: string }> };
    const edited = new Date(Date.parse(state.projects[0]!.indexed_at) - 500);
    await utimes(join(ws.root, "src/a.ts"), edited, edited);

    expect(await detectChanges(session(ws), ws)).toMatch(/^fresh: re-indexed/);
  });

  it("re-indexes after editing a file that only the global git excludes file hides", async () => {
    const ws = await workspace(FILES);
    // Untracked, created after the initial commit and older than the graph. cbm indexes it.
    await mkdir(join(ws.root, "scratch"));
    await writeFile(join(ws.root, "scratch/x.ts"), "export const x = 1;\n");
    await backdate(ws.root, 60_000);
    const base = dirname(ws.root);
    await writeFile(join(base, "global-ignore"), "scratch/\n");
    await writeFile(join(base, "gitconfig"), `[core]\n\texcludesFile = ${join(base, "global-ignore")}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(base, "gitconfig"));
    await knownProjects(ws, [{ name: "repo", indexedAgoMs: 30_000 }]);
    await writeFile(join(ws.root, "scratch/x.ts"), "export const x = 2;\n");

    expect(await detectChanges(session(ws), ws)).toMatch(/^fresh: re-indexed/);
  });

  it("trusts a later index by another client over pi-cbm's own record", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    const s = session(ws);
    await detectChanges(s, ws);
    await writeFile(join(ws.root, "src/a.ts"), "export const a = 2;\n");
    // Another client re-indexed after the edit. Stamped 10 s ahead so the edit lies outside the
    // stamp's 1 s slack without the test sleeping.
    const state = JSON.parse(await readFile(ws.statePath, "utf8")) as { projects: Array<{ indexed_at: string }> };
    state.projects[0]!.indexed_at = isoSeconds(Date.now() + 10_000);
    await writeFile(ws.statePath, JSON.stringify(state));

    expect(await detectChanges(s, ws)).toMatch(/^fresh: no changes/);
    expect(await indexCalls(ws)).toHaveLength(1);
  });
});

describe("auto-refresh freshness", { timeout: 15_000 }, () => {
  it("skips an unchanged repo and indexes it again after a change", async () => {
    const ws = await workspace(FILES);
    const s = session(ws);

    expect(await s.indexing.indexCurrentRepo(ws.root)).toMatchObject({ status: "indexed" });
    expect(await s.indexing.indexCurrentRepo(ws.root)).toMatchObject({ status: "fresh" });
    await writeFile(join(ws.root, "src/a.ts"), "export const a = 2;\n");
    expect(await s.indexing.indexCurrentRepo(ws.root)).toMatchObject({ status: "indexed" });
    expect(await indexCalls(ws)).toHaveLength(2);
    // The check under the lease reuses the first check when no other index finished in between.
    expect(await loggedCalls(ws, "index_status")).toHaveLength(1);
  });

  it("vouches for its own unchanged graph from the index record, without asking cbm", async () => {
    const ws = await workspace(FILES);
    const s = session(ws);
    expect(await s.indexing.indexCurrentRepo(ws.root)).toMatchObject({ status: "indexed" });
    const statusCalls = (await loggedCalls(ws, "index_status")).length;

    expect(await s.indexing.indexCurrentRepo(ws.root)).toMatchObject({ status: "fresh" });
    expect(await loggedCalls(ws, "index_status")).toHaveLength(statusCalls);
  });

  it("does not re-index when another session indexed between this session's check and its lease", async () => {
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    await holdIndexes(ws);
    const first = session(ws).indexing.indexCurrentRepo(ws.root);
    await waitForIndexStart(ws);

    // The second session checks while the first index runs, but gets the lease only after it finished.
    const second = session(ws, gatedCoordinator(ws, first)).indexing.indexCurrentRepo(ws.root);
    await waitForStatusCalls(ws, 2);
    await releaseIndexes(ws);

    expect(await first).toMatchObject({ status: "indexed" });
    expect(await second).toMatchObject({ status: "fresh" });
    expect(await indexCalls(ws)).toHaveLength(1);
  });

  it("always indexes a non-git root", async () => {
    const ws = await workspace(FILES, { git: false });
    const s = session(ws);

    expect(await s.indexing.indexCurrentRepo(ws.root)).toMatchObject({ status: "indexed" });
    expect(await s.indexing.indexCurrentRepo(ws.root)).toMatchObject({ status: "indexed" });
  });
});
