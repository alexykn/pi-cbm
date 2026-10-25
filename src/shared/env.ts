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
