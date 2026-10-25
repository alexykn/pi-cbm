import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LEASE_HEARTBEAT_MS = 30_000;
const LEASE_STALE_AFTER_MS = 5 * 60_000;
const QUEUE_LOCK_STALE_AFTER_MS = 30_000;
const PROCESS_MARKER_HEARTBEAT_MS = 10_000;
const PROCESS_MARKER_STALE_MULTIPLIER = 3;
const DEFAULT_RETRY_RANGES = [
  [1_000, 2_000],
  [2_000, 4_000],
  [4_000, 8_000],
  [8_000, 12_000],
] as const;

const COORDINATION_DIRECTORY = "pi-cbm";
const LOCKS_DIRECTORY = "locks";
const QUEUE_DIRECTORY = "index-queue";
const PENDING_DIRECTORY = "index-pending";
const SLOTS_DIRECTORY = "index-slots";
const RECORDS_DIRECTORY = "index-records";
const QUEUE_LOCK_NAME = "queue.lock";
const QUEUE_SEQUENCE_NAME = "queue-sequence";

export type IndexLease = {
  signal: AbortSignal;
  release(): Promise<void>;
};

/** `IndexCoordinator.acquire` returns this when another session holds the repo lease. */
export const INDEX_LEASE_HELD_REASON = "another session is indexing; retry deferred";

export type IndexLeaseResult =
  | { ok: true; lease: IndexLease }
  | { ok: false; reason: string };

/** A successful pi-cbm index of `project` at `root`; times are epoch ms. */
export type IndexRecord = {
  project: string;
  root: string;
  startedAt: number;
  finishedAt: number;
};

export type RetryRange = readonly [number, number];

export type IndexCoordinatorOptions = {
  cacheDirectory?: string;
  maxConcurrentIndexes?: number;
  heartbeatMs?: number;
  staleAfterMs?: number;
  queueLockStaleAfterMs?: number;
  retryRanges?: readonly RetryRange[];
  random?: () => number;
};

type LockMetadata = {
  token: string;
  pid: number;
  processInstanceId: string;
  startedAt: number;
};

type OwnerStatus = "alive" | "dead" | "unknown";

type ProcessMarker = {
  path: string;
  heartbeat?: ReturnType<typeof setInterval>;
  ready: Promise<void>;
};

type OwnedLock = {
  release(): Promise<void>;
  releaseSync(): void;
};

type PendingRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; value: { requestId: string; key: string; pid: number; processInstanceId: string } };

type CoordinationPaths = {
  repoLockPath: string;
  queueLockPath: string;
  processIdentityPath: string;
  queueSequencePath: string;
  queueDirectory: string;
  pendingDirectory: string;
  pendingPath: string;
  slotsDirectory: string;
};

type QueueRequest = {
  key: string;
  requestId: string;
  repoPath: string;
  queuePath: string;
  pendingPath: string;
};

type QueueEntry = QueueRequest & {
  fileName: string;
  pid: number;
  processInstanceId: string;
  startedAt: number;
  mtimeMs: number;
};

type ClaimResult =
  | { kind: "acquired"; slot: OwnedLock; repo: OwnedLock }
  | { kind: "wait" }
  | { kind: "skip" };

const ACTIVE_COORDINATORS = new Set<IndexCoordinator>();
const PROCESS_MARKERS = new Map<string, ProcessMarker>();
// A PID is reusable. The fixed per-PID marker is replaced before a process
// probes coordination state, so a recycled PID gets a different identity.
const PROCESS_INSTANCE_SYMBOL = Symbol.for("pi-cbm.process-instance-id");
const PROCESS_GLOBAL = globalThis as typeof globalThis & { [key: symbol]: unknown };
const PROCESS_INSTANCE_ID = typeof PROCESS_GLOBAL[PROCESS_INSTANCE_SYMBOL] === "string"
  ? PROCESS_GLOBAL[PROCESS_INSTANCE_SYMBOL]
  : (() => {
      const value = randomUUID();
      PROCESS_GLOBAL[PROCESS_INSTANCE_SYMBOL] = value;
      return value;
    })();
let processCleanupInstalled = false;

function ensureProcessMarker(path: string): Promise<void> {
  const existing = PROCESS_MARKERS.get(path);
  if (existing) return existing.ready;

  const marker: ProcessMarker = { path, ready: Promise.resolve() };
  PROCESS_MARKERS.set(path, marker);
  marker.ready = createProcessMarker(marker).catch((error) => {
    if (PROCESS_MARKERS.get(path) === marker) PROCESS_MARKERS.delete(path);
    throw error;
  });
  return marker.ready;
}

