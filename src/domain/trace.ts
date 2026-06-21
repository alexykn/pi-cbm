import { CbmClient } from "../cbm/client.js";
import { buildToolTextResult } from "../cbm/result.js";
import { queryTimeoutMs } from "../cbm/timeouts.js";
import { isRecord, removeUndefined, stringProp } from "../shared/object.js";
import { errorText, escapeRegExp } from "../shared/strings.js";
import { OutputService, stripOutputControls } from "./output.js";
import { ProjectService, type ToolExecutionContext } from "./project.js";
import { dedupeCandidates, hasLocation, searchCandidates, type SearchCandidate, SymbolService } from "./symbols.js";

function isFunctionNotFound(value: unknown): boolean {
  return errorText(value).toLowerCase().includes("function not found");
}

function tracePathFromItem(item: Record<string, unknown>): string {
  for (const key of ["file_path", "file", "path", "qualified_name"]) {
    if (typeof item[key] === "string") return item[key];
  }
  return "";
}

function filterTraceData(data: unknown, params: Record<string, unknown>): unknown {
  const excludePaths = Array.isArray(params.exclude_paths) ? params.exclude_paths.filter((item): item is string => typeof item === "string") : [];
  if (excludePaths.length === 0) return data;

  const shouldExclude = (item: Record<string, unknown>): boolean => {
    const path = tracePathFromItem(item);
    if (!path) return false;
    return excludePaths.some((excluded) => path.includes(excluded));
  };

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter((item) => !isRecord(item) || !shouldExclude(item)).map(visit);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
  };

  return visit(data);
}

function upstreamTraceParams(params: Record<string, unknown>): Record<string, unknown> {
  return stripOutputControls(removeUndefined({ ...params, exclude_paths: undefined }));
}

export class TraceService {
  constructor(
    private readonly cbm: CbmClient,
    private readonly projects: ProjectService,
    private readonly output: OutputService,
    private readonly symbols: SymbolService,
  ) {}

  async trace(params: Record<string, unknown>, ctx: ToolExecutionContext) {
    const args = await this.withProject(upstreamTraceParams(params), ctx);
    const project = String(args.project ?? "");
    const functionName = String(args.function_name ?? "");
    const result = await this.cbm.callTool("trace_path", args, {
      signal: ctx.signal,
      timeoutMs: queryTimeoutMs(params.timeout_ms),
      allowError: true,
    });

    if (result.ok) {
      const enriched = await this.enrichTraceLocations(filterTraceData(result.data, params), project, params, ctx);
      return this.output.buildCompactableToolResult("Trace path results", enriched, params, { tool: "trace_path", args, stderr: result.stderr });
    }
    if (!isFunctionNotFound(result.data) || !functionName || !project) throw new Error(errorText(result.data));

    const candidates = await this.findTraceCandidates(functionName, project, ctx);
    if (candidates.length === 1 && candidates[0]?.qualified_name) {
      const resolvedArgs = { ...args, function_name: candidates[0].qualified_name };
      const resolved = await this.cbm.callTool("trace_path", resolvedArgs, {
        signal: ctx.signal,
        timeoutMs: queryTimeoutMs(params.timeout_ms),
      });
      const enriched = await this.enrichTraceLocations(filterTraceData(resolved.data, params), project, params, ctx);
      return this.output.buildCompactableToolResult("Trace path results", enriched, params, {
        tool: "trace_path",
        args: resolvedArgs,
        resolved_from: functionName,
        stderr: `${result.stderr}${resolved.stderr}`,
      });
    }

    return buildToolTextResult(
      "Trace target candidates",
      {
        error: "function not found",
        hint:
          candidates.length > 1
            ? "Multiple possible trace targets found. Retry trace_path with one exact qualified_name."
            : "No matching Function/Method candidates found. Use search_graph to find the exact qualified_name.",
        function_name: functionName,
        candidates,
      },
      { tool: "trace_path", args, stderr: result.stderr },
    );
  }

  async enrichTraceLocations(data: unknown, project: string, params: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown> {
    let remaining = 50;

    const visit = async (value: unknown): Promise<unknown> => {
      if (Array.isArray(value)) return Promise.all(value.map(visit));
      if (!isRecord(value)) return value;

      let clone: Record<string, unknown> = { ...value };
      const qualifiedName = stringProp(clone, "qualified_name");
      if (qualifiedName && remaining > 0 && !hasLocation(clone as SearchCandidate)) {
        remaining -= 1;
        const enriched = await this.symbols.enrichCandidatesWithLocations([clone as SearchCandidate], project, ctx, params);
        clone = { ...clone, ...removeUndefined((enriched[0] ?? {}) as Record<string, unknown>) };
      }

      const entries = await Promise.all(Object.entries(clone).map(async ([key, entry]) => [key, await visit(entry)] as const));
      return Object.fromEntries(entries);
    };

    return visit(data);
  }

  private async withProject<T extends Record<string, unknown>>(params: T, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    if (typeof params.project === "string" && params.project.trim()) return removeUndefined(params);
    return removeUndefined({ ...params, project: await this.projects.inferProject(ctx.cwd, ctx.signal) });
  }

  private async findTraceCandidates(functionName: string, project: string, ctx: ToolExecutionContext): Promise<SearchCandidate[]> {
    const escapedName = escapeRegExp(functionName);
    const shortName = functionName.split(".").at(-1) ?? functionName;
    const escapedShortName = escapeRegExp(shortName);
    const searches = [
      { qn_pattern: `.*${escapedName}.*` },
      { name_pattern: `^${escapedShortName}$` },
      { name_pattern: `.*${escapedShortName}.*` },
    ];

    const candidates: SearchCandidate[] = [];
    for (const search of searches) {
      const result = await this.cbm.callTool(
        "search_graph",
        { project, limit: 10, ...search },
        { signal: ctx.signal, timeoutMs: queryTimeoutMs(undefined), allowError: true },
      );
      if (!result.ok) continue;
      const batch = dedupeCandidates(searchCandidates(result.data));
      if (batch.length === 1) return batch;
      candidates.push(...batch);
    }

    return dedupeCandidates(candidates).slice(0, 10);
  }
}
