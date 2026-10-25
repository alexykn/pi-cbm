/** An extension setting `PI_CBM_<name>`; blank counts as unset. */
export function cbmEnv(name: string): string | undefined {
  return process.env[`PI_CBM_${name}`]?.trim() || undefined;
}

/** A positive integer setting up to `max`, or `fallback` when it is unset or invalid. */
export function cbmEnvPositiveInt(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const configured = cbmEnv(name);
  if (!configured) return fallback;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

/** An on/off setting; only "1" turns it on. */
export function cbmEnvFlag(name: string): boolean {
  return cbmEnv(name) === "1";
}

/**
 * Variables older pi-cbm releases read, each with the `PI_CBM_<name>` that replaced it.
 * `CBM_CACHE_DIR` is not here: it is cbm's own variable and still followed.
 */
const REMOVED_ENV: ReadonlyArray<readonly [removed: string, replacement: string]> = [
  ["CODEBASE_MEMORY_MCP_BIN", "BIN"],
  ["CBM_BIN", "BIN"],
  ["CBM_MAX_CONCURRENT_INDEXES", "MAX_CONCURRENT_INDEXES"],
  ["CBM_AUTO_REFRESH_INTERVAL_MS", "AUTO_REFRESH_INTERVAL_MS"],
  ["CBM_FRESH_INDEX_TIMEOUT_MS", "FRESH_INDEX_TIMEOUT_MS"],
  ["CBM_SKIP_VERSION_CHECK", "SKIP_VERSION_CHECK"],
];

/** A warning naming each removed variable that is set while its replacement is not; undefined when there is none. */
export function removedEnvWarning(): string | undefined {
  const leftovers = REMOVED_ENV.filter(([removed, replacement]) => process.env[removed]?.trim() && !cbmEnv(replacement));
  if (leftovers.length === 0) return undefined;
  const renames = leftovers.map(([removed, replacement]) => `${removed} (use PI_CBM_${replacement})`);
  return `pi-cbm no longer reads ${renames.join(", ")}; rename ${leftovers.length === 1 ? "it" : "them"}.`;
}
