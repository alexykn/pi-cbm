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
  vi.stubEnv("CODEBASE_MEMORY_MCP_BIN", FAKE_CBM);
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
function session(ws: Workspace) {
  const cbm = new CbmClient();
  const catalog = new ProjectCatalog(cbm);
  const indexing = new IndexingService(cbm, { autoIndexNonGitDirectories: true }, new IndexCoordinator({ cacheDirectory: ws.cacheDirectory }), catalog);
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

async function waitForIndexStart(ws: Workspace) {
  await vi.waitFor(async () => expect(await indexCalls(ws)).toHaveLength(1), { timeout: 10_000 });
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
    await holdIndexes(ws);

    expect(await detectChanges(session(ws), ws)).toMatch(/^stale: re-index running since .+; changes after .+ may be missing/);
    expect(await finishedIndexes(ws)).toHaveLength(0);
    await releaseIndexes(ws);

    const probe = new IndexCoordinator({ cacheDirectory: ws.cacheDirectory });
    await vi.waitFor(async () => {
      const lease = await probe.acquire(ws.root);
      if (lease.ok) await lease.lease.release();
      expect(lease.ok).toBe(true);
    }, { timeout: 10_000 });
    expect(await finishedIndexes(ws)).toHaveLength(1);
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
    await vi.waitFor(async () => expect(await finishedIndexes(ws)).toHaveLength(1), { timeout: 10_000 });
  });

  it("lets a call made during another call's refresh wait on that same re-index", async () => {
    vi.stubEnv("PI_CBM_FRESH_INDEX_TIMEOUT_MS", "500");
    const ws = await workspace(FILES);
    await knownProjects(ws, STALE);
    const s = session(ws);
    await holdIndexes(ws);
    const first = detectChanges(s, ws);
    await waitForIndexStart(ws);
    // Both time out while the index is held; a call with its own refresh would report that one as queued.
    const second = await detectChanges(s, ws);

    expect(second).toMatch(/^stale: re-index running since/);
    expect(second).toBe(await first);
    await releaseIndexes(ws);
    await vi.waitFor(async () => expect(await finishedIndexes(ws)).toHaveLength(1), { timeout: 10_000 });
    expect(await indexCalls(ws)).toHaveLength(1);
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
  });

  it("always indexes a non-git root", async () => {
    const ws = await workspace(FILES, { git: false });
    const s = session(ws);

    expect(await s.indexing.indexCurrentRepo(ws.root)).toMatchObject({ status: "indexed" });
    expect(await s.indexing.indexCurrentRepo(ws.root)).toMatchObject({ status: "indexed" });
  });
});
