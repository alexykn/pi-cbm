import { spawn } from "node:child_process";

/** Range this extension is tested against. */
export const SUPPORTED_CBM_VERSION_RANGE = ">=0.12.0 <0.13.0";

const VERSION_PROBE_TIMEOUT_MS = 15_000;
const UNPARSEABLE_WARNING =
  "Could not determine the codebase-memory-mcp version; continuing without a compatibility guarantee.";

export type CbmVersion = { major: number; minor: number; patch: number };

export type CbmVersionStatus = "ok" | "too-old" | "untested-newer" | "unknown";

export type CbmVersionCheck = {
  status: CbmVersionStatus;
  version?: string;
  warning?: string;
  message?: string;
};

const versionChecks = new Map<string, Promise<CbmVersionCheck>>();
let pendingWarning: string | undefined;
let detectedVersion: string | undefined;

/** Last version string seen by a probe, for contract-error messages. */
export function detectedCbmVersion(): string {
  return detectedVersion ?? "unknown";
}

export function parseCbmVersion(output: string): CbmVersion | undefined {
  const match = /codebase-memory-mcp\s+v?(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function evaluateCbmVersion(version: CbmVersion | undefined): CbmVersionCheck {
  if (!version) return { status: "unknown", warning: UNPARSEABLE_WARNING };
  const text = `${version.major}.${version.minor}.${version.patch}`;
  if (version.major === 0 && version.minor < 12) {
    return {
      status: "too-old",
      version: text,
      message: `codebase-memory-mcp ${text} is unsupported; pi-cbm requires 0.12.x (${SUPPORTED_CBM_VERSION_RANGE}). Upgrade codebase-memory-mcp, or reinstall an earlier pi-cbm release (<= 1.2.1) to keep using it.`,
    };
  }
  if (version.major === 0 && version.minor === 12) return { status: "ok", version: text };
  return {
    status: "untested-newer",
    version: text,
    warning: `codebase-memory-mcp ${text} is newer than the tested range (${SUPPORTED_CBM_VERSION_RANGE}); continuing, but behavior may differ.`,
  };
}

/** Probe once per resolved binary path; every later call reuses the promise. */
export function checkCbmVersion(binaryPath: string): Promise<CbmVersionCheck> {
  if (process.env.PI_CBM_SKIP_VERSION_CHECK === "1") return Promise.resolve({ status: "ok" });

  let check = versionChecks.get(binaryPath);
  if (!check) {
    check = probeCbmVersion(binaryPath).then(({ check: result, retryable }) => {
      // Only cache definitive answers; a spawn error or timeout gets one retry per call.
      if (retryable) versionChecks.delete(binaryPath);
      if (result.version) detectedVersion = result.version;
      if (result.warning && !pendingWarning) pendingWarning = result.warning;
      return result;
    });
    versionChecks.set(binaryPath, check);
  }
  return check;
}

/** Returns the one-time compatibility warning, if any (consumed by the status line). */
export function consumeCbmVersionWarning(): string | undefined {
  const warning = pendingWarning;
  pendingWarning = undefined;
  return warning;
}

function probeCbmVersion(binaryPath: string): Promise<{ check: CbmVersionCheck; retryable: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: CbmVersionCheck, retryable: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ check: result, retryable });
    };

    const child = spawn(binaryPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: "unknown", warning: UNPARSEABLE_WARNING }, true);
    }, VERSION_PROBE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(evaluateCbmVersion(undefined), true));
    child.on("close", () => finish(evaluateCbmVersion(parseCbmVersion(stdout)), false));
  });
}
