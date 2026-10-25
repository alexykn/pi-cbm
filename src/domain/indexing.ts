import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CbmClient } from "../cbm/client.js";
import { indexTimeoutMs } from "../cbm/timeouts.js";
import { awaitWithSignal } from "../shared/concurrency.js";
import { cbmEnvPositiveInt } from "../shared/env.js";
import { isRecord, removeUndefined } from "../shared/object.js";
import { normalizePathKey } from "../shared/paths.js";
import { errorMessage } from "../shared/strings.js";
import { validateAutoIndexPath } from "./auto-index-paths.js";
import { INDEX_LEASE_HELD_REASON, type IndexCoordinator, type IndexLease, type IndexRecord } from "./index-coordinator.js";
import type { ProjectCatalog } from "./project-catalog.js";
import type { ToolExecutionContext } from "./project-resolver.js";
import { CHANGE_SLACK_MS, isUnchangedSince, newestChangeMs } from "./worktree-changes.js";

const AUTO_INDEX_MODE = "full";
const DETECT_CHANGES_CANCELLED = "codebase-memory-mcp detect_changes cancelled";

/** How long `detect_changes` waits for the lease plus the re-index before answering from the existing graph. */
const DEFAULT_FRESH_INDEX_TIMEOUT_MS = 30_000;

/**
 * Highest coordinator retry attempt a refresh backs off by while another index holds the lease:
 * the first range (1-2 s by default) for every retry, so a lease freed well before the deadline is
 * noticed. Each poll is a few mkdirs and a lock read, so the shorter wait costs little.
 */
const REFRESH_MAX_RETRY_ATTEMPT = 0;

function resolveFreshIndexTimeoutMs(): number {
  return cbmEnvPositiveInt("FRESH_INDEX_TIMEOUT_MS", DEFAULT_FRESH_INDEX_TIMEOUT_MS);
}

export type IndexResult =
  | {
      status: "indexed";
      project: string;
      nodes?: number;
      edges?: number;
      data: Record<string, unknown>;
    }
  | {
      /** Nothing changed since the graph was taken, so no index ran. */
      status: "fresh";
      project: string;
      age_ms: number;
    }
  | {
      status: "skipped";
      reason: string;
    };

/** `age_ms` is the time since the graph was taken. */
export type IndexFreshness =
  | { fresh: true; reindexed: boolean; age_ms: number }
  | { fresh: false; reason: string };

export type AutoIndexSettings = {
  readonly autoIndexNonGitDirectories: boolean;
};

type AutoIndexTarget =
  | { ok: true; path: string; source: "git-root" | "cwd" }
  | { ok: false; reason: string };

/** `reference` is when the current graph was taken, when known. */
type FreshnessCheck = { fresh: true; reference: number } | { fresh: false; reference?: number; recordStartedAt?: number };

type RefreshProgress = { reference?: number; queuedAt: number; indexingSince?: number; seen: FreshnessCheck };

type Refresh = { progress: RefreshProgress; result: Promise<IndexFreshness> };

type RefreshLease = { ok: true; lease: IndexLease; waited: boolean } | { ok: false; reason: string };

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function missingChanges(reference: number | undefined): string {
  return reference === undefined ? "the graph's age is unknown" : `changes after ${isoSeconds(reference)} may be missing`;
}

/**
 * When the current graph was taken: the start of pi-cbm's own index while that
 * is the latest one (the start catches edits made during it), otherwise cbm's
 * `indexed_at`, the completion of an index by another client.
 */
function graphReference(record: IndexRecord | undefined, indexedAt: number | undefined): number | undefined {
  if (record && (indexedAt === undefined || record.finishedAt >= indexedAt - CHANGE_SLACK_MS)) return record.startedAt;
  return indexedAt;
}

/** Background indexing of the session repo and the `detect_changes` freshness refresh. */
export class IndexingService {
  private readonly refreshes = new Map<string, Refresh>();

  constructor(
    private readonly cbm: CbmClient,
    private readonly settings: AutoIndexSettings,
    private readonly indexCoordinator: IndexCoordinator,
    private readonly catalog: ProjectCatalog,
  ) {}

  async autoIndexTarget(cwd: string, signal?: AbortSignal): Promise<AutoIndexTarget> {
    const gitRoot = await this.cbm.findGitRoot(cwd, signal);
    if (gitRoot) {
      const validation = validateAutoIndexPath(gitRoot);
      if (!validation.ok) return validation;
      return { ok: true, path: validation.path, source: "git-root" };
    }

    if (!this.settings.autoIndexNonGitDirectories) {
      return { ok: false, reason: "not inside a git repository and non-git auto-indexing is disabled" };
    }

    const validation = validateAutoIndexPath(cwd);
    if (!validation.ok) return validation;
    return { ok: true, path: validation.path, source: "cwd" };
  }

