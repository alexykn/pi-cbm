import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CbmClient } from "../src/cbm/client.js";
import type { CbmCallResult } from "../src/cbm/result.js";
import { INDEX_LEASE_HELD_REASON, type IndexCoordinator, type IndexLeaseResult } from "../src/domain/index-coordinator.js";
import { IndexingService } from "../src/domain/indexing.js";
import { OutputService } from "../src/domain/output.js";
import { ProjectCatalog } from "../src/domain/project-catalog.js";
import { ProjectResolver, type ToolExecutionContext } from "../src/domain/project-resolver.js";
import { QueryService } from "../src/domain/query.js";
import type { TraceService } from "../src/domain/trace.js";

const traceStub = { enrichTraceLocations: async (data: unknown) => data } as unknown as TraceService;

type Harness = {
  ctx: ToolExecutionContext;
  calls: string[];
  indexArgs: Array<Record<string, unknown>>;
  query: QueryService;
  root: string;
  cleanup(): Promise<void>;
};

async function harness(options: {
  acquire: (path: string, signal?: AbortSignal) => Promise<IndexLeaseResult>;
  findGitRoot?: () => Promise<string | undefined>;
  ctxSignal?: AbortSignal;
}): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "pi-cbm-freshness-"));
  const root = join(base, "repo");
  await mkdir(root);

  const calls: string[] = [];
  const indexArgs: Array<Record<string, unknown>> = [];
  const cbm = {
    callTool: async (tool: string, args: Record<string, unknown>): Promise<CbmCallResult> => {
      calls.push(tool);
      if (tool === "index_repository") indexArgs.push(args);
      if (tool === "list_projects") {
        return { ok: true, data: { projects: [{ name: "repo", root_path: root }], has_more: false }, rawText: "", stderr: "" };
      }
      if (tool === "index_repository") {
        return { ok: true, data: { project: "repo", nodes: 1, edges: 1 }, rawText: "", stderr: "" };
      }
      if (tool === "detect_changes") {
        return { ok: true, data: { base: "main", changed_files: [], impacted: [] }, rawText: "", stderr: "" };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
    findGitRoot: options.findGitRoot ?? (async () => root),
  } as unknown as CbmClient;
  const catalog = new ProjectCatalog(cbm);
  const indexing = new IndexingService(cbm, { autoIndexNonGitDirectories: false }, { acquire: options.acquire } as unknown as IndexCoordinator, catalog);

  return {
    ctx: { cwd: root, signal: options.ctxSignal },
    calls,
    indexArgs,
    query: new QueryService(cbm, new ProjectResolver(cbm, catalog), catalog, indexing, new OutputService(), traceStub),
    root,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

function okLease(): IndexLeaseResult {
  return { ok: true, lease: { signal: new AbortController().signal, release: async () => undefined } };
}

function detectChanges(h: Harness) {
  return h.query.executeQueryTool("Change impact results", "detect_changes", {}, h.ctx);
}

const indexCount = (h: Harness) => h.calls.filter((tool) => tool === "index_repository").length;
const freshness = (result: Awaited<ReturnType<typeof detectChanges>>) =>
  String((result.details.data as Record<string, unknown>).index_freshness);

describe("detect_changes index freshness", () => {
  it("indexes once, then skips a second call inside the freshness window", async () => {
    const h = await harness({ acquire: async () => okLease() });
    try {
      expect(freshness(await detectChanges(h))).toContain("index refreshed");
      expect(indexCount(h)).toBe(1);

      expect(freshness(await detectChanges(h))).toContain("index refreshed");
      expect(indexCount(h)).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("waits for a lease held by another session instead of skipping", async () => {
    let attempts = 0;
    const h = await harness({
      acquire: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, reason: INDEX_LEASE_HELD_REASON } : okLease();
      },
    });
    try {
      await detectChanges(h);
      expect(attempts).toBe(2);
      expect(indexCount(h)).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("dedupes concurrent refreshes into a single index", async () => {
    const h = await harness({ acquire: async () => okLease() });
    try {
      await Promise.all([detectChanges(h), detectChanges(h)]);
      expect(indexCount(h)).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("times out a held lease and still reports a possibly-stale graph", async () => {
    const previous = process.env.PI_CBM_FRESH_INDEX_TIMEOUT_MS;
    process.env.PI_CBM_FRESH_INDEX_TIMEOUT_MS = "80";
    const h = await harness({ acquire: async () => ({ ok: false, reason: INDEX_LEASE_HELD_REASON }) });
    try {
      const line = freshness(await detectChanges(h));
      expect(line).toContain("may be stale");
      expect(line).toContain("timed out");
      expect(indexCount(h)).toBe(0);
    } finally {
      await h.cleanup();
      if (previous === undefined) delete process.env.PI_CBM_FRESH_INDEX_TIMEOUT_MS;
      else process.env.PI_CBM_FRESH_INDEX_TIMEOUT_MS = previous;
    }
  });

  it("rethrows when the caller aborts instead of answering", async () => {
    const controller = new AbortController();
    const h = await harness({
      ctxSignal: controller.signal,
      acquire: (path, signal) => {
        if (signal?.aborted) return Promise.resolve({ ok: false, reason: "indexing was cancelled" });
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve({ ok: false, reason: "indexing was cancelled" }), { once: true });
        });
      },
    });
    try {
      setTimeout(() => controller.abort(), 20);
      await expect(detectChanges(h)).rejects.toThrow(/cancelled/);
    } finally {
      await h.cleanup();
    }
  });
});

describe("detect_changes indexes the project root exactly", () => {
  it("targets the project root even when the git root is a parent directory", async () => {
    const h = await harness({ acquire: async () => okLease(), findGitRoot: async () => join("/tmp", "parent-repo") });
    try {
      await detectChanges(h);
      expect(indexCount(h)).toBe(1);
      expect(h.indexArgs[0]!.repo_path).toBe(h.root);

      await detectChanges(h);
      expect(indexCount(h)).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("targets the project root even without a git root", async () => {
    const h = await harness({ acquire: async () => okLease(), findGitRoot: async () => undefined });
    try {
      await detectChanges(h);
      expect(indexCount(h)).toBe(1);
      expect(h.indexArgs[0]!.repo_path).toBe(h.root);

      await detectChanges(h);
      expect(indexCount(h)).toBe(1);
    } finally {
      await h.cleanup();
    }
  });
});
