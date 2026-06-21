const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_INDEX_TIMEOUT_MS = 20 * 60_000;

export function indexTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_INDEX_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.floor(value), 24 * 60 * 60_000));
}

export function queryTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_QUERY_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.floor(value), 10 * 60_000));
}

export { DEFAULT_QUERY_TIMEOUT_MS };
