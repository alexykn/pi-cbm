import { describe, expect, it } from "vitest";
import type { CbmClient } from "../src/cbm/client.js";
import { CbmToolError } from "../src/cbm/errors.js";
import type { CbmCallResult } from "../src/cbm/result.js";
import type { IndexingService } from "../src/domain/indexing.js";
import { OutputService } from "../src/domain/output.js";
import { ProjectCatalog } from "../src/domain/project-catalog.js";
import { ProjectResolver, type ToolExecutionContext } from "../src/domain/project-resolver.js";
import { QueryService } from "../src/domain/query.js";
import type { TraceService } from "../src/domain/trace.js";

const CTX: ToolExecutionContext = { cwd: "/tmp/cbm-fixture-repo" };

function queryServiceWith(callTool: (tool: string, args: Record<string, unknown>) => CbmCallResult | Promise<CbmCallResult>): QueryService {
  const cbm = {
    callTool: async (tool: string, args: Record<string, unknown>): Promise<CbmCallResult> => {
      if (tool === "list_projects") {
        return { ok: true, data: { projects: [{ name: "repo", root_path: "/tmp/cbm-fixture-repo" }], has_more: false }, rawText: "", stderr: "" };
      }
      return callTool(tool, args);
    },
    findGitRoot: async () => undefined,
  } as unknown as CbmClient;
  const catalog = new ProjectCatalog(cbm);
  return new QueryService(cbm, new ProjectResolver(cbm, catalog), catalog, {} as IndexingService, new OutputService(), {} as TraceService);
}

const projectError = (tool: string) => {
  throw new CbmToolError(tool, {
    error: "project not found or not indexed",
    hint: "Run list_projects to see indexed projects.",
    available_projects: ["tmp-cbm-fixture-repo"],
  });
};

describe("QueryService project errors", () => {
  it("rethrows a query_graph project error with the actionable project list", async () => {
    const service = queryServiceWith(projectError);

    await expect(service.queryGraph({ project: "repo" }, CTX)).rejects.toThrow(
      /project not found or not indexed.*indexed projects: repo -> \/tmp\/cbm-fixture-repo.*absolute path/,
    );
  });

  it("shows cbm's error, hint and available projects as text, not raw JSON", async () => {
    const service = queryServiceWith(projectError);

    let message = "";
    await service.queryGraph({ project: "repo" }, CTX).catch((error: Error) => (message = error.message));

    expect(message).toMatch(/^project not found or not indexed Run list_projects to see indexed projects\. available_projects: tmp-cbm-fixture-repo No indexed project/);
    expect(message).not.toContain('{"');
  });

  it("rethrows a query-tool project error with the actionable project list", async () => {
    const service = queryServiceWith(projectError);

    await expect(service.executeQueryTool("Snippet", "get_code_snippet", { qualified_name: "x", project: "repo" }, CTX)).rejects.toThrow(
      /project not found or not indexed.*absolute path/,
    );
  });
});

describe("query_graph 0.12 shapes", () => {
  it("coerces numeric metrics and keeps the paging meta", async () => {
    const service = queryServiceWith(async () => ({
      ok: true,
      data: { columns: ["name", "complexity"], rows: [["a", "5"]], returned: 1, total: 1, has_more: false },
      rawText: "",
      stderr: "",
    }));

    const result = await service.queryGraph({ query: "MATCH (n) RETURN n.name, n.complexity" }, CTX);
    const data = result.details.data as Record<string, unknown>;
    expect(data.rows).toEqual([["a", 5]]);
    expect(data.returned).toBe(1);
    expect(data.has_more).toBe(false);
  });
});

describe("search_code paging argument mapping", () => {
  it("sends result_offset and never a bare offset to cbm", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const service = queryServiceWith(async (_tool, args) => {
      seen.push(args);
      return {
        ok: true,
        data: { results: [], has_more: true, results_returned: 2, result_offset: args.result_offset, total_results: 44 },
        rawText: "",
        stderr: "",
      };
    });

    const result = await service.executeQueryTool("Code search results", "search_code", { pattern: "ask_owner", limit: 2, offset: 2 }, CTX);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.result_offset).toBe(2);
    expect(seen[0]!.offset).toBeUndefined();
    expect(String((result.details.data as Record<string, unknown>).pagination_hint)).toContain("offset=4");
  });
});
