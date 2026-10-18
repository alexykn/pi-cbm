import { CbmClient } from "../cbm/client.js";
import type { CbmData } from "../cbm/normalize.js";
import { queryTimeoutMs } from "../cbm/timeouts.js";
import { isRecord, removeUndefined } from "../shared/object.js";
import { OutputService, stripOutputControls } from "./output.js";
import { ProjectService, type IndexFreshness, type ToolExecutionContext } from "./project.js";
import { TraceService } from "./trace.js";

const NUMERIC_QUERY_COLUMNS = new Set([
  "complexity",
  "cognitive",
  "lines",
  "line",
  "start_line",
  "end_line",
  "param_count",
  "in_degree",
  "out_degree",
  "fan_in",
  "fan_out",
  "degree",
  "count",
  "total",
  "nodes",
  "edges",
  "size_bytes",
  "hop",
  "depth",
]);

function coerceQueryGraphMetrics(data: CbmData): CbmData {
  if (!isRecord(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return data;
  const columns = data.columns.map((column) => (typeof column === "string" ? column.toLowerCase() : ""));
  const rows = data.rows.map((row) => {
    if (!Array.isArray(row)) return row;
    return row.map((value, index) => {
      if (!NUMERIC_QUERY_COLUMNS.has(columns[index] ?? "")) return value;
      if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) return value;
      return Number(value);
    });
  });
  return { ...data, rows };
}

function freshnessLine(freshness: IndexFreshness): string {
  return freshness.refreshed
    ? `index refreshed ${Math.round(freshness.age_ms / 1000)} s ago`
    : `graph may be stale: ${freshness.reason}`;
}

function withIndexFreshness(data: CbmData, freshness: IndexFreshness): CbmData {
  if (!isRecord(data)) return data;
  return { ...data, index_freshness: freshnessLine(freshness) };
}

/** cbm 0.12 `search_code` pages with `result_offset`; keep the agent-facing `offset` name. */
function upstreamSearchCodeParams(params: Record<string, unknown>): Record<string, unknown> {
  const { offset, ...rest } = params;
  return offset === undefined ? rest : { ...rest, result_offset: offset };
}

export class QueryService {
  constructor(
    private readonly cbm: CbmClient,
    private readonly projects: ProjectService,
    private readonly output: OutputService,
    private readonly trace: TraceService,
  ) {}

  async executeQueryTool(
    title: string,
    toolName: string,
    params: Record<string, unknown>,
    ctx: ToolExecutionContext,
    needsProject = true,
  ) {
    const upstreamParams = stripOutputControls(params);
    const toolParams = toolName === "search_code" ? upstreamSearchCodeParams(upstreamParams) : upstreamParams;
    const args = needsProject ? await this.withProject(toolParams, ctx) : removeUndefined(toolParams);
    const project = typeof args.project === "string" ? args.project : "";
    // CLI-mode cbm indexes are not watched; re-index before impact analysis so an edit made moments ago is visible.
    const freshness = toolName === "detect_changes" && project ? await this.projects.ensureFreshIndex(project, ctx) : undefined;
    const result = await this.projects.withProjectError(project, ctx, () =>
      this.cbm.callTool(toolName, args, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) }),
    );
    const data = project && (toolName === "search_graph" || toolName === "get_architecture" || toolName === "detect_changes")
      ? await this.trace.enrichTraceLocations(result.data, project, params, ctx)
      : project && isRecord(result.data)
        ? await this.projects.relativizePaths(result.data, project, ctx.signal)
        : result.data;
    const outputData = freshness ? withIndexFreshness(data as CbmData, freshness) : data;
    return this.output.buildCompactableToolResult(title, outputData, params, { tool: toolName, args, stderr: result.stderr });
  }

  async queryGraph(params: Record<string, unknown>, ctx: ToolExecutionContext) {
    const args = await this.withProject(stripOutputControls({ max_rows: 200, ...params }), ctx);
    const result = await this.projects.withProjectError(String(args.project ?? ""), ctx, () =>
      this.cbm.callTool("query_graph", args, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) }),
    );
    return this.output.buildCompactableToolResult("Cypher query results", coerceQueryGraphMetrics(result.data as CbmData), params, {
      tool: "query_graph",
      args,
      stderr: result.stderr,
      numeric_metrics_normalized: true,
    });
  }

  private async withProject<T extends Record<string, unknown>>(params: T, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    return removeUndefined({ ...params, project: await this.projects.resolveProject(params.project, ctx.cwd, ctx.signal) });
  }
}
