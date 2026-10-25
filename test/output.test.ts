import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeCbmData } from "../src/cbm/normalize.js";
import { OutputService } from "../src/domain/output.js";
import { renderResult } from "../src/pi-tools/render.js";

const FIXTURE_DIR = new URL("./fixtures/cbm-0.12.1/", import.meta.url);

function normalizedFixture(name: string): unknown {
  const envelope = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as {
    content: Array<{ type: string; text: string }>;
  };
  return normalizeCbmData(JSON.parse(envelope.content[0]!.text));
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

describe("compact search_graph output on cbm 0.12 paging", () => {
  it("keeps locations, drops 0.12 extras, and hints at the next page", async () => {
    const result = await new OutputService().buildCompactableToolResult(
      "Graph search results",
      normalizedFixture("search_graph.label"),
      {},
      { tool: "search_graph" },
    );

    const text = result.content[0]!.text;
    expect(text).toContain('"qualified_name": "tmp-cbm-fixture-repo.src.domain.index-coordinator.IndexCoordinator.abortAll"');
    expect(text).toMatch(/src\/domain\/index-coordinator\.ts",\s*"start_line": 315,\s*"end_line": 317/);
    expect(text).not.toContain("qn_rule");

    const data = result.details.data as Record<string, unknown>;
    expect(data.total).toBe(61);
    expect(data.returned).toBe(3);
    expect(data.has_more).toBe(true);
    expect(data.truncated).toBe(true);
    expect(String(data.pagination_hint)).toContain("offset=3");
  });

  it("hints the offset that captured page 2 proves cbm honours", async () => {
    // Requested with limit=3, offset=3: an ignored offset would report next_offset 3, not 6.
    const page2 = normalizedFixture("search_graph.label-page2") as { results: unknown[]; next_offset: number };
    const result = await new OutputService().buildCompactableToolResult("Graph search results", page2, {}, { tool: "search_graph" });

    expect(page2.results).toHaveLength(3);
    expect(page2.next_offset).toBe(6);
    expect(String((result.details.data as Record<string, unknown>).pagination_hint)).toContain("offset=6");
  });

  it("renders total with a returned/truncated fallback", () => {
    const withTotal = renderResult("search_graph")({ details: { data: { total: 61, has_more: true } } }, undefined, theme);
    expect(withTotal.render(200).join(" ")).toContain("total=61");

    const withFallback = renderResult("search_graph")({ details: { data: { returned: 3, truncated: true } } }, undefined, theme);
    const line = withFallback.render(200).join(" ");
    expect(line).toContain("returned=3");
    expect(line).toContain("has_more");

    const truncatedOnly = renderResult("search_graph")({ details: { data: { has_more: false, truncated: true } } }, undefined, theme);
    expect(truncatedOnly.render(200).join(" ")).toContain("has_more");
  });

  it("derives the next offset from offset + returned when cbm omits next_offset", async () => {
    const result = await new OutputService().buildCompactableToolResult(
      "Graph search results",
      { total: 61, returned: 3, offset: 5, has_more: true },
      {},
      { tool: "search_graph" },
    );

    expect(String((result.details.data as Record<string, unknown>).pagination_hint)).toContain("offset=8");
  });
});

describe("compact trace output on cbm 0.12 shapes", () => {
  it("surfaces totals, a shortfall hint, and the unlocated-node marker", async () => {
    const result = await new OutputService().buildCompactableToolResult(
      "Trace path results",
      {
        function: "callTool",
        callers_total: 11,
        callees_total: 6,
        callers: [{ qualified_name: "a", file_path: "src/a.ts" }],
        callees: [],
        location_enrichment: { located: 50, unlocated: 10 },
      },
      {},
      { tool: "trace_path" },
    );

    const data = result.details.data as Record<string, unknown>;
    expect(data.callers_total).toBe(11);
    expect(data.callees_total).toBe(6);
    expect(String(data.truncation_hint)).toContain("callers 1/11");
    expect(data.location_enrichment).toMatchObject({ unlocated: 10 });
  });
});

describe("compact search_code output on cbm 0.12 tables", () => {
  it("keeps row identity/location plus search meta", async () => {
    const result = await new OutputService().buildCompactableToolResult(
      "Code search results",
      normalizedFixture("search_code.compact"),
      {},
      { tool: "search_code" },
    );

    const data = result.details.data as Record<string, unknown>;
    const rows = data.results as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.qualified_name).toBe("tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool");
    expect(rows[0]!.file_path).toBe("src/cbm/client.ts");
    expect(rows[0]!.start_line).toBe(43);
    expect(rows[0]!.end_line).toBe(100);
    expect(rows[0]!.match_lines).toEqual([44]);
    expect(data.total_results).toBe(3);
    expect(data.has_more).toBe(false);
  });

  it("hints at the next page from results_returned/result_offset/total_results", async () => {
    const result = await new OutputService().buildCompactableToolResult(
      "Code search results",
      { results_returned: 3, result_offset: 0, total_results: 9, has_more: true, results: [] },
      {},
      { tool: "search_code" },
    );

    const hint = String((result.details.data as Record<string, unknown>).pagination_hint);
    expect(hint).toContain("offset=3");
    expect(hint).toContain("showing 3 of 9");
  });
});

describe("compact detect_changes output on cbm 0.12 shapes", () => {
  it("emits a truncation hint when impacted or changed pages have more", async () => {
    const result = await new OutputService().buildCompactableToolResult(
      "Change impact results",
      { changed_files: [], impacted: [], impacted_has_more: true },
      {},
      { tool: "detect_changes" },
    );

    expect(String((result.details.data as Record<string, unknown>).truncation_hint)).toContain("More impacted symbols");
  });
});
