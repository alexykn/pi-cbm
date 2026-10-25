import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { mapLimit } from "../shared/concurrency.js";

const STAT_CONCURRENCY = 64;

/**
 * `indexed_at` has second precision and filesystem mtimes have their own
 * granularity, so anything changed within this slack before the reference
 * counts as changed after it.
 */
export const CHANGE_SLACK_MS = 1_000;

/** True when nothing under the scanned root changed at or after `referenceMs`. */
export function isUnchangedSince(newestChangeMs: number, referenceMs: number): boolean {
  return newestChangeMs < referenceMs - CHANGE_SLACK_MS;
}

/** Paths git would show under `root`, relative to it: tracked plus untracked files that are not ignored. */
function listFiles(root: string, signal?: AbortSignal): Promise<string[] | undefined> {
  return new Promise((resolvePromise, reject) => {
    // core.excludesFile is cleared: cbm honours .gitignore and info/exclude but not a configured global excludes
    // file, so files only that file hides are still in the graph and their edits must count.
    const child = spawn("git", ["--no-optional-locks", "-c", "core.excludesFile=", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const kill = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolvePromise(undefined));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) reject(new Error("git ls-files cancelled"));
      else resolvePromise(code === 0 ? Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean) : undefined);
    });
  });
}

/** Every listed path plus each of its parent directories up to and including the root ("."). */
function pathsToStat(files: string[]): string[] {
  const paths = new Set<string>(["."]);
  for (const file of files) {
    const path = file.replace(/\/+$/, "");
    paths.add(path);
    for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
      paths.add(path.slice(0, slash));
    }
  }
  return [...paths];
}

/**
 * The newest mtime among the files git sees under `root` and their parent
 * directories, or undefined when git cannot list `root` (not a repository, or
 * git missing): the caller must then treat the graph as stale.
 *
 * A missing path is skipped rather than counted: a tracked file deleted before
 * the last index would otherwise flag the repo forever. A deletion after the
 * index still shows up as its parent directory's mtime.
 */
export async function newestChangeMs(root: string, signal?: AbortSignal): Promise<number | undefined> {
  const files = await listFiles(root, signal);
  if (!files) return undefined;
  const mtimes = await mapLimit(pathsToStat(files), STAT_CONCURRENCY, async (path) => {
    try {
      return (await stat(join(root, path))).mtimeMs;
    } catch {
      return Number.NEGATIVE_INFINITY;
    }
  });
  // reduce, not Math.max(...): a large repo would overflow the argument limit.
  return mtimes.reduce((newest, mtime) => Math.max(newest, mtime), Number.NEGATIVE_INFINITY);
}
