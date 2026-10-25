import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { CbmClient } from "../cbm/client.js";
import { CbmToolError } from "../cbm/errors.js";
import { removeUndefined } from "../shared/object.js";
import { isAbsolutePath, isWithin, looksLikePath, normalizePathKey } from "../shared/paths.js";
import { errorText, errorTextWithDetails } from "../shared/strings.js";
import type { CbmProject, ProjectCatalog } from "./project-catalog.js";

const MAX_LISTED_PROJECTS = 10;

/** cbm rejects projects by index, not by name/path spelling. */
const PROJECT_ERROR_PATTERN = /project not found|not indexed/i;

export type ToolExecutionContext = {
  cwd: string;
  signal?: AbortSignal;
};

type ProjectRoot = { project: CbmProject; root: string };

/** A cbm error payload (not a message that happens to embed one) saying the project is unknown. */
function isProjectError(data: unknown): boolean {
  return PROJECT_ERROR_PATTERN.test(errorText(data));
}

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

function isDerivedName(project: CbmProject): boolean {
  return project.root_path !== undefined && project.name === derivedProjectName(project.root_path);
}

/**
 * Deepest root first. Two projects can share one root (indexed by default and
 * again with `name`); prefer cbm's derived name there, then the first by name.
 */
function compareRoots(a: ProjectRoot, b: ProjectRoot): number {
  return (
    normalizePathKey(b.root).length - normalizePathKey(a.root).length ||
    Number(isDerivedName(b.project)) - Number(isDerivedName(a.project)) ||
    a.project.name.localeCompare(b.project.name)
  );
}

/** Turns a tool's optional `project` (name, path, or nothing) into an indexed project name. */
export class ProjectResolver {
  constructor(
    private readonly cbm: CbmClient,
    private readonly catalog: ProjectCatalog,
  ) {}

  /** `params` with `project` replaced by the resolved project name. */
  async withProject<T extends Record<string, unknown>>(params: T, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    return removeUndefined({ ...params, project: await this.resolveProject(params.project, ctx.cwd, ctx.signal) });
  }

  /**
   * Resolve the `project` a tool should use. Explicit names and paths are
   * validated against the indexed projects; an unmatched value throws with the
   * indexed list instead of letting cbm answer "symbol not found".
   */
  async resolveProject(explicit: unknown, cwd: string, signal?: AbortSignal): Promise<string> {
    const given = typeof explicit === "string" ? explicit.trim() : "";
    let projects = await this.catalog.list(signal);
    let name = await this.tryResolveProject(given, cwd, projects, signal);
    if (name) return name;

    // A project indexed after the cached list was built would otherwise be rejected for the TTL.
    projects = await this.catalog.list(signal, { force: true });
    name = await this.tryResolveProject(given, cwd, projects, signal);
    if (name) return name;
    throw new Error(this.projectResolutionMessage(given || undefined, cwd, await this.gitRootOrUndefined(cwd, signal), projects));
  }

  /**
   * cbm can still reject a project `resolveProject` accepted (e.g. its index was
   * dropped). Keep cbm's detail but append the same actionable project list.
   */
  async projectLookupError(value: unknown, project: string, ctx: ToolExecutionContext): Promise<Error> {
    if (value instanceof Error && !(value instanceof CbmToolError)) return value;
    const data = value instanceof CbmToolError ? value.data : value;
    const text = errorTextWithDetails(data);
    if (!isProjectError(data)) return value instanceof Error ? value : new Error(text);
    const projects = await this.catalog.list(ctx.signal).catch(() => []);
    const gitRoot = await this.gitRootOrUndefined(ctx.cwd, ctx.signal);
    return new Error(`${text} ${this.projectResolutionMessage(project || undefined, ctx.cwd, gitRoot, projects)}`);
  }

  /** Run a cbm call, rethrowing any project-not-found error with the actionable list. */
  async withProjectError<T>(project: string, ctx: ToolExecutionContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof CbmToolError) || !isProjectError(error.data)) throw error;
      throw await this.projectLookupError(error, project, ctx);
    }
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

  private async projectRoots(projects: CbmProject[], canonicalize: boolean): Promise<ProjectRoot[]> {
    const roots: ProjectRoot[] = [];
    for (const project of projects) {
      if (!project.root_path) continue;
      const resolvedPath = resolve(project.root_path);
      const root = canonicalize ? await realpath(project.root_path).catch(() => resolvedPath) : resolvedPath;
      roots.push({ project, root });
    }
    return roots;
  }

  private longestPrefix(roots: ProjectRoot[], paths: string[]): CbmProject | undefined {
    return roots.filter(({ root }) => paths.some((path) => isWithin(root, path))).sort(compareRoots)[0]?.project;
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
}
