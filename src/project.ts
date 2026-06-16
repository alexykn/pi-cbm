import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { callCbmTool } from "./cbm.js";

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

export async function gitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const child = spawn("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const kill = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", kill, { once: true });

  try {
    const output = await new Promise<string>((resolveOutput) => {
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", () => resolveOutput(""));
      child.on("close", (code) => resolveOutput(code === 0 ? stdout.trim() : ""));
    });

    return output || cwd;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

export function projectNameFromPath(path: string): string {
  let normalized = resolve(path).replaceAll("\\", "/");
  normalized = normalized
    .split("")
    .map((char) => (/^[A-Za-z0-9._-]$/.test(char) ? char : "-"))
    .join("");

  normalized = normalized.replace(/-+/g, "-").replace(/\.+/g, ".").replace(/^[-.]+/, "").replace(/-+$/, "");
  return normalized || "root";
}

export async function listProjects(signal?: AbortSignal): Promise<CbmProject[]> {
  const result = await callCbmTool("list_projects", {}, { signal, allowError: true });
  const data = result.data as ListProjectsData;
  if (!result.ok && data?.error?.includes("cannot read cache directory")) return [];
  if (!result.ok) throw new Error(typeof result.data === "string" ? result.data : JSON.stringify(result.data));
  return Array.isArray(data.projects) ? data.projects : [];
}

export async function inferProject(cwd: string, signal?: AbortSignal): Promise<string> {
  const root = await gitRoot(cwd, signal);
  const projects = await listProjects(signal);
  const cwdResolved = resolve(cwd);
  const rootResolved = resolve(root);

  const matching = projects
    .filter((project) => project.root_path)
    .map((project) => ({ project, rootPath: resolve(project.root_path!) }))
    .filter(({ rootPath }) => cwdResolved === rootPath || cwdResolved.startsWith(`${rootPath}/`) || rootResolved === rootPath)
    .sort((a, b) => b.rootPath.length - a.rootPath.length);

  return matching[0]?.project.name ?? projectNameFromPath(root);
}

export async function defaultRepoPath(cwd: string, signal?: AbortSignal): Promise<string> {
  return gitRoot(cwd, signal);
}
