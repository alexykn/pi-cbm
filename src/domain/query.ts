import { CbmClient } from "../cbm/client.js";
import { queryTimeoutMs } from "../cbm/timeouts.js";
import { isRecord, removeUndefined } from "../shared/object.js";
import { OutputService, stripOutputControls } from "./output.js";
import { ProjectService, type ToolExecutionContext } from "./project.js";
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

function coerceQueryGraphMetrics(data: unknown): unknown {
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
    const args = needsProject ? await this.withProject(upstreamParams, ctx) : removeUndefined(upstreamParams);
    const result = await this.cbm.callTool(toolName, args, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) });
    const project = typeof args.project === "string" ? args.project : "";
    const data = project && (toolName === "search_graph" || toolName === "get_architecture" || toolName === "detect_changes")
      ? await this.trace.enrichTraceLocations(result.data, project, params, ctx)
      : result.data;
    return this.output.buildCompactableToolResult(title, data, params, { tool: toolName, args, stderr: result.stderr });
  }

  async queryGraph(params: Record<string, unknown>, ctx: ToolExecutionContext) {
    const args = await this.withProject(stripOutputControls({ max_rows: 200, ...params }), ctx);
    const result = await this.cbm.callTool("query_graph", args, { signal: ctx.signal, timeoutMs: queryTimeoutMs(params.timeout_ms) });
    return this.output.buildCompactableToolResult("Cypher query results", coerceQueryGraphMetrics(result.data), params, {
      tool: "query_graph",
      args,
      stderr: result.stderr,
      numeric_metrics_normalized: true,
    });
  }

  private async withProject<T extends Record<string, unknown>>(params: T, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    if (typeof params.project === "string" && params.project.trim()) return removeUndefined(params);
    return removeUndefined({ ...params, project: await this.projects.inferProject(ctx.cwd, ctx.signal) });
  }
}
