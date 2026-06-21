import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const DEFAULT_BINARY = "codebase-memory-mcp";
const FALLBACK_BINARY_PATHS = ["~/.local/bin/codebase-memory-mcp"];

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function existsExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(command: string): Promise<string | undefined> {
  const paths = process.env.PATH?.split(delimiter) ?? [];
  for (const dir of paths) {
    const candidate = join(dir, command);
    if (await existsExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function resolveCbmBinary(): Promise<string> {
  const configured = process.env.CODEBASE_MEMORY_MCP_BIN?.trim() || process.env.CBM_BIN?.trim();
  if (configured) {
    const path = expandHome(configured);
    if (await existsExecutable(path)) return path;
    throw new Error(`Configured codebase-memory-mcp binary does not exist: ${path}`);
  }

  const fromPath = await findOnPath(DEFAULT_BINARY);
  if (fromPath) return fromPath;

  for (const fallback of FALLBACK_BINARY_PATHS) {
    const path = expandHome(fallback);
    if (await existsExecutable(path)) return path;
  }

  throw new Error("codebase-memory-mcp binary not found. Install it or set CODEBASE_MEMORY_MCP_BIN=/path/to/codebase-memory-mcp.");
}
