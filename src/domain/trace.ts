import { CbmClient } from "../cbm/client.js";
import type { CbmData } from "../cbm/normalize.js";
import { buildToolTextResult } from "../cbm/result.js";
import { queryTimeoutMs } from "../cbm/timeouts.js";
import { mapLimit } from "../shared/concurrency.js";
import { isRecord, removeUndefined, stringProp } from "../shared/object.js";
import { errorText, escapeRegExp } from "../shared/strings.js";
import { OutputService, stripOutputControls } from "./output.js";
import { ProjectService, type ToolExecutionContext } from "./project.js";
import { dedupeCandidates, hasLocation, searchCandidates, type SearchCandidate, SymbolService } from "./symbols.js";

const ENRICH_CONCURRENCY = 8;
const ENRICH_BUDGET = 50;

function isFunctionNotFound(value: unknown): boolean {
  return errorText(value).toLowerCase().includes("function not found");
}

function tracePathFromItem(item: Record<string, unknown>): string {
  for (const key of ["file_path", "file", "path", "qualified_name"]) {
    if (typeof item[key] === "string") return item[key];
  }
  return "";
}

function filterTraceData(data: CbmData, params: Record<string, unknown>): CbmData {
  const excludePaths = Array.isArray(params.exclude_paths) ? params.exclude_paths.filter((item): item is string => typeof item === "string") : [];
  if (excludePaths.length === 0) return data;

  const shouldExclude = (item: Record<string, unknown>): boolean => {
    const path = tracePathFromItem(item);
    if (!path) return false;
    return excludePaths.some((excluded) => path.includes(excluded));
  };

  const visit = (value: CbmData): CbmData => {
    if (Array.isArray(value)) return value.filter((item) => !isRecord(item) || !shouldExclude(item)).map(visit);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry as CbmData)]));
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
      // Enrich before filtering: 0.12 trace rows carry no file_path, so
      // exclude_paths can only match once locations are filled in.
      const enriched = filterTraceData(await this.enrichTraceLocations(result.data, project, params, ctx), params);
      return this.output.buildCompactableToolResult("Trace path results", enriched, params, { tool: "trace_path", args, stderr: result.stderr });
    }
    if (!isFunctionNotFound(result.data) || !functionName || !project) throw await this.projects.projectLookupError(result.data, project, ctx.cwd, ctx.signal);

    const candidates = await this.findTraceCandidates(functionName, project, ctx);
    if (candidates.length === 1 && candidates[0]?.qualified_name) {
      const resolvedArgs = { ...args, function_name: candidates[0].qualified_name };
      const resolved = await this.cbm.callTool("trace_path", resolvedArgs, {
        signal: ctx.signal,
        timeoutMs: queryTimeoutMs(params.timeout_ms),
      });
      const enriched = filterTraceData(await this.enrichTraceLocations(resolved.data, project, params, ctx), params);
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

  async enrichTraceLocations(data: unknown, project: string, params: Record<string, unknown>, ctx: ToolExecutionContext): Promise<CbmData> {
    const cache = new Map<string, Promise<Partial<SearchCandidate>>>();
    const pending = new Map<string, SearchCandidate>();

    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) collect(item);
        return;
      }
      if (!isRecord(value)) return;
      const qualifiedName = stringProp(value, "qualified_name");
      if (qualifiedName && !pending.has(qualifiedName) && !hasLocation(value as SearchCandidate)) {
        pending.set(qualifiedName, value as SearchCandidate);
      }
      for (const entry of Object.values(value)) collect(entry);
    };
    collect(data);

    const names = [...pending.keys()].slice(0, ENRICH_BUDGET);
    const resolved = await mapLimit(names, ENRICH_CONCURRENCY, async (name) => {
      const [candidate] = await this.symbols.enrichCandidatesWithLocations([pending.get(name)!], project, ctx, params, cache);
      return [name, removeUndefined((candidate ?? {}) as Record<string, unknown>)] as const;
    });
    const locations = new Map(resolved);

    const apply = (value: CbmData): CbmData => {
      if (Array.isArray(value)) return value.map(apply);
      if (!isRecord(value)) return value;
      const qualifiedName = stringProp(value, "qualified_name");
      const location = qualifiedName ? locations.get(qualifiedName) : undefined;
      const clone: Record<string, unknown> = { ...value, ...(location ?? {}) };
      for (const [key, entry] of Object.entries(clone)) clone[key] = apply(entry as CbmData);
      return clone;
    };

    const enriched = apply(data as CbmData);
    const unlocated = pending.size - names.length;
    if (unlocated > 0 && isRecord(enriched)) {
      return {
        ...enriched,
        location_enrichment: {
          located: names.length,
          unlocated,
          hint: "Too many nodes to locate every one; unlocated nodes are matched by qualified_name only, so exclude_paths may miss them.",
        },
      };
    }
    return enriched;
  }

  private async withProject<T extends Record<string, unknown>>(params: T, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    return removeUndefined({ ...params, project: await this.projects.resolveProject(params.project, ctx.cwd, ctx.signal) });
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
    const failures: unknown[] = [];
    for (const search of searches) {
      const result = await this.cbm.callTool(
        "search_graph",
        { project, limit: 10, ...search },
        { signal: ctx.signal, timeoutMs: queryTimeoutMs(undefined), allowError: true },
      );
      if (!result.ok) {
        failures.push(result.data);
        continue;
      }
      const batch = dedupeCandidates(searchCandidates(result.data));
      if (batch.length === 1) return batch;
      candidates.push(...batch);
    }

    if (candidates.length === 0 && failures.length === searches.length) throw await this.projects.projectLookupError(failures[0], project, ctx.cwd, ctx.signal);
    return dedupeCandidates(candidates).slice(0, 10);
  }
}
