import { homedir } from "node:os";
import { basename, parse, resolve } from "node:path";

export type AutoIndexPathValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

const SYSTEM_PATHS = new Set([
  "/Applications",
  "/Library",
  "/Network",
  "/System",
  "/Users",
  "/Volumes",
  "/bin",
  "/boot",
  "/cores",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/private",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
]);

const HOME_BUILTIN_DIRECTORIES = new Set([".Trash", "Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"]);

export function validateAutoIndexPath(path: string): AutoIndexPathValidation {
  const normalized = normalizePath(path);
  const root = normalizePath(parse(normalized).root);
  if (normalized === root) {
    return { ok: false, reason: "refusing to auto-index filesystem root" };
  }

  const home = normalizePath(homedir());
  if (normalized === home) {
    return { ok: false, reason: "refusing to auto-index home directory" };
  }

  if (SYSTEM_PATHS.has(normalized)) {
    return { ok: false, reason: `refusing to auto-index system directory: ${normalized}` };
  }

  if (isHomeBuiltinDirectory(normalized, home)) {
    return { ok: false, reason: `refusing to auto-index builtin user directory: ${basename(normalized)}` };
  }

  return { ok: true, path: normalized };
}

function isHomeBuiltinDirectory(path: string, home: string): boolean {
  if (!path.startsWith(`${home}/`)) return false;
  const relative = path.slice(home.length + 1);
  return !relative.includes("/") && HOME_BUILTIN_DIRECTORIES.has(relative);
}

function normalizePath(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
