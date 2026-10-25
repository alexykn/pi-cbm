/** macOS and Windows filesystems are case-insensitive, so path comparison must be too. */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** POSIX-absolute or Windows drive-letter absolute, on any host platform. */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:[\\/]/i.test(value);
}

/** Absolute, or explicitly relative ("." / ".." / containing a separator). */
export function looksLikePath(value: string): boolean {
  return isAbsolutePath(value) || value === "." || value === ".." || /[\\/]/.test(value);
}

/**
 * The one comparison key for paths: forward slashes, no trailing slash, and
 * case-folded on case-insensitive filesystems (and for drive-letter paths).
 */
export function normalizePathKey(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const trimmed = slashed.replace(/\/+$/, "") || "/";
  return CASE_INSENSITIVE_FS || /^[a-z]:/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function childPrefix(rootKey: string): string {
  return rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
}

/** True when `path` is `root` itself or lies below it. */
export function isWithin(root: string, path: string): boolean {
  const rootKey = normalizePathKey(root);
  const pathKey = normalizePathKey(path);
  return pathKey === rootKey || pathKey.startsWith(childPrefix(rootKey));
}

/** `value` relative to `root` with forward slashes, or undefined when it does not lie below `root`. */
export function relativeTo(root: string, value: string): string | undefined {
  const prefix = childPrefix(normalizePathKey(root));
  if (!normalizePathKey(value).startsWith(prefix)) return undefined;
  return value.replaceAll("\\", "/").slice(prefix.length);
}