  /** The session-start and auto-refresh index: skipped while nothing changed since the graph was taken. */
  async indexCurrentRepo(cwd: string, signal?: AbortSignal): Promise<IndexResult> {
    const target = await this.autoIndexTarget(cwd, signal);
    if (!target.ok) {
      return { status: "skipped", reason: target.reason };
    }
    const project = await this.projectAt(target.path, signal);
    const check = project ? await this.checkFreshness(project, target.path, signal) : undefined;
    if (project && check?.fresh) return { status: "fresh", project, age_ms: Date.now() - check.reference };
    return this.indexPath(target.path, project, signal, check);
  }

  /**
   * Bring `project`'s graph up to date before `detect_changes`. CLI-mode cbm
   * indexes are not watched, so a stale graph silently omits impacted symbols
   * after an edit. Answers without indexing when nothing changed since the
   * graph was taken; otherwise waits up to the fresh-index timeout for a
   * re-index, which keeps running in the background past that timeout.
   */
  async ensureFreshIndex(project: string, ctx: ToolExecutionContext): Promise<IndexFreshness> {
    const root = await this.indexableProjectRoot(project, ctx.signal);
    if (!root) return { fresh: false, reason: "project root not found on disk; index not refreshed" };

    const key = `${project}\0${normalizePathKey(resolve(root))}`;
    const deadline = AbortSignal.timeout(resolveFreshIndexTimeoutMs());
    const joined = this.refreshes.get(key);
    const joinedResult = joined && (await this.awaitRefresh(joined, ctx.signal, deadline));
    // The joined refresh may have started indexing before this caller's latest edit, so check again.
    if (joinedResult && !joinedResult.fresh) return joinedResult;
    const check = await this.checkFreshness(project, root, ctx.signal);
    if (check.fresh) return { fresh: true, reindexed: joinedResult?.reindexed ?? false, age_ms: Date.now() - check.reference };
    const refresh = this.refreshes.get(key) ?? this.startRefresh(key, project, root, check);
    return this.awaitRefresh(refresh, ctx.signal, deadline);
  }

  /** Index an exact path through the coordinator lease; skipped when another session holds it. */
  private async indexPath(path: string, project: string | undefined, signal: AbortSignal | undefined, seen?: FreshnessCheck): Promise<IndexResult> {
    const validation = validateAutoIndexPath(path);
    if (!validation.ok) {
      return { status: "skipped", reason: validation.reason };
    }

    const coordination = await this.indexCoordinator.acquire(validation.path, signal);
    if (!coordination.ok) {
      return { status: "skipped", reason: coordination.reason };
    }
    try {
      // Another session may have indexed between this one's check and the lease.
      const check = project && seen ? await this.recheckUnderLease(project, validation.path, seen, signal) : undefined;
      if (project && check?.fresh) return { status: "fresh", project, age_ms: Date.now() - check.reference };
      return await this.runIndex(validation.path, project, coordination.lease);
    } finally {
      await coordination.lease.release();
    }
  }

  /**
   * Run `index_repository` under `lease` and record when it ran. `name` keeps the
   * target unambiguous when several projects share a root; without a known
   * project cbm picks the path-derived one.
   */
  private async runIndex(root: string, project: string | undefined, lease: IndexLease): Promise<Extract<IndexResult, { status: "indexed" }>> {
    const startedAt = Date.now();
    const result = await this.cbm.callTool(
      "index_repository",
      removeUndefined({ repo_path: root, mode: AUTO_INDEX_MODE, name: project }),
      { signal: lease.signal, timeoutMs: indexTimeoutMs(undefined) },
    );
    const finishedAt = Date.now();
    const data = isRecord(result.data) ? result.data : {};
    const indexed = typeof data.project === "string" ? data.project : project;
    this.catalog.invalidate();
    // Written before the lease is released, so a session waiting on the lease re-checks against it.
    // Without a record freshness falls back to cbm's indexed_at, so a failed write is not an index failure.
    if (indexed) await this.indexCoordinator.writeIndexRecord({ project: indexed, root, startedAt, finishedAt }).catch(() => undefined);
    return {
      status: "indexed",
      project: indexed ?? "ready",
      nodes: typeof data.nodes === "number" ? data.nodes : undefined,
      edges: typeof data.edges === "number" ? data.edges : undefined,
      data,
    };
  }

  /** Has anything under `root` changed since `project`'s graph was taken? Unknown counts as changed. */
  private async checkFreshness(project: string, root: string, signal?: AbortSignal): Promise<FreshnessCheck> {
    const record = await this.readRecord(project, root);
    const newest = await newestChangeMs(root, signal);
    if (newest === undefined) return { fresh: false, reference: record?.startedAt, recordStartedAt: record?.startedAt };
    // graphReference is never earlier than the record's start, so unchanged since the start means fresh,
    // without the cost of an index_status call (one cbm process, about a second).
    if (record && isUnchangedSince(newest, record.startedAt)) return { fresh: true, reference: record.startedAt };

    const reference = graphReference(record, await this.indexedAt(project, signal));
    if (reference !== undefined && isUnchangedSince(newest, reference)) return { fresh: true, reference };
    return { fresh: false, reference, recordStartedAt: record?.startedAt };
  }

  /** Under the lease: has another index finished since `seen` was checked? Then check again before indexing. */
  private async recheckUnderLease(project: string, root: string, seen: FreshnessCheck, signal?: AbortSignal): Promise<FreshnessCheck> {
    const record = await this.readRecord(project, root);
    if (seen.fresh || record?.startedAt === seen.recordStartedAt) return seen;
    return this.checkFreshness(project, root, signal);
  }

