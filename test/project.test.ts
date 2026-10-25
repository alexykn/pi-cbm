import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CbmClient } from "../src/cbm/client.js";
import type { CbmCallResult } from "../src/cbm/result.js";
import type { IndexCoordinator } from "../src/domain/index-coordinator.js";
import { ProjectService } from "../src/domain/project.js";

type ProjectRow = { name: string; root_path: string };

function okPage(projects: ProjectRow[], hasMore = false): CbmCallResult {
  return { ok: true, data: { projects, total: projects.length, has_more: hasMore }, rawText: "", stderr: "" };
}

function errorResult(error: string): CbmCallResult {
  return { ok: false, data: { error }, rawText: "", stderr: "" };
}

type Fake = {
  list?: (args: Record<string, unknown>, call: number) => CbmCallResult | Promise<CbmCallResult>;
  gitRoot?: string;
  extra?: (tool: string, args: Record<string, unknown>) => CbmCallResult | Promise<CbmCallResult>;
};

function serviceWith(options: Fake = {}) {
  const listArgs: Array<Record<string, unknown>> = [];
  const coordinator = {
    acquire: async () => ({ ok: true, lease: { signal: new AbortController().signal, release: async () => {} } }),
  } as unknown as IndexCoordinator;
  const cbm = {
    callTool: async (tool: string, args: Record<string, unknown>): Promise<CbmCallResult> => {
      if (tool === "list_projects") {
        listArgs.push(args);
        return options.list ? options.list(args, listArgs.length) : okPage([{ name: "repo", root_path: "/work/repo" }]);
      }
      if (options.extra) return options.extra(tool, args);
      throw new Error(`unexpected cbm tool: ${tool}`);
    },
    findGitRoot: async () => options.gitRoot,
  } as unknown as CbmClient;
  return { service: new ProjectService(cbm, { autoIndexNonGitDirectories: false }, coordinator), listArgs };
}

