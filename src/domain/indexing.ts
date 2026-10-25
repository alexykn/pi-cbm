import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CbmClient } from "../cbm/client.js";
import { indexTimeoutMs } from "../cbm/timeouts.js";
import { cbmEnvPositiveInt } from "../shared/env.js";
import { normalizePathKey } from "../shared/paths.js";
import { validateAutoIndexPath } from "./auto-index-paths.js";
import { INDEX_LEASE_HELD_REASON, type IndexCoordinator, type IndexLeaseResult } from "./index-coordinator.js";
import type { ProjectCatalog } from "./project-catalog.js";
import type { ToolExecutionContext } from "./project-resolver.js";

const AUTO_INDEX_MODE = "full";

/** `detect_changes` re-indexes at most once per window; a graph this fresh is current enough. */
const INDEX_FRESH_WINDOW_MS = 5_000;
const LEASE_WAIT_RETRY_MS = 500;

/** Budget for the whole forced `detect_changes` refresh: lease wait plus the index call. */
const DEFAULT_FRESH_INDEX_TIMEOUT_MS = 30_000;

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
      status: "skipped";
      reason: string;
    };

export type IndexFreshness =
  | { refreshed: true; age_ms: number }
  | { refreshed: false; reason: string };

export type AutoIndexSettings = {
  readonly autoIndexNonGitDirectories: boolean;
};

type AutoIndexTarget =
  | { ok: true; path: string; source: "git-root" | "cwd" }
  | { ok: false; reason: string };

function waitForLease(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolvePromise(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Bound a forced refresh by `timeoutMs` while still honouring a user/session abort. */
function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** Background indexing of the session repo and the `detect_changes` freshness refresh. */
export class IndexingService {
  private readonly lastIndexFinishedAt = new Map<string, number>();
  private readonly inflightIndexes = new Map<string, Promise<IndexFreshness>>();

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

  async indexCurrentRepo(
    cwd: string,
    signal?: AbortSignal,
    options: { waitForLeaseMs?: number; indexTimeoutMs?: number } = {},
  ): Promise<IndexResult> {
    const target = await this.autoIndexTarget(cwd, signal);
    if (!target.ok) {
      return { status: "skipped", reason: target.reason };
    }
    return this.indexPath(target.path, signal, options);
  }

  /** Index an exact path (no git-root re-resolution); the `detect_changes` freshness path uses it. */
  private async indexPath(
    path: string,
    signal: AbortSignal | undefined,
    options: { waitForLeaseMs?: number; indexTimeoutMs?: number } = {},
  ): Promise<IndexResult> {
    const validation = validateAutoIndexPath(path);
    if (!validation.ok) {
      return { status: "skipped", reason: validation.reason };
    }

    const coordination = await this.acquireIndexLease(validation.path, signal, options.waitForLeaseMs);
    if (!coordination.ok) {
      return { status: "skipped", reason: coordination.reason };
    }

    try {
      const result = await this.cbm.callTool(
        "index_repository",
        { repo_path: validation.path, mode: AUTO_INDEX_MODE },
        { signal: coordination.lease.signal, timeoutMs: indexTimeoutMs(options.indexTimeoutMs) },
      );
      const data = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
      this.lastIndexFinishedAt.set(this.indexKey(validation.path), Date.now());
      this.catalog.invalidate();
      return {
        status: "indexed",
        project: typeof data.project === "string" ? data.project : "ready",
        nodes: typeof data.nodes === "number" ? data.nodes : undefined,
        edges: typeof data.edges === "number" ? data.edges : undefined,
        data,
      };
    } finally {
      await coordination.lease.release();
    }
  }

  /** A held repo lease means another session is already indexing; wait for it instead of skipping. */
  private async acquireIndexLease(repoPath: string, signal: AbortSignal | undefined, waitForLeaseMs: number | undefined): Promise<IndexLeaseResult> {
    const deadline = waitForLeaseMs === undefined ? undefined : Date.now() + waitForLeaseMs;
    let coordination = await this.indexCoordinator.acquire(repoPath, signal);
    while (
      !coordination.ok &&
      coordination.reason === INDEX_LEASE_HELD_REASON &&
      deadline !== undefined &&
      Date.now() < deadline &&
      !signal?.aborted
    ) {
      if (!(await waitForLease(Math.min(LEASE_WAIT_RETRY_MS, deadline - Date.now()), signal))) break;
      coordination = await this.indexCoordinator.acquire(repoPath, signal);
    }
    return coordination;
  }

  /**
   * Force a re-index before `detect_changes` unless this project's root was
   * indexed within the freshness window. CLI-mode cbm indexes are not watched,
   * so a stale graph silently omits impacted symbols after an edit.
   */
  async ensureFreshIndex(project: string, ctx: ToolExecutionContext): Promise<IndexFreshness> {
    const root = await this.indexableProjectRoot(project, ctx.signal);
    if (!root) return { refreshed: false, reason: "project root not found on disk; index not refreshed" };

    const age = this.indexAgeMs(root);
    if (age !== undefined && age < INDEX_FRESH_WINDOW_MS) return { refreshed: true, age_ms: age };

    const key = this.indexKey(root);
    const existing = this.inflightIndexes.get(key);
    if (existing) return existing;

    const run = this.refreshIndex(root, ctx).finally(() => {
      if (this.inflightIndexes.get(key) === run) this.inflightIndexes.delete(key);
    });
    this.inflightIndexes.set(key, run);
    return run;
  }

  private async refreshIndex(root: string, ctx: ToolExecutionContext): Promise<IndexFreshness> {
    const timeoutMs = resolveFreshIndexTimeoutMs();
    const bounded = boundedSignal(ctx.signal, timeoutMs);
    const timedOutReason = () => `timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} s waiting for index`;
    try {
      const result = await this.indexPath(root, bounded.signal, { waitForLeaseMs: timeoutMs, indexTimeoutMs: timeoutMs });
      if (ctx.signal?.aborted) throw new Error("codebase-memory-mcp detect_changes cancelled");
      if (result.status !== "indexed") {
        return { refreshed: false, reason: bounded.signal.aborted ? timedOutReason() : result.reason };
      }
      return { refreshed: true, age_ms: this.indexAgeMs(root) ?? 0 };
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      if (bounded.signal.aborted) return { refreshed: false, reason: timedOutReason() };
      return { refreshed: false, reason: error instanceof Error && error.message ? error.message : "index failed" };
    } finally {
      bounded.cleanup();
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

  private indexAgeMs(root: string): number | undefined {
    const finishedAt = this.lastIndexFinishedAt.get(this.indexKey(root));
    return finishedAt === undefined ? undefined : Date.now() - finishedAt;
  }

  private indexKey(path: string): string {
    return normalizePathKey(resolve(path));
  }
}
