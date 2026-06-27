import { resolve } from "node:path";
import { CbmClient } from "../cbm/client.js";
import { indexTimeoutMs } from "../cbm/timeouts.js";
import { errorText } from "../shared/strings.js";
import { validateAutoIndexPath } from "./auto-index-paths.js";

const AUTO_INDEX_MODE = "full";

export type CbmProject = {
  name: string;
  root_path?: string;
  nodes?: number;
  edges?: number;
  size_bytes?: number;
};

type ListProjectsData = {
  projects?: CbmProject[];
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

export type AutoIndexSettings = {
  readonly autoIndexNonGitDirectories: boolean;
};

type AutoIndexTarget =
  | { ok: true; path: string; source: "git-root" | "cwd" }
  | { ok: false; reason: string };

export class ProjectService {
  constructor(
    private readonly cbm: CbmClient,
    private readonly settings: AutoIndexSettings,
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

  async listProjects(signal?: AbortSignal): Promise<CbmProject[]> {
    const result = await this.cbm.callTool("list_projects", {}, { signal, allowError: true });
    const data = result.data as ListProjectsData;
    if (!result.ok && data?.error?.includes("cannot read cache directory")) return [];
    if (!result.ok) throw new Error(errorText(result.data));
    return Array.isArray(data.projects) ? data.projects : [];
  }

  async inferProject(cwd: string, signal?: AbortSignal): Promise<string> {
    const root = await this.gitRoot(cwd, signal);
    const projects = await this.listProjects(signal);
    const cwdResolved = resolve(cwd);
    const rootResolved = resolve(root);

    const matching = projects
      .filter((project) => project.root_path)
      .map((project) => ({ project, rootPath: resolve(project.root_path!) }))
      .filter(({ rootPath }) => cwdResolved === rootPath || cwdResolved.startsWith(`${rootPath}/`) || rootResolved === rootPath)
      .sort((a, b) => b.rootPath.length - a.rootPath.length);

    return matching[0]?.project.name ?? this.projectNameFromPath(root);
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

  async indexCurrentRepo(cwd: string, signal?: AbortSignal): Promise<IndexResult> {
    const target = await this.autoIndexTarget(cwd, signal);
    if (!target.ok) {
      return { status: "skipped", reason: target.reason };
    }

    const result = await this.cbm.callTool(
      "index_repository",
      { repo_path: target.path, mode: AUTO_INDEX_MODE },
      { signal, timeoutMs: indexTimeoutMs(undefined) },
    );
    const data = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
    return {
      status: "indexed",
      project: typeof data.project === "string" ? data.project : "ready",
      nodes: typeof data.nodes === "number" ? data.nodes : undefined,
      edges: typeof data.edges === "number" ? data.edges : undefined,
      data,
    };
  }
}
