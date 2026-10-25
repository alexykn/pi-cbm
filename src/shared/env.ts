/** The first non-blank value among the environment variables `names`, in order. */
export function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** An extension setting: `PI_CBM_<name>` wins over its `CBM_<name>` alias; blank counts as unset. */
export function cbmEnv(name: string): string | undefined {
  return firstEnv(`PI_CBM_${name}`, `CBM_${name}`);
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