  private async readRecord(project: string, root: string): Promise<IndexRecord | undefined> {
    const record = await this.indexCoordinator.readIndexRecord(project).catch(() => undefined);
    return record && normalizePathKey(resolve(record.root)) === normalizePathKey(resolve(root)) ? record : undefined;
  }

  /** cbm's completion time for `project`'s last index, by any client, to the second. */
  private async indexedAt(project: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
      const result = await this.cbm.callTool("index_status", { project }, { signal, allowError: true });
      const indexedAt = isRecord(result.data) && typeof result.data.indexed_at === "string" ? Date.parse(result.data.indexed_at) : Number.NaN;
      return Number.isFinite(indexedAt) ? indexedAt : undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  private async projectAt(root: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.catalog.projectAt(root, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  /** One refresh per project at a time; it runs without any caller's signal so it can outlive their waits. */
  private startRefresh(key: string, project: string, root: string, seen: FreshnessCheck): Refresh {
    const progress: RefreshProgress = { reference: seen.reference, queuedAt: Date.now(), seen };
    const refresh: Refresh = {
      progress,
      result: this.refresh(project, root, progress).finally(() => {
        if (this.refreshes.get(key) === refresh) this.refreshes.delete(key);
      }),
    };
    this.refreshes.set(key, refresh);
    return refresh;
  }

  /** A caller abort rethrows; the timeout answers stale. Neither stops the refresh. */
  private async awaitRefresh(refresh: Refresh, signal: AbortSignal | undefined, deadline: AbortSignal): Promise<IndexFreshness> {
    try {
      return await awaitWithSignal(refresh.result, signal ? AbortSignal.any([signal, deadline]) : deadline, DETECT_CHANGES_CANCELLED);
    } catch (error) {
      if (signal?.aborted || !deadline.aborted) throw error;
      const { indexingSince, queuedAt, reference } = refresh.progress;
      const running = indexingSince === undefined ? `re-index queued since ${isoSeconds(queuedAt)}` : `re-index running since ${isoSeconds(indexingSince)}`;
      return { fresh: false, reason: `${running}; ${missingChanges(reference)}` };
    }
  }

  /** Never rejects: a failure answers from the existing graph. */
  private async refresh(project: string, root: string, progress: RefreshProgress): Promise<IndexFreshness> {
    const stale = (reason: string): IndexFreshness => ({ fresh: false, reason: `${reason}; ${missingChanges(progress.reference)}` });
    const validation = validateAutoIndexPath(root);
    if (!validation.ok) return stale(`index not refreshed: ${validation.reason}`);
    try {
      const acquired = await this.acquireForRefresh(validation.path);
      if (!acquired.ok) return stale(`index not refreshed: ${acquired.reason}`);
      try {
        // Another index held the lease or finished since the caller's check; it may already cover the changes.
        const check = acquired.waited ? await this.checkFreshness(project, root) : await this.recheckUnderLease(project, root, progress.seen);
        if (check.fresh) return { fresh: true, reindexed: false, age_ms: Date.now() - check.reference };
        progress.reference = check.reference;
        const indexingSince = Date.now();
        progress.indexingSince = indexingSince;
        await this.runIndex(validation.path, project, acquired.lease);
        return { fresh: true, reindexed: true, age_ms: Date.now() - indexingSince };
      } finally {
        await acquired.lease.release();
      }
    } catch (error) {
      return stale(`index refresh failed: ${errorMessage(error) ?? "index failed"}`);
    }
  }

  /**
   * Take the repo lease, waiting while another session (or this one's
   * auto-refresh) holds it. Only the wait is bounded, by the index timeout:
   * once the lease is ours the index runs to completion or to that timeout.
   */
  private async acquireForRefresh(root: string): Promise<RefreshLease> {
    const waiting = new AbortController();
    const giveUp = setTimeout(() => waiting.abort(), indexTimeoutMs(undefined));
    giveUp.unref?.();
    try {
      for (let attempt = 0; ; attempt++) {
        const coordination = await this.indexCoordinator.acquire(root, waiting.signal);
        if (coordination.ok) return { ok: true, lease: coordination.lease, waited: attempt > 0 };
        if (coordination.reason !== INDEX_LEASE_HELD_REASON) return coordination;
        if (!(await this.indexCoordinator.waitToRetry(Math.min(attempt, REFRESH_MAX_RETRY_ATTEMPT), waiting.signal))) return { ok: false, reason: "gave up waiting for another index" };
      }
    } finally {
      clearTimeout(giveUp);
    }
  }

  /** Only index a project root that exists on disk; never guess an explicit project's path. */
  private async indexableProjectRoot(project: string, signal?: AbortSignal): Promise<string | undefined> {
    const root = await this.catalog.rootPath(project, signal);
    if (!root) return undefined;
    try {
      const stats = await stat(root);
      return stats.isDirectory() ? root : undefined;
    } catch {
      return undefined;
    }
  }
}