describe("ProjectService.resolveProject", () => {
  it("infers the project whose root contains the cwd", async () => {
    await expect(serviceWith().service.resolveProject(undefined, "/work/repo/src/domain")).resolves.toBe("repo");
  });

  it("picks the longest matching root for nested projects", async () => {
    const { service } = serviceWith({
      list: () =>
        okPage([
          { name: "outer", root_path: "/work" },
          { name: "inner", root_path: "/work/repo" },
        ]),
    });

    await expect(service.resolveProject(undefined, "/work/repo/src")).resolves.toBe("inner");
  });

  it("fails loudly with the indexed projects when the cwd matches nothing", async () => {
    const { service } = serviceWith({ list: () => okPage([{ name: "other", root_path: "/work/other" }]) });

    await expect(service.resolveProject(undefined, "/home/user")).rejects.toThrow(/cwd "\/home\/user", which has no git root/);
    await expect(service.resolveProject(undefined, "/home/user")).rejects.toThrow(/indexed projects: other -> \/work\/other/);
    await expect(service.resolveProject(undefined, "/home/user")).rejects.toThrow(/absolute path/);
  });

  it("says so when no project is indexed at all", async () => {
    const { service } = serviceWith({ list: () => okPage([]) });

    await expect(service.resolveProject(undefined, "/home/user")).rejects.toThrow(/no projects are indexed yet/);
  });

  it("maps an explicit absolute path, with or without a trailing slash, to the project name", async () => {
    const { service } = serviceWith();

    await expect(service.resolveProject("/work/repo/src", "/home/user")).resolves.toBe("repo");
    await expect(service.resolveProject("/work/repo/", "/home/user")).resolves.toBe("repo");
  });

  it("resolves a relative path against the cwd", async () => {
    await expect(serviceWith().service.resolveProject(".", "/work/repo/src")).resolves.toBe("repo");
  });

  it("rejects an unknown project name with the actionable list, not symbol-not-found", async () => {
    let message = "";
    try {
      await serviceWith().service.resolveProject("home-user", "/home/user");
      expect.unreachable("unknown project should throw");
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/given value "home-user"/);
    expect(message).toMatch(/indexed projects: repo -> \/work\/repo/);
    expect(message).toMatch(/absolute path/);
    expect(message).not.toMatch(/symbol not found/i);
  });

  it("caches list_projects across resolutions within the TTL", async () => {
    const { service, listArgs } = serviceWith();

    await service.resolveProject(undefined, "/work/repo");
    await service.resolveProject("/work/repo/src", "/home/user");

    expect(listArgs).toHaveLength(1);
  });

  it("re-lists after the cache TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const { service, listArgs } = serviceWith();

      await service.resolveProject(undefined, "/work/repo");
      vi.advanceTimersByTime(10_001);
      await service.resolveProject(undefined, "/work/repo");

      expect(listArgs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries past a stale cache so a project indexed since the last list still resolves", async () => {
    const { service, listArgs } = serviceWith({
      list: (_args, call) => (call === 1 ? okPage([]) : okPage([{ name: "repo", root_path: "/work/repo" }])),
    });

    await expect(service.resolveProject("repo", "/home/user")).resolves.toBe("repo");
    expect(listArgs).toHaveLength(2);
  });

  it("pages through list_projects until has_more is false", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ name: `p${index}`, root_path: `/work/p${index}` }));
    const { service, listArgs } = serviceWith({
      list: (_args, call) => (call === 1 ? okPage(firstPage, true) : okPage([{ name: "target", root_path: "/target" }])),
    });

    await expect(service.resolveProject("target", "/home/user")).resolves.toBe("target");
    expect(listArgs).toHaveLength(2);
    expect(listArgs[0]).toMatchObject({ limit: 50, offset: 0 });
    expect(listArgs[1]).toMatchObject({ limit: 50, offset: 50 });
  });

  it("does not cache a failed list_projects", async () => {
    const { service, listArgs } = serviceWith({
      list: (_args, call) => (call === 1 ? errorResult("boom") : okPage([{ name: "repo", root_path: "/work/repo" }])),
    });

    await expect(service.resolveProject("repo", "/home/user")).rejects.toThrow(/boom/);
    await expect(service.resolveProject("repo", "/home/user")).resolves.toBe("repo");
    expect(listArgs).toHaveLength(2);
  });

  it("lets an aborted caller stop waiting without cancelling the shared fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, listArgs } = serviceWith({
      list: async () => {
        await gate;
        return okPage([{ name: "repo", root_path: "/work/repo" }]);
      },
    });

    const controller = new AbortController();
    const aborted = service.resolveProject("repo", "/home/user", controller.signal);
    const waiting = service.resolveProject("repo", "/home/user");
    controller.abort();

    await expect(aborted).rejects.toThrow(/cancelled/);
    release();
    await expect(waiting).resolves.toBe("repo");
    expect(listArgs).toHaveLength(1);
  });

  it("does not cache a fetch that raced an index", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, listArgs } = serviceWith({
      gitRoot: "/work/repo",
      list: async (_args, call) => {
        if (call === 1) {
          await gate;
          return okPage([]);
        }
        return okPage([{ name: "repo", root_path: "/work/repo" }]);
      },
      extra: (tool) => {
        if (tool === "index_repository") return { ok: true, data: { project: "repo" }, rawText: "", stderr: "" };
        throw new Error(`unexpected cbm tool: ${tool}`);
      },
    });

    const stale = service.listProjects();
    await service.indexCurrentRepo("/work/repo");
    release();
    await expect(stale).resolves.toEqual([]);

    await expect(service.listProjects()).resolves.toEqual([{ name: "repo", root_path: "/work/repo" }]);
    expect(listArgs).toHaveLength(2);
  });

  it("resolves a symlinked cwd through realpath", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-cbm-project-"));
    try {
      const real = join(base, "real-repo");
      await mkdir(real);
      const link = join(base, "link-repo");
      await symlink(real, link, "dir");
      const { service } = serviceWith({ list: () => okPage([{ name: "repo", root_path: real }]) });

      await expect(service.resolveProject(undefined, link)).resolves.toBe("repo");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
