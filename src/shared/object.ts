export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function removeUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function stringProp(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function numberProp(item: Record<string, unknown>, key: string): number | undefined {
  const value = item[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
