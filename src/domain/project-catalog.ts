import { CbmClient } from "../cbm/client.js";
import { isAbsolutePath, relativeTo } from "../shared/paths.js";
import { errorText } from "../shared/strings.js";

/** Keep a missing `root_path` cached briefly so one failed lookup doesn't re-run per node in a batch. */
const ROOT_PATH_MISS_TTL_MS = 30_000;

/** Shared by validation and path rewriting so a burst of tool calls spawns `list_projects` once. */
const PROJECTS_CACHE_TTL_MS = 10_000;

/** 0.12 `list_projects` pages; the default page also holds 50 projects. */
const PROJECTS_PAGE_SIZE = 50;
const MAX_PROJECTS = 1_000;

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

/** The sole owner of `list_projects`: paging, the TTL cache, and project root lookup. */
export class ProjectCatalog {
  private readonly rootPaths = new Map<string, Promise<string | undefined>>();
  private readonly rootPathMisses = new Map<string, number>();
  private projectsCache?: { at: number; value: CbmProject[] };
  private projectsInFlight?: Promise<CbmProject[]>;
  private projectsGeneration = 0;

  constructor(private readonly cbm: CbmClient) {}

  async list(signal?: AbortSignal, options: { force?: boolean } = {}): Promise<CbmProject[]> {
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

  /** The indexed `root_path` of `project`, or undefined when it is unknown or the lookup failed. */
  rootPath(project: string, signal?: AbortSignal): Promise<string | undefined> {
    const cached = this.rootPaths.get(project);
    if (cached) return this.awaitWithSignal(cached, signal).catch(() => undefined);
    const missAt = this.rootPathMisses.get(project);
    if (missAt !== undefined && Date.now() - missAt < ROOT_PATH_MISS_TTL_MS) return Promise.resolve(undefined);

    // Shared lookup runs without the caller's signal so one aborted caller cannot record a miss for everyone.
    const request = this.list()
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
   * cbm 0.12 `get_code_snippet` reports absolute `file_path`s while
   * `search_graph` reports repo-relative ones. Rewrite the path-ish keys against
   * the project's `root_path` so both agree; leave the value untouched when the
   * project or a matching root is unknown.
   */
  async relativizePaths(data: Record<string, unknown>, project: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!project) return data;
    const keys = ["file_path", "file", "path"].filter((key) => typeof data[key] === "string" && isAbsolutePath(data[key] as string));
    if (keys.length === 0) return data;

    const root = await this.rootPath(project, signal);
    if (!root) return data;

    const result = { ...data };
    for (const key of keys) {
      const relative = relativeTo(root, data[key] as string);
      if (relative !== undefined) result[key] = relative;
    }
    return result;
  }

  /** Forget every cached listing; an index just changed what `list_projects` would return. */
  invalidate(): void {
    this.projectsGeneration += 1;
    this.projectsCache = undefined;
    this.projectsInFlight = undefined;
    this.rootPaths.clear();
    this.rootPathMisses.clear();
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
}
