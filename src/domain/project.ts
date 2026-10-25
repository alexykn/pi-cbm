import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CbmClient } from "../cbm/client.js";
import { indexTimeoutMs } from "../cbm/timeouts.js";
import { errorText, errorTextWithDetails } from "../shared/strings.js";
import { validateAutoIndexPath } from "./auto-index-paths.js";
import { INDEX_LEASE_HELD_REASON, type IndexCoordinator, type IndexLeaseResult } from "./index-coordinator.js";

const AUTO_INDEX_MODE = "full";

/** `detect_changes` re-indexes at most once per window; a graph this fresh is current enough. */
const INDEX_FRESH_WINDOW_MS = 5_000;
const LEASE_WAIT_RETRY_MS = 500;

/** Budget for the whole forced `detect_changes` refresh: lease wait plus the index call. */
const DEFAULT_FRESH_INDEX_TIMEOUT_MS = 30_000;

function resolveFreshIndexTimeoutMs(): number {
  const configured = process.env.PI_CBM_FRESH_INDEX_TIMEOUT_MS?.trim();
  if (!configured) return DEFAULT_FRESH_INDEX_TIMEOUT_MS;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FRESH_INDEX_TIMEOUT_MS;
}

/** Keep a missing `root_path` cached briefly so one failed lookup doesn't re-run per node in a batch. */
const ROOT_PATH_MISS_TTL_MS = 30_000;

/** Shared by validation and path rewriting so a burst of tool calls spawns `list_projects` once. */
const PROJECTS_CACHE_TTL_MS = 10_000;

/** 0.12 `list_projects` pages; the default page also holds 50 projects. */
const PROJECTS_PAGE_SIZE = 50;
const MAX_PROJECTS = 1_000;

const MAX_LISTED_PROJECTS = 10;

/** cbm rejects projects by index, not by name/path spelling. */
const PROJECT_ERROR_PATTERN = /project not found|not indexed/i;

/** macOS and Windows filesystems are case-insensitive, so root matching must be too. */
const CASE_INSENSITIVE_MATCH = process.platform === "win32" || process.platform === "darwin";

const PROJECT_CANCELLED = "codebase-memory-mcp list_projects cancelled";

export type CbmProject = {
  name: string;
  root_path?: string;
  nodes?: number;
  edges?: number;
  size_bytes?: number;
};

type ListProjectsData = {
  projects?: CbmProject[];
  has_more?: boolean;
  error?: string;
  hint?: string;
};

export type ToolExecutionContext = {
  cwd: string;
  signal?: AbortSignal;
};

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

/** POSIX-absolute or Windows drive-letter absolute, on any host platform. */
function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:[\\/]/i.test(value);
}

/** Absolute, or explicitly relative ("." / ".." / containing a separator). */
function looksLikePath(value: string): boolean {
  return isAbsolutePath(value) || value === "." || value === ".." || /[\\/]/.test(value);
}

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

export class ProjectService {
  private readonly rootPaths = new Map<string, Promise<string | undefined>>();
  private readonly rootPathMisses = new Map<string, number>();
  private readonly lastIndexFinishedAt = new Map<string, number>();
  private readonly inflightIndexes = new Map<string, Promise<IndexFreshness>>();
  private projectsCache?: { at: number; value: CbmProject[] };
  private projectsInFlight?: Promise<CbmProject[]>;
  private projectsGeneration = 0;

  constructor(
    private readonly cbm: CbmClient,
    private readonly settings: AutoIndexSettings,
    private readonly indexCoordinator: IndexCoordinator,
  ) {}

