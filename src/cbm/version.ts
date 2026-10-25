import { spawn } from "node:child_process";
import { awaitWithSignal } from "../shared/concurrency.js";

/** Range this extension is tested against. */
export const SUPPORTED_CBM_VERSION_RANGE = ">=0.12.0 <0.13.0";

const VERSION_PROBE_TIMEOUT_MS = 15_000;
/** A probe that could not run (spawn error, timeout) is retried after this long instead of on every call. */
const UNKNOWN_VERSION_TTL_MS = 60_000;
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

/** A compatibility message for the user: a too-old binary is an error, anything uncertain a warning. */
export type CbmVersionNotice = { level: "error" | "warning"; message: string };

type VersionProbe = { check: Promise<CbmVersionCheck>; expiresAt?: number };

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

function noticeFor(check: CbmVersionCheck): CbmVersionNotice | undefined {
  if (check.status === "too-old" && check.message) return { level: "error", message: check.message };
  if (check.warning) return { level: "warning", message: check.warning };
  return undefined;
}

/** One `--version` probe per binary path, with each compatibility notice handed out once. */
export class CbmVersionGate {
  private readonly probes = new Map<string, VersionProbe>();
  private readonly noticed = new Set<string>();
  private pending: CbmVersionNotice[] = [];

  check(binaryPath: string, signal?: AbortSignal): Promise<CbmVersionCheck> {
    if (process.env.PI_CBM_SKIP_VERSION_CHECK === "1") return Promise.resolve({ status: "ok" });

    const cached = this.probes.get(binaryPath);
    if (cached && (cached.expiresAt === undefined || Date.now() < cached.expiresAt)) {
      return awaitWithSignal(cached.check, signal, "codebase-memory-mcp version check cancelled");
    }

    const probe: VersionProbe = {
      // The shared probe runs unsignalled; an aborting caller only stops waiting for it.
      check: probeCbmVersion(binaryPath).then(({ check, retryable }) => {
        if (retryable) probe.expiresAt = Date.now() + UNKNOWN_VERSION_TTL_MS;
        this.record(check);
        return check;
      }),
    };
    this.probes.set(binaryPath, probe);
    return awaitWithSignal(probe.check, signal, "codebase-memory-mcp version check cancelled");
  }

  /** Notices not yet shown to the user; each distinct message is returned only once. */
  takeNotices(): CbmVersionNotice[] {
    const notices = this.pending;
    this.pending = [];
    return notices;
  }

  private record(check: CbmVersionCheck): void {
    const notice = noticeFor(check);
    if (!notice || this.noticed.has(notice.message)) return;
    this.noticed.add(notice.message);
    this.pending.push(notice);
  }
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
      finish(evaluateCbmVersion(undefined), true);
    }, VERSION_PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(evaluateCbmVersion(undefined), true));
    child.on("close", () => finish(evaluateCbmVersion(parseCbmVersion(stdout)), false));
  });
}
