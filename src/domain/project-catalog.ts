import { resolve } from "node:path";
import { CbmClient } from "../cbm/client.js";
import { CbmToolError } from "../cbm/errors.js";
import { awaitWithSignal } from "../shared/concurrency.js";
import { isAbsolutePath, normalizePathKey, relativeTo } from "../shared/paths.js";

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

/**
 * The name cbm gives a root indexed without `name`: characters outside
 * [A-Za-z0-9._-] become "-", runs collapse, and leading/trailing separators drop
 * (`/tmp/cbm-fixture-repo` -> `tmp-cbm-fixture-repo`).
 */
function derivedProjectName(rootPath: string): string {
  const name = rootPath
    .replaceAll("\\", "/")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
  return name || "root";
}

/** True for the name cbm itself would give this project's root. */
export function isDerivedName(project: CbmProject): boolean {
  return project.root_path !== undefined && project.name === derivedProjectName(project.root_path);
}

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
    if (!options.force && this.projectsInFlight) return awaitWithSignal(this.projectsInFlight, signal, PROJECT_CANCELLED);

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
    return awaitWithSignal(tracked, signal, PROJECT_CANCELLED);
  }

  /** The indexed `root_path` of `project`, or undefined when it is unknown or the lookup failed. */
  rootPath(project: string, signal?: AbortSignal): Promise<string | undefined> {
    const cached = this.rootPaths.get(project);
    if (cached) return awaitWithSignal(cached, signal, PROJECT_CANCELLED).catch(() => undefined);
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
    return awaitWithSignal(request, signal, PROJECT_CANCELLED).catch(() => undefined);
  }

  /**
   * The project indexed exactly at `root`, fetched fresh. Two projects can
   * share a root; prefer cbm's derived name there, as tool resolution does.
   */
  async projectAt(root: string, signal?: AbortSignal): Promise<string | undefined> {
    const key = normalizePathKey(resolve(root));
    const matches = (await this.list(signal, { force: true })).filter(
      (project) => project.root_path !== undefined && normalizePathKey(resolve(project.root_path)) === key,
    );
    return (matches.find(isDerivedName) ?? matches.sort((a, b) => a.name.localeCompare(b.name))[0])?.name;
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
      if (!result.ok) throw new CbmToolError("list_projects", result.data);
      const page = Array.isArray(data.projects) ? data.projects : [];
      projects.push(...page);
      if (data.has_more !== true || page.length === 0) break;
    }
    return projects;
  }
}