  async gitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
    return this.cbm.gitRoot(cwd, signal);
  }

  projectNameFromPath(path: string): string {
    let normalized = resolve(path).replaceAll("\\", "/");
    normalized = normalized
      .split("")
      .map((char) => (/^[A-Za-z0-9._-]$/.test(char) ? char : "-"))
      .join("");

    normalized = normalized.replace(/-+/g, "-").replace(/\.+/g, ".").replace(/^[-.]+/, "").replace(/-+$/, "");
    return normalized || "root";
  }

  async listProjects(signal?: AbortSignal, options: { force?: boolean } = {}): Promise<CbmProject[]> {
    const cached = this.projectsCache;
    if (!options.force && cached && Date.now() - cached.at < PROJECTS_CACHE_TTL_MS) return cached.value;
    if (!options.force && this.projectsInFlight) return this.awaitWithSignal(this.projectsInFlight, signal);

    const generation = this.projectsGeneration;
    const request = this.fetchProjects().then((projects) => {
      // Drop a fetch that raced an index and would cache a pre-index snapshot.
      if (generation === this.projectsGeneration) this.projectsCache = { at: Date.now(), value: projects };
      return projects;
    });
    const tracked = request.finally(() => {
      if (this.projectsInFlight === tracked) this.projectsInFlight = undefined;
    });
    if (!options.force) this.projectsInFlight = tracked;
    return this.awaitWithSignal(tracked, signal);
  }

  /** Page `list_projects` so a project past cbm's default 50 is still resolvable. */
  private async fetchProjects(): Promise<CbmProject[]> {
    const projects: CbmProject[] = [];
    while (projects.length < MAX_PROJECTS) {
      const result = await this.cbm.callTool(
        "list_projects",
        { limit: PROJECTS_PAGE_SIZE, offset: projects.length },
        { allowError: true },
      );
      const data = result.data as ListProjectsData;
      if (!result.ok && data?.error?.includes("cannot read cache directory")) return [];
      if (!result.ok) throw new Error(errorText(result.data));
      const page = Array.isArray(data.projects) ? data.projects : [];
      projects.push(...page);
      if (data.has_more !== true || page.length === 0) break;
    }
    return projects;
  }

  /** Let one caller stop waiting on a shared fetch without cancelling it for the others. */
  private async awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw new Error(PROJECT_CANCELLED);
    return new Promise<T>((resolvePromise, reject) => {
      const onAbort = () => reject(new Error(PROJECT_CANCELLED));
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /**
   * cbm 0.12 `get_code_snippet` reports absolute `file_path`s while
   * `search_graph` reports repo-relative ones. Rewrite the path-ish keys against
   * the project's `root_path` so both agree; leave the value untouched when the
   * project or a matching root is unknown.
   */
  async relativizePaths(data: Record<string, unknown>, project: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!project) return data;
    const keys = ["file_path", "file", "path"].filter((key) => typeof data[key] === "string" && isAbsolutePath(data[key] as string));
    if (keys.length === 0) return data;

    const root = await this.projectRootPath(project, signal);
    if (!root) return data;

    const rootNormalized = root.replaceAll("\\", "/").replace(/\/+$/, "");
    const caseInsensitive = /^[a-z]:/i.test(rootNormalized);
    const comparableRoot = caseInsensitive ? rootNormalized.toLowerCase() : rootNormalized;
    const result = { ...data };
    for (const key of keys) {
      const value = data[key] as string;
      const normalizedValue = value.replaceAll("\\", "/");
      const comparableValue = caseInsensitive ? normalizedValue.toLowerCase() : normalizedValue;
      if (comparableValue.startsWith(`${comparableRoot}/`)) result[key] = normalizedValue.slice(rootNormalized.length + 1);
    }
    return result;
  }

  private projectRootPath(project: string, signal?: AbortSignal): Promise<string | undefined> {
    const cached = this.rootPaths.get(project);
    if (cached) return this.awaitWithSignal(cached, signal).catch(() => undefined);
    const missAt = this.rootPathMisses.get(project);
    if (missAt !== undefined && Date.now() - missAt < ROOT_PATH_MISS_TTL_MS) return Promise.resolve(undefined);

    // Shared lookup runs without the caller's signal so one aborted caller cannot record a miss for everyone.
    const request = this.listProjects()
      .then((projects) => projects.find((entry) => entry.name === project)?.root_path)
      .catch(() => undefined);
    this.rootPaths.set(project, request);
    void request.then((root) => {
      if (root) return;
      this.rootPaths.delete(project);
      this.rootPathMisses.set(project, Date.now());
    });
    return this.awaitWithSignal(request, signal).catch(() => undefined);
  }

  /**
   * Resolve the `project` a tool should use. Explicit names and paths are
   * validated against the indexed projects; an unmatched value throws with the
   * indexed list instead of letting cbm answer "symbol not found".
   */
  async resolveProject(explicit: unknown, cwd: string, signal?: AbortSignal): Promise<string> {
    const given = typeof explicit === "string" ? explicit.trim() : "";
    let projects = await this.listProjects(signal);
    let name = await this.tryResolveProject(given, cwd, projects, signal);
    if (name) return name;

    // A project indexed after the cached list was built would otherwise be rejected for the TTL.
    projects = await this.listProjects(signal, { force: true });
    name = await this.tryResolveProject(given, cwd, projects, signal);
    if (name) return name;
    throw new Error(this.projectResolutionMessage(given || undefined, cwd, await this.gitRootOrUndefined(cwd, signal), projects));
  }

  private async tryResolveProject(given: string, cwd: string, projects: CbmProject[], signal?: AbortSignal): Promise<string | undefined> {
    if (given) {
      if (projects.some((project) => project.name === given)) return given;
      // A bare word is a project name, never a cwd-relative path: "other-repo" must not resolve to the cwd's project.
      if (!looksLikePath(given)) return undefined;
      const path = isAbsolutePath(given) ? given : resolve(cwd, given);
      return (await this.matchProject(projects, [path]))?.name;
    }
    const gitRoot = await this.gitRootOrUndefined(cwd, signal);
    return (await this.matchProject(projects, gitRoot ? [cwd, gitRoot] : [cwd]))?.name;
  }

  /**
   * cbm can still reject a project `resolveProject` accepted (e.g. its index was
   * dropped). Keep cbm's detail but append the same actionable project list.
   */
  async projectLookupError(value: unknown, project: string, cwd: string, signal?: AbortSignal): Promise<Error> {
    const text = value instanceof Error ? value.message : errorTextWithDetails(value);
    if (!PROJECT_ERROR_PATTERN.test(text)) return value instanceof Error ? value : new Error(text);
    const projects = await this.listProjects(signal).catch(() => []);
    const gitRoot = await this.gitRootOrUndefined(cwd, signal);
    return new Error(`${text} ${this.projectResolutionMessage(project || undefined, cwd, gitRoot, projects)}`);
  }

  /** Run a cbm call, rethrowing any project-not-found error with the actionable list. */
  async withProjectError<T>(project: string, ctx: ToolExecutionContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof Error) || !PROJECT_ERROR_PATTERN.test(error.message)) throw error;
      throw await this.projectLookupError(error, project, ctx.cwd, ctx.signal);
    }
  }

  private async gitRootOrUndefined(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.cbm.findGitRoot(cwd, signal);
    } catch {
      return undefined;
    }
  }

  private async matchProject(projects: CbmProject[], paths: string[]): Promise<CbmProject | undefined> {
    const plain = this.longestPrefix(await this.projectRoots(projects, false), paths.map((path) => resolve(path)));
    if (plain) return plain;
    // Symlinked cwd/root: retry with both sides canonicalized.
    const canonicalPaths = await Promise.all(paths.map((path) => realpath(path).catch(() => resolve(path))));
    return this.longestPrefix(await this.projectRoots(projects, true), canonicalPaths);
  }

  private async projectRoots(projects: CbmProject[], canonicalize: boolean): Promise<Array<{ project: CbmProject; root: string }>> {
    const roots: Array<{ project: CbmProject; root: string }> = [];
    for (const project of projects) {
      if (!project.root_path) continue;
      const resolvedPath = resolve(project.root_path);
      const root = canonicalize ? await realpath(project.root_path).catch(() => resolvedPath) : resolvedPath;
      roots.push({ project, root: root.replaceAll("\\", "/") });
    }
    return roots;
  }

  private longestPrefix(roots: Array<{ project: CbmProject; root: string }>, paths: string[]): CbmProject | undefined {
    const normalize = (value: string) => {
      const normalized = value.replaceAll("\\", "/");
      return CASE_INSENSITIVE_MATCH ? normalized.toLowerCase() : normalized;
    };
    const normalizedPaths = paths.map(normalize);
    return roots
      .filter(({ root }) => {
        const normalizedRoot = normalize(root);
        return normalizedPaths.some((path) => path === normalizedRoot || path.startsWith(`${normalizedRoot}/`));
      })
      .sort((a, b) => b.root.length - a.root.length)[0]?.project;
  }

  private projectResolutionMessage(given: string | undefined, cwd: string, gitRoot: string | undefined, projects: CbmProject[]): string {
    const listed = projects.slice(0, MAX_LISTED_PROJECTS).map((project) => `${project.name} -> ${project.root_path ?? "(unknown root)"}`);
    const more = projects.length > listed.length ? ` (+${projects.length - listed.length} more)` : "";
    const available = listed.length > 0 ? `indexed projects: ${listed.join(", ")}${more}` : "no projects are indexed yet";
    let tried = `cwd "${cwd}", which has no git root`;
    if (given) tried = `the given value "${given}" (as a project name or path)`;
    else if (gitRoot) tried = `cwd "${cwd}" and its git root "${gitRoot}"`;
    return [
      `No indexed project matches ${tried}.`,
      available,
      "pass `project` as one of these names or as the repo's absolute path (required when the cwd is outside the repo)",
      "if the repository was just indexed, indexing may still be running",
    ].join("; ");
  }

  private invalidateProjectCaches(): void {
    this.projectsGeneration += 1;
    this.projectsCache = undefined;
    this.projectsInFlight = undefined;
    this.rootPaths.clear();
    this.rootPathMisses.clear();
  }

  async defaultRepoPath(cwd: string, signal?: AbortSignal): Promise<string> {
    return this.gitRoot(cwd, signal);
  }

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
      this.invalidateProjectCaches();
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
    const root = await this.projectRootPath(project, signal);
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
    const normalized = resolve(path).replaceAll("\\", "/");
    const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
    return CASE_INSENSITIVE_MATCH ? trimmed.toLowerCase() : trimmed;
  }
}
