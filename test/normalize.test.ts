import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeCbmData } from "../src/cbm/normalize.js";

type JsonObject = Record<string, any>;

function fixture(name: string): JsonObject {
  const envelope = JSON.parse(readFileSync(new URL(`./fixtures/cbm-0.12.1/${name}.json`, import.meta.url), "utf8")) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(envelope.content[0].text) as JsonObject;
}

function normalize(name: string): JsonObject {
  return normalizeCbmData(fixture(name)) as JsonObject;
}

describe("normalizeCbmData", () => {
  it("expands search_graph groups into `results` keyed by qn_rule and keeps the paging fields", () => {
    const data = normalize("search_graph.name-pattern");
    expect(data.total).toBe(1);
    expect(data.has_more).toBe(false);
    expect(data.truncated).toBe(false);
    expect(data.returned).toBe(1);
    expect(data.cols).toBeUndefined();
    expect(data.groups).toBeUndefined();
    expect(data.results).toHaveLength(1);

    const [item] = data.results as JsonObject[];
    expect(item.name).toBe("callTool");
    expect(item.qualified_name).toBe("tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool");
    expect(item.file_path).toBe("src/cbm/client.ts");
    expect(item.start_line).toBe(43);
    expect(item.end_line).toBe(100);
    expect(item.in_degree).toBe(11);
    expect(item.out_degree).toBe(10);
  });

  it("derives the line range from `lines` even when fields leaves start_line/end_line null", () => {
    const [item] = normalize("search_graph.fields").results as JsonObject[];
    expect(item.start_line).toBe(43);
    expect(item.end_line).toBe(100);
    expect(item.signature).toContain("toolName");
  });

  it("expands nested trace_path caller/callee groups without a results wrapper", () => {
    const data = normalize("trace_path.depth1");
    expect(data.results).toBeUndefined();

    const callees = data.callees as JsonObject[];
    expect(Array.isArray(callees)).toBe(true);
    expect(callees.some((item) => item.qualified_name === "tmp-cbm-fixture-repo.src.cbm.envelope.parseMaybeJson")).toBe(true);

    const callers = data.callers as JsonObject[];
    expect(callers.every((item) => typeof item.qualified_name === "string" && item.hop === 1)).toBe(true);
  });

  it("expands search_code rows under `results` with paging meta and field aliases", () => {
    const data = normalize("search_code.compact");
    expect(data.total_results).toBe(3);
    expect(data.has_more).toBe(false);
    expect(data.raw_matches).toEqual([]);

    const first = (data.results as JsonObject[])[0];
    expect(first.qualified_name).toBe("tmp-cbm-fixture-repo.src.cbm.client.CbmClient.callTool");
    expect(first.file).toBe("src/cbm/client.ts");
    expect(first.file_path).toBe("src/cbm/client.ts");
    expect(first.start_line).toBe(43);
    expect(first.end_line).toBe(100);
    expect(first.match_lines).toEqual([44]);
    expect(first.in_degree).toBe(11);
    expect(first.out_degree).toBe(6);
  });

  it("expands a flat search_graph query table with its paging meta", () => {
    const data = normalize("search_graph.query");
    expect(data.total).toBe(81);
    expect(data.has_more).toBe(true);
    expect(data.next_offset).toBe(5);
    expect(data.results).toHaveLength(5);

    const first = (data.results as JsonObject[])[0];
    expect(first.qualified_name).toBe("tmp-cbm-fixture-repo.src.domain.index-coordinator.cleanup");
    expect(first.file_path).toBe("src/domain/index-coordinator.ts");
    expect(first.start_line).toBe(186);
    expect(first.end_line).toBe(195);
    expect(first.rank).toBeCloseTo(-12.89866, 3);
  });

  it("expands get_architecture node_labels", () => {
    const labels = normalize("get_architecture.default").node_labels as JsonObject[];
    expect(Array.isArray(labels)).toBe(true);
    expect(labels.find((entry) => entry.label === "Function")?.count).toBe(130);
  });

  it("leaves detect_changes object arrays untouched", () => {
    const data = normalize("detect_changes.dirty");
    expect(data.changed_files).toEqual(["src/shared/strings.ts"]);
    const impacted = data.impacted as JsonObject[];
    expect(impacted[0].qn).toBe("tmp-cbm-fixture-repo.src.domain.auto-index-paths.validateAutoIndexPath");
    expect(impacted[0].hop).toBe(1);
  });

  it("uses the bare name for an empty qn_prefix group", () => {
    const data = normalizeCbmData({
      qn_rule: 'qn = qn_prefix == "" ? name : qn_prefix + "." + name',
      cols: ["name"],
      groups: [{ qn_prefix: "", rows: [["standalone"]] }],
    }) as JsonObject[];
    expect(data).toEqual([{ name: "standalone", qualified_name: "standalone" }]);
  });

  it("passes query_graph {columns, rows} through unchanged", () => {
    const original = fixture("query_graph.projection");
    expect(normalizeCbmData(original)).toEqual(original);
  });

  it("keeps meta for an empty rows page", () => {
    const data = normalizeCbmData({ cols: ["name"], rows: [], total: 0, has_more: false }) as JsonObject;
    expect(data).toEqual({ total: 0, has_more: false, results: [] });
  });

  it("keeps meta for an empty groups page", () => {
    const data = normalizeCbmData({ qn_rule: "qn", cols: ["name"], groups: [], total: 0, has_more: false }) as JsonObject;
    expect(data).toEqual({ qn_rule: "qn", total: 0, has_more: false, results: [] });
  });

  it("does not copy null aliases", () => {
    const data = normalizeCbmData({
      cols: ["qn", "file", "lines"],
      rows: [["a.b", null, null]],
      total: 1,
      returned: 1,
      has_more: false,
    }) as JsonObject;
    const [item] = data.results as JsonObject[];
    expect(item.qualified_name).toBe("a.b");
    expect(item.file_path).toBeUndefined();
    expect(item.start_line).toBeUndefined();
  });
});