async function createProcessMarker(marker: ProcessMarker): Promise<void> {
  const temporaryPath = `${marker.path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeExclusive(temporaryPath, {
      pid: process.pid,
      instanceId: PROCESS_INSTANCE_ID,
      startedAt: Date.now(),
    });
    await rename(temporaryPath, marker.path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  marker.heartbeat = setInterval(() => {
    void heartbeatProcessMarker(marker);
  }, PROCESS_MARKER_HEARTBEAT_MS);
  marker.heartbeat.unref?.();
}

async function heartbeatProcessMarker(marker: ProcessMarker): Promise<void> {
  try {
    const now = new Date();
    await utimes(marker.path, now, now);
  } catch (error) {
    if (marker.heartbeat) clearInterval(marker.heartbeat);
    if (PROCESS_MARKERS.get(marker.path) === marker) PROCESS_MARKERS.delete(marker.path);
    if (!isErrno(error, "ENOENT")) {
      console.error("Failed to heartbeat a pi-cbm process identity marker:", error);
    }
  }
}

function releaseProcessMarkersSync(): void {
  for (const [path, marker] of PROCESS_MARKERS) {
    if (marker.heartbeat) clearInterval(marker.heartbeat);
    try {
      const metadata = readJsonSync(path);
      if (metadata?.pid === process.pid && metadata.instanceId === PROCESS_INSTANCE_ID) unlinkSync(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        console.error("Failed to release a pi-cbm process identity marker:", error);
      }
    } finally {
      PROCESS_MARKERS.delete(path);
    }
  }
}

function installProcessCleanupHandlers(): void {
  if (processCleanupInstalled) return;
  processCleanupInstalled = true;

  const cleanup = () => {
    for (const coordinator of ACTIVE_COORDINATORS) {
      try {
        coordinator.releaseAllSync();
      } catch (error) {
        console.error("Failed to clean up pi-cbm index coordination state:", error);
      }
    }
    releaseProcessMarkersSync();
  };
  const abort = () => {
    for (const coordinator of ACTIVE_COORDINATORS) {
      try {
        coordinator.abortAll();
      } catch (error) {
        console.error("Failed to abort pi-cbm index coordination:", error);
      }
    }
  };

  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      abort();
      cleanup();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}

export class IndexCoordinator {
  private readonly cacheDirectory: string;
  private readonly maxConcurrentIndexes: number;
  private readonly heartbeatMs: number;
  private readonly staleAfterMs: number;
  private readonly queueLockStaleAfterMs: number;
  private readonly retryRanges: readonly RetryRange[];
  private readonly random: () => number;
  private readonly ownedLocks = new Set<OwnedLock>();
  private readonly activeRequests = new Set<QueueRequest>();
  private readonly activeControllers = new Set<AbortController>();

  constructor(options: IndexCoordinatorOptions = {}) {
    this.cacheDirectory = resolve(options.cacheDirectory ?? resolveCacheDirectory());
    this.maxConcurrentIndexes = options.maxConcurrentIndexes ?? resolveMaxConcurrentIndexes();
    if (!Number.isInteger(this.maxConcurrentIndexes) || this.maxConcurrentIndexes < 1) {
      throw new RangeError("maxConcurrentIndexes must be a positive integer");
    }

    this.heartbeatMs = options.heartbeatMs ?? LEASE_HEARTBEAT_MS;
    this.staleAfterMs = options.staleAfterMs ?? LEASE_STALE_AFTER_MS;
    this.queueLockStaleAfterMs = options.queueLockStaleAfterMs ?? QUEUE_LOCK_STALE_AFTER_MS;
    this.retryRanges = options.retryRanges ?? DEFAULT_RETRY_RANGES;
    if (this.retryRanges.length === 0 || this.retryRanges.some(([minimum, maximum]) => minimum < 0 || maximum < minimum)) {
      throw new RangeError("retryRanges must contain valid delay ranges");
    }
    this.random = options.random ?? Math.random;
    ACTIVE_COORDINATORS.add(this);
    installProcessCleanupHandlers();
  }

  async acquire(repoPath: string, parentSignal?: AbortSignal): Promise<IndexLeaseResult> {
    if (parentSignal?.aborted) return { ok: false, reason: "indexing was cancelled" };

    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (parentSignal?.aborted) {
      controller.abort();
    } else {
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    }
    this.activeControllers.add(controller);

    let request: QueueRequest | undefined;
    let handedOff = false;
    try {
      const canonicalPath = await canonicalizePath(repoPath);
      const key = projectKey(canonicalPath);
      const paths = await this.pathsFor(key);

      if (controller.signal.aborted) return { ok: false, reason: "indexing was cancelled" };
      if (await this.isLeaseHeld(paths.repoLockPath, paths.processIdentityPath)) {
        return { ok: false, reason: INDEX_LEASE_HELD_REASON };
      }

      const requestResult = await this.enqueue(paths, key, canonicalPath, controller.signal);
      if (!requestResult) {
        if (controller.signal.aborted) return { ok: false, reason: "indexing was cancelled" };
        return { ok: false, reason: INDEX_LEASE_HELD_REASON };
      }
      if (requestResult.kind === "existing") {
        return { ok: false, reason: INDEX_LEASE_HELD_REASON };
      }

      request = requestResult.request;
      let attempt = 0;
      while (!controller.signal.aborted) {
        const claim = await this.tryClaim(request, paths, controller);
        if (claim?.kind === "acquired") {
          handedOff = true;
          return {
            ok: true,
            lease: this.createLease(request, controller, parentSignal, onParentAbort, claim),
          };
        }
        if (claim?.kind === "skip") {
          return { ok: false, reason: INDEX_LEASE_HELD_REASON };
        }

        const delay = this.retryDelay(attempt);
        attempt = Math.min(attempt + 1, this.retryRanges.length - 1);
        if (!(await waitForRetry(delay, controller.signal))) break;
      }

      return { ok: false, reason: "indexing was cancelled" };
    } finally {
      if (!handedOff) {
        try {
          if (request) await this.removeRequest(request);
        } finally {
          parentSignal?.removeEventListener("abort", onParentAbort);
          this.activeControllers.delete(controller);
        }
      }
    }
  }

  /** The last successful pi-cbm index of `project`, shared by every session using this cache dir. */
  async readIndexRecord(project: string): Promise<IndexRecord | undefined> {
    const value = await readJson(this.indexRecordPath(project));
    if (
      !value ||
      value.project !== project ||
      typeof value.root !== "string" ||
      typeof value.startedAt !== "number" ||
      typeof value.finishedAt !== "number"
    ) {
      return undefined;
    }
    return { project, root: value.root, startedAt: value.startedAt, finishedAt: value.finishedAt };
  }

  /** Replace the record atomically, so a concurrent reader sees the old or the new one, never a partial file. */
  async writeIndexRecord(record: IndexRecord): Promise<void> {
    const path = this.indexRecordPath(record.project);
    await mkdir(join(this.cacheDirectory, COORDINATION_DIRECTORY, RECORDS_DIRECTORY), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeExclusive(temporaryPath, record);
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  abortAll(): void {
    for (const controller of this.activeControllers) controller.abort();
  }

  private indexRecordPath(project: string): string {
    return join(this.cacheDirectory, COORDINATION_DIRECTORY, RECORDS_DIRECTORY, `${projectKey(project)}.json`);
  }

  releaseAllSync(): void {
    this.abortAll();

    for (const lock of [...this.ownedLocks]) {
      try {
        lock.releaseSync();
      } catch (error) {
        console.error("Failed to release a pi-cbm coordination lock:", error);
      }
    }

    for (const request of [...this.activeRequests]) {
      try {
        this.removeRequestSync(request);
      } catch (error) {
        console.error("Failed to remove a pi-cbm index request:", error);
      }
    }
    this.activeRequests.clear();
  }

  private async pathsFor(key: string): Promise<CoordinationPaths> {
    const coordinationDirectory = join(this.cacheDirectory, COORDINATION_DIRECTORY);
    const locksDirectory = join(coordinationDirectory, LOCKS_DIRECTORY);
    const queueDirectory = join(coordinationDirectory, QUEUE_DIRECTORY);
    const pendingDirectory = join(coordinationDirectory, PENDING_DIRECTORY);
    const slotsDirectory = join(coordinationDirectory, SLOTS_DIRECTORY);
    const processIdentityPath = join(coordinationDirectory, `process-${process.pid}.json`);

    await Promise.all([
      mkdir(locksDirectory, { recursive: true, mode: 0o700 }),
      mkdir(queueDirectory, { recursive: true, mode: 0o700 }),
      mkdir(pendingDirectory, { recursive: true, mode: 0o700 }),
      mkdir(slotsDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await ensureProcessMarker(processIdentityPath);

    return {
      repoLockPath: join(locksDirectory, `${key}.lock`),
      queueLockPath: join(coordinationDirectory, QUEUE_LOCK_NAME),
      processIdentityPath,
      queueSequencePath: join(coordinationDirectory, QUEUE_SEQUENCE_NAME),
      queueDirectory,
      pendingDirectory,
      pendingPath: join(pendingDirectory, `${key}.json`),
      slotsDirectory,
    };
  }

  private async enqueue(
    paths: CoordinationPaths,
    key: string,
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<{ kind: "owned"; request: QueueRequest } | { kind: "existing" } | undefined> {
    return this.withQueueLock(paths, signal, async () => {
      const existing = await this.readPending(paths.pendingPath);
      if (existing.kind === "valid" && existing.value.key === key) {
        const status = await ownerStatus(
          existing.value.pid,
          existing.value.processInstanceId,
          paths.processIdentityPath,
          LEASE_STALE_AFTER_MS,
        );
        const ageMs = await resourceAgeMs(paths.pendingPath);
        if (status === "alive" || (status === "unknown" && ageMs !== undefined && ageMs <= LEASE_STALE_AFTER_MS)) {
          return { kind: "existing" };
        }
        await this.removePendingAndQueueEntries(paths, existing.value.requestId, key);
      } else if (existing.kind !== "missing") {
        // A process can die while writing this file. Treat malformed or
        // mismatched metadata as abandoned rather than letting it block the
        // repository forever.
        await unlink(paths.pendingPath).catch(() => undefined);
      }

      const requestId = randomUUID();
      const metadata = {
        key,
        requestId,
        repoPath,
        pid: process.pid,
        processInstanceId: PROCESS_INSTANCE_ID,
        startedAt: Date.now(),
      };
      await writeExclusive(paths.pendingPath, metadata);

      try {
        const sequence = await this.nextQueueSequence(paths);
        const fileName = `${String(sequence).padStart(20, "0")}-${key}-${requestId}.json`;
        const queuePath = join(paths.queueDirectory, fileName);
        await writeExclusive(queuePath, metadata);
        const request = { key, requestId, repoPath, queuePath, pendingPath: paths.pendingPath };
        this.activeRequests.add(request);
        return { kind: "owned", request };
      } catch (error) {
        await unlink(paths.pendingPath).catch(() => undefined);
        throw error;
      }
    });
  }

  private async tryClaim(request: QueueRequest, paths: CoordinationPaths, controller: AbortController): Promise<ClaimResult | undefined> {
    return this.withQueueLock(paths, controller.signal, async () => {
      const entries = await this.cleanDeadQueueEntries(paths);
      const ownEntry = entries.find((entry) => entry.requestId === request.requestId);
      if (!ownEntry) return { kind: "skip" };

      const rank = entries.indexOf(ownEntry);
      if (rank >= this.maxConcurrentIndexes) return { kind: "wait" };

      const slot = await this.claimSlot(paths.slotsDirectory, paths.processIdentityPath, controller);
      if (!slot) return { kind: "wait" };

      let repo = await this.createOwnedLock(paths.repoLockPath, controller.signal, () => controller.abort());
      if (!repo && (await this.reclaimStaleLease(paths.repoLockPath, this.staleAfterMs, paths.processIdentityPath))) {
        repo = await this.createOwnedLock(paths.repoLockPath, controller.signal, () => controller.abort());
      }

      if (!repo) {
        await slot.release();
        await this.removePendingAndQueueEntries(paths, request.requestId, request.key);
        return { kind: "skip" };
      }

      return { kind: "acquired", slot, repo };
    });
  }

  private async claimSlot(slotsDirectory: string, processIdentityPath: string, controller: AbortController): Promise<OwnedLock | undefined> {
    for (let index = 0; index < this.maxConcurrentIndexes; index += 1) {
      const slotPath = join(slotsDirectory, `${index}.lock`);
      await this.reclaimStaleLease(slotPath, this.staleAfterMs, processIdentityPath);
      const slot = await this.createOwnedLock(slotPath, controller.signal, () => controller.abort());
      if (slot) return slot;
    }
    return undefined;
  }

  private createLease(
    request: QueueRequest,
    controller: AbortController,
    parentSignal: AbortSignal | undefined,
    onParentAbort: () => void,
    claim: Extract<ClaimResult, { kind: "acquired" }>,
  ): IndexLease {
    let released = false;
    return {
      signal: controller.signal,
      release: async () => {
        if (released) return;
        released = true;
        parentSignal?.removeEventListener("abort", onParentAbort);
        try {
          await claim.repo.release();
        } finally {
          try {
            await claim.slot.release();
          } finally {
            this.activeControllers.delete(controller);
            await this.removeRequest(request);
          }
        }
      },
    };
  }

  private async removeRequest(request: QueueRequest): Promise<void> {
    try {
      const paths = await this.pathsFor(request.key);
      await this.withQueueLock(paths, undefined, async () => {
        await this.removePendingAndQueueEntries(paths, request.requestId, request.key);
      });
    } finally {
      this.activeRequests.delete(request);
    }
  }

  private removeRequestSync(request: QueueRequest): void {
    try {
      unlinkOwnedRequestSync(request.pendingPath, request.requestId, request.key);
      unlinkOwnedRequestSync(request.queuePath, request.requestId, request.key);
    } finally {
      this.activeRequests.delete(request);
    }
  }

  private async withQueueLock<T>(
    paths: CoordinationPaths,
    signal: AbortSignal | undefined,
    callback: () => Promise<T>,
  ): Promise<T | undefined> {
    let attempt = 0;
    while (!signal?.aborted) {
      await this.reclaimStaleLease(paths.queueLockPath, this.queueLockStaleAfterMs, paths.processIdentityPath);
      const lock = await this.createOwnedLock(paths.queueLockPath, signal, () => undefined, 0);
      if (lock) {
        try {
          return await callback();
        } finally {
          await lock.release();
        }
      }

      const delay = this.retryDelay(attempt);
      attempt = Math.min(attempt + 1, this.retryRanges.length - 1);
      if (!(await waitForRetry(delay, signal))) return undefined;
    }

    return undefined;
  }

  private async cleanDeadQueueEntries(paths: CoordinationPaths): Promise<QueueEntry[]> {
    const entries = await this.readQueueEntries(paths.queueDirectory);
    const alive: QueueEntry[] = [];
    for (const entry of entries) {
      const status = await ownerStatus(
        entry.pid,
        entry.processInstanceId,
        paths.processIdentityPath,
        LEASE_STALE_AFTER_MS,
      );
      if (status === "alive" || (status === "unknown" && !isResourceStale(entry.mtimeMs, LEASE_STALE_AFTER_MS))) {
        alive.push(entry);
        continue;
      }
      await unlink(entry.queuePath).catch(() => undefined);
      await this.removePendingAndQueueEntries(paths, entry.requestId, entry.key);
    }
    return alive;
  }

  private async readQueueEntries(queueDirectory: string): Promise<QueueEntry[]> {
    const names = (await readdir(queueDirectory)).filter((name) => name.endsWith(".json")).sort();
    const entries: QueueEntry[] = [];
    for (const fileName of names) {
      const queuePath = join(queueDirectory, fileName);
      const metadata = await readJson(queuePath);
      if (!metadata || typeof metadata.key !== "string" || typeof metadata.requestId !== "string" || typeof metadata.repoPath !== "string") {
        await unlink(queuePath).catch(() => undefined);
        continue;
      }
      if (
        typeof metadata.pid !== "number" ||
        !Number.isInteger(metadata.pid) ||
        typeof metadata.processInstanceId !== "string" ||
        metadata.processInstanceId.length === 0 ||
        typeof metadata.startedAt !== "number"
      ) {
        await unlink(queuePath).catch(() => undefined);
        continue;
      }
      const queueStat = await stat(queuePath).catch((error) => {
        if (isErrno(error, "ENOENT")) return undefined;
        throw error;
      });
      if (!queueStat) continue;
      entries.push({
        fileName,
        queuePath,
        key: metadata.key,
        requestId: metadata.requestId,
        repoPath: metadata.repoPath,
        pendingPath: "",
        pid: metadata.pid,
        processInstanceId: metadata.processInstanceId,
        startedAt: metadata.startedAt,
        mtimeMs: queueStat.mtimeMs,
      });
    }
    return entries;
  }

  private async removePendingAndQueueEntries(paths: CoordinationPaths, requestId: string, key: string): Promise<void> {
    const pending = await readJson(paths.pendingPath);
    if (pending?.requestId === requestId && pending.key === key) {
      await unlink(paths.pendingPath).catch(() => undefined);
    }

    const entries = await this.readQueueEntries(paths.queueDirectory);
    await Promise.all(
      entries
        .filter((entry) => entry.requestId === requestId && entry.key === key)
        .map((entry) => unlink(entry.queuePath).catch(() => undefined)),
    );
  }

  private async readPending(path: string): Promise<PendingRead> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { kind: "missing" };
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return { kind: "invalid" };
    }

    if (
      !isRecord(value) ||
      typeof value.requestId !== "string" ||
      typeof value.key !== "string" ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      typeof value.processInstanceId !== "string" ||
      value.processInstanceId.length === 0
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "valid",
      value: { requestId: value.requestId, key: value.key, pid: value.pid, processInstanceId: value.processInstanceId },
    };
  }

  private async nextQueueSequence(paths: CoordinationPaths): Promise<number> {
    const stored = await readFile(paths.queueSequencePath, "utf8").catch(() => "0");
    const parsed = Number.parseInt(stored, 10);
    const entries = await readdir(paths.queueDirectory);
    const highestExisting = entries.reduce((highest, name) => {
      const sequence = Number.parseInt(name.split("-", 1)[0] ?? "0", 10);
      return Number.isFinite(sequence) ? Math.max(highest, sequence) : highest;
    }, 0);
    const next = Math.max(Number.isFinite(parsed) ? parsed : 0, highestExisting) + 1;
    await writeFileText(paths.queueSequencePath, String(next));
    return next;
  }

  private async isLeaseHeld(lockPath: string, processIdentityPath: string): Promise<boolean> {
    try {
      await stat(lockPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }

    if (await this.reclaimStaleLease(lockPath, this.staleAfterMs, processIdentityPath)) return false;
    return true;
  }

  private async reclaimStaleLease(lockPath: string, staleAfterMs: number, processIdentityPath: string): Promise<boolean> {
    let lockStat;
    try {
      lockStat = await stat(lockPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }

    const metadata = await readLockMetadata(lockPath);
    if (metadata) {
      const status = await ownerStatus(metadata.pid, metadata.processInstanceId, processIdentityPath, staleAfterMs);
      if (status === "alive") return false;
      if (status === "unknown" && !isResourceStale(lockStat.mtimeMs, staleAfterMs)) return false;
    } else if (!isResourceStale(lockStat.mtimeMs, staleAfterMs)) {
      return false;
    }

    const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "EACCES") || isErrno(error, "EBUSY") || isErrno(error, "EPERM")) return false;
      throw error;
    }

    await unlink(stalePath).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
    return true;
  }

  private async createOwnedLock(
    lockPath: string,
    parentSignal: AbortSignal | undefined,
    onLost: () => void,
    heartbeatMs = this.heartbeatMs,
  ): Promise<OwnedLock | undefined> {
    if (parentSignal?.aborted) return undefined;

    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (isErrno(error, "EEXIST")) return undefined;
      throw error;
    }

    const token = randomUUID();
    const metadata: LockMetadata = {
      token,
      pid: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      startedAt: Date.now(),
    };

    try {
      await handle.writeFile(JSON.stringify(metadata), "utf8");
      await handle.sync();
      await handle.utimes(new Date(), new Date());
    } catch (error) {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }

    let released = false;
    let ownershipLost = false;
    const heartbeat = heartbeatMs > 0
      ? setInterval(() => {
          void (async () => {
            if (released || ownershipLost) return;
            try {
              const currentMetadata = await readLockMetadata(lockPath);
              if (currentMetadata?.token !== token) {
                ownershipLost = true;
                onLost();
                return;
              }
              await handle.utimes(new Date(), new Date());
            } catch {
              if (!released) {
                ownershipLost = true;
                onLost();
              }
            }
          })();
        }, heartbeatMs)
      : undefined;
    heartbeat?.unref?.();

    const release = async () => {
      if (released) return;
      released = true;
      if (heartbeat) clearInterval(heartbeat);

      try {
        if (!ownershipLost) {
          const currentMetadata = await readLockMetadata(lockPath);
          if (currentMetadata?.token === token) await unlink(lockPath);
        }
      } finally {
        this.ownedLocks.delete(lock);
        await handle.close();
      }
    };

    const releaseSync = () => {
      if (released) return;
      released = true;
      if (heartbeat) clearInterval(heartbeat);

      try {
        if (!ownershipLost) unlinkOwnedLockSync(lockPath, token);
      } finally {
        this.ownedLocks.delete(lock);
        void handle.close().catch((error) => console.error("Failed to close a pi-cbm coordination lock:", error));
      }
    };

    const lock: OwnedLock = { release, releaseSync };
    this.ownedLocks.add(lock);

    if (parentSignal?.aborted) {
      await release();
      return undefined;
    }

    return lock;
  }

  private retryDelay(attempt: number): number {
    const [minimum, maximum] = this.retryRanges[Math.min(attempt, this.retryRanges.length - 1)] ?? [1_000, 2_000];
    return minimum + Math.floor(this.random() * (maximum - minimum + 1));
  }
}

// These two knobs read process.env inline rather than through shared/env.ts because the
// cross-process tests load this file on its own, without its relative imports.
function resolveCacheDirectory(): string {
  // PI_CBM_CACHE_DIR wins. CBM_CACHE_DIR is not a pi-cbm alias but cbm's own
  // variable, which the binary reads from the inherited environment: without
  // this fallback the leases and index records would land in ~/.cache while
  // cbm writes its databases elsewhere.
  const configured = process.env.PI_CBM_CACHE_DIR?.trim() || process.env.CBM_CACHE_DIR?.trim();
  return resolve(configured || join(homedir(), ".cache", "codebase-memory-mcp"));
}

function resolveMaxConcurrentIndexes(): number {
  const configured = process.env.PI_CBM_MAX_CONCURRENT_INDEXES?.trim();
  if (!configured) return 1;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

async function canonicalizePath(path: string): Promise<string> {
  try {
    return normalizePath(await realpath(path));
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return normalizePath(resolve(path));
  }
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function projectKey(repoPath: string): string {
  return createHash("sha256").update(repoPath).digest("hex");
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileText(path: string, value: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function unlinkOwnedLockSync(lockPath: string, token: string): void {
  const metadata = readJsonSync(lockPath);
  if (metadata?.token !== token) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function unlinkOwnedRequestSync(path: string, requestId: string, key: string): void {
  const metadata = readJsonSync(path);
  if (metadata?.requestId !== requestId || metadata.key !== key) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function readJsonSync(path: string): Record<string, unknown> | undefined {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }

  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }

  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata | undefined> {
  const metadata = await readJson(lockPath);
  if (
    !metadata ||
    typeof metadata.token !== "string" ||
    typeof metadata.pid !== "number" ||
    !Number.isInteger(metadata.pid) ||
    typeof metadata.processInstanceId !== "string" ||
    metadata.processInstanceId.length === 0 ||
    typeof metadata.startedAt !== "number"
  ) {
    return undefined;
  }
  return {
    token: metadata.token,
    pid: metadata.pid,
    processInstanceId: metadata.processInstanceId,
    startedAt: metadata.startedAt,
  };
}

async function ownerStatus(
  pid: number,
  processInstanceId: string,
  processIdentityPath: string,
  staleAfterMs: number,
): Promise<OwnerStatus> {
  if (!isProcessAlive(pid)) return "dead";

  const marker = await readJson(processIdentityPath);
  if (!marker || marker.pid !== pid || typeof marker.instanceId !== "string") return "unknown";
  if (marker.instanceId !== processInstanceId) return "dead";

  const markerStat = await stat(processIdentityPath).catch((error) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!markerStat) return "unknown";

  const markerStaleAfterMs = Math.max(staleAfterMs, PROCESS_MARKER_HEARTBEAT_MS * PROCESS_MARKER_STALE_MULTIPLIER);
  return isResourceStale(markerStat.mtimeMs, markerStaleAfterMs) ? "unknown" : "alive";
}

async function resourceAgeMs(path: string): Promise<number | undefined> {
  const fileStat = await stat(path).catch((error) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  return fileStat ? Date.now() - fileStat.mtimeMs : undefined;
}

function isResourceStale(mtimeMs: number, staleAfterMs: number): boolean {
  return Date.now() - mtimeMs > staleAfterMs;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/** Wait `delay` ms; false when `signal` aborted first. */
export async function waitForRetry(delay: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveWait(result);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
