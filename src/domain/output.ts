import { buildToolTextResult, saveJsonResult } from "../cbm/result.js";
import { clampInt } from "../shared/numbers.js";
import { isRecord, pickDefined, removeUndefined } from "../shared/object.js";

const DEFAULT_MAX_SYMBOL_LINES = 220;
const MIN_MAX_SYMBOL_LINES = 40;
const MAX_MAX_SYMBOL_LINES = 2_000;
const COMPACTIBLE_CODE_KEYS = new Set(["context", "source", "code", "snippet", "source_code", "code_snippet", "raw_source"]);

type OutputControls = {
  fullOutput: boolean;
  includeMetadata: boolean;
  maxSymbolLines: number;
};

type CompactedBlock = {
  text: string;
  originalLines: number;
  shownLines: number;
  strategy: "match_lines" | "head_tail";
};

type CompactionResult = {
  data: unknown;
  compacted: boolean;
};



function outputControls(params: Record<string, unknown>): OutputControls {
  return {
    fullOutput: params.full_output === true,
    includeMetadata: params.include_metadata === true,
    maxSymbolLines: clampInt(params.max_symbol_lines, DEFAULT_MAX_SYMBOL_LINES, MIN_MAX_SYMBOL_LINES, MAX_MAX_SYMBOL_LINES),
  };
}

export function stripOutputControls<T extends Record<string, unknown>>(params: T): Record<string, unknown> {
  return removeUndefined({ ...params, include_metadata: undefined, full_output: undefined, max_symbol_lines: undefined });
}

function isCompactibleCodeKey(key: string): boolean {
  return COMPACTIBLE_CODE_KEYS.has(key.toLowerCase());
}

function getMatchLines(container: Record<string, unknown>): number[] {
  if (!Array.isArray(container.match_lines)) return [];
  return container.match_lines.filter((line): line is number => typeof line === "number" && Number.isFinite(line));
}

function getStartLine(container: Record<string, unknown>): number | undefined {
  if (typeof container.start_line === "number" && Number.isFinite(container.start_line)) return container.start_line;
  if (typeof container.line === "number" && Number.isFinite(container.line)) return container.line;
  return undefined;
}

function rangesFromSelectedIndexes(indexes: number[]): Array<[number, number]> {
  if (indexes.length === 0) return [];
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let start = sorted[0]!;
  let end = sorted[0]!;

  for (const index of sorted.slice(1)) {
    if (index === end + 1) {
      end = index;
      continue;
    }
    ranges.push([start, end]);
    start = index;
    end = index;
  }
  ranges.push([start, end]);
  return ranges;
}

function renderRanges(lines: string[], ranges: Array<[number, number]>): { text: string; shownLines: number } {
  const output: string[] = [];
  let previousEnd = -1;

  for (const [start, end] of ranges) {
    const omitted = start - previousEnd - 1;
    if (omitted > 0) output.push(`[... omitted ${omitted} line${omitted === 1 ? "" : "s"} ...]`);
    output.push(...lines.slice(start, end + 1));
    previousEnd = end;
  }

  const trailing = lines.length - previousEnd - 1;
  if (trailing > 0) output.push(`[... omitted ${trailing} line${trailing === 1 ? "" : "s"} ...]`);

  return { text: output.join("\n"), shownLines: output.length };
}

function compactByMatches(lines: string[], container: Record<string, unknown>, maxLines: number): CompactedBlock | undefined {
  const startLine = getStartLine(container);
  const matchLines = getMatchLines(container);
  if (startLine === undefined || matchLines.length === 0) return undefined;

  const selected = new Set<number>();
  const radius = 4;
  for (const matchLine of matchLines) {
    const index = matchLine - startLine;
    if (index < 0 || index >= lines.length) continue;
    for (let selectedIndex = Math.max(0, index - radius); selectedIndex <= Math.min(lines.length - 1, index + radius); selectedIndex++) {
      selected.add(selectedIndex);
    }
    if (selected.size >= maxLines) break;
  }

  if (selected.size === 0) return undefined;
  const prioritized = [...selected];
  let selectedLineCount = Math.min(prioritized.length, maxLines);
  let rendered = renderRanges(lines, rangesFromSelectedIndexes(prioritized.slice(0, selectedLineCount)));

  while (rendered.shownLines > maxLines && selectedLineCount > 1) {
    selectedLineCount = Math.max(1, selectedLineCount - (rendered.shownLines - maxLines));
    rendered = renderRanges(lines, rangesFromSelectedIndexes(prioritized.slice(0, selectedLineCount)));
  }

  return { text: rendered.text, originalLines: lines.length, shownLines: rendered.shownLines, strategy: "match_lines" };
}

function compactHeadTail(lines: string[], maxLines: number): CompactedBlock {
  const markerLines = 1;
  const sourceLineBudget = Math.max(2, maxLines - markerLines);
  const headLines = Math.max(1, Math.ceil(sourceLineBudget * 0.6));
  const tailLines = Math.max(1, sourceLineBudget - headLines);
  const omitted = Math.max(0, lines.length - headLines - tailLines);
  const output = [...lines.slice(0, headLines), `[... omitted ${omitted} line${omitted === 1 ? "" : "s"} ...]`, ...lines.slice(lines.length - tailLines)];
  return { text: output.join("\n"), originalLines: lines.length, shownLines: output.length, strategy: "head_tail" };
}

function compactCodeBlock(value: string, container: Record<string, unknown>, controls: OutputControls): CompactedBlock | undefined {
  if (controls.fullOutput) return undefined;
  const lines = value.split(/\r?\n/);
  if (lines.length <= controls.maxSymbolLines) return undefined;
  return compactByMatches(lines, container, controls.maxSymbolLines) ?? compactHeadTail(lines, controls.maxSymbolLines);
}

function compactSymbolBlocks(value: unknown, controls: OutputControls): CompactionResult {
  let compacted = false;

  const visit = (entry: unknown, container: Record<string, unknown> | undefined, key: string | undefined): unknown => {
    if (typeof entry === "string" && container && key && isCompactibleCodeKey(key)) {
      const block = compactCodeBlock(entry, container, controls);
      if (!block) return entry;
      compacted = true;
      container[`${key}_compacted`] = true;
      container[`${key}_original_lines`] = block.originalLines;
      container[`${key}_shown_lines`] = block.shownLines;
      container[`${key}_compaction_strategy`] = block.strategy;
      container[`${key}_hint`] = "Increase max_symbol_lines or set full_output=true to include the complete block.";
      return block.text;
    }

    if (Array.isArray(entry)) return entry.map((item) => visit(item, undefined, undefined));
    if (!isRecord(entry)) return entry;

    if (Array.isArray(entry.columns) && Array.isArray(entry.rows)) {
      const columns = entry.columns.map((column) => (typeof column === "string" ? column : ""));
      const compactibleIndexes = columns
        .map((column, index) => ({ column, index }))
        .filter(({ column }) => isCompactibleCodeKey(column));

      if (compactibleIndexes.length > 0) {
        const cellCompactions: Array<Record<string, unknown>> = [];
        const rows = entry.rows.map((row, rowIndex) => {
          if (!Array.isArray(row)) return row;
          const rowContainer = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
          const nextRow = [...row];

          for (const { column, index } of compactibleIndexes) {
            const cell = nextRow[index];
            if (typeof cell !== "string") continue;
            const block = compactCodeBlock(cell, rowContainer, controls);
            if (!block) continue;
            compacted = true;
            nextRow[index] = block.text;
            cellCompactions.push({ row: rowIndex, column, original_lines: block.originalLines, shown_lines: block.shownLines, strategy: block.strategy });
          }

          return nextRow;
        });

        if (cellCompactions.length > 0) {
          return {
            ...entry,
            rows,
            _symbol_compactions: cellCompactions,
            _symbol_compaction_hint: "Increase max_symbol_lines or set full_output=true to include complete code blocks.",
          };
        }
      }
    }

    const clone: Record<string, unknown> = { ...entry };
    for (const [childKey, childValue] of Object.entries(clone)) {
      clone[childKey] = visit(childValue, clone, childKey);
    }
    return clone;
  };

  return { data: visit(value, undefined, undefined), compacted };
}

type MetadataProjection = {
  data: unknown;
  pruned: boolean;
};

function firstDocLine(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line;
}


function compactSymbolLike(item: unknown, options: { includeSource?: boolean; includeMatches?: boolean } = {}): unknown {
  if (!isRecord(item)) return item;
  const compact = pickDefined(item, [
    "name",
    "qualified_name",
    "label",
    "kind",
    "type",
    "file_path",
    "file",
    "path",
    "start_line",
    "end_line",
    "line",
    "parent_class",
    "signature",
    "return_type",
    "route_method",
    "route_path",
    "http_method",
    "method",
    "path_pattern",
    "hop",
    "relationship",
    "edge_type",
    "risk",
  ]);

  const doc = firstDocLine(item.docstring ?? item.summary ?? item.description);
  if (doc !== undefined) compact.summary = doc;

  if (options.includeMatches) {
    Object.assign(compact, pickDefined(item, ["match_lines", "total_matches", "match_count", "total_grep_matches", "dedup_ratio"]));
  }

  if (options.includeSource) {
    Object.assign(compact, pickDefined(item, ["source", "context", "code", "snippet", "source_code", "code_snippet", "raw_source"]));
  }

  return compact;
}

function compactSymbolArray(value: unknown, options: { includeSource?: boolean; includeMatches?: boolean } = {}): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => compactSymbolLike(item, options));
}

function compactTraceItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  const compact = compactSymbolLike(item);
  if (!isRecord(compact)) return compact;
  Object.assign(compact, pickDefined(item, ["from", "to", "target", "operation", "duration_ms", "latency_ms", "count"]));

  const source = item.source;
  if (typeof source === "string" && !source.includes("\n")) compact.source = source;

  return compact;
}

function compactTraceArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(compactTraceItem);
}

function appendMetadataHint(data: unknown): unknown {
  const hint = "Compact result: less-useful graph metadata is hidden. Rerun with include_metadata=true for full upstream metrics/raw fields.";
  if (isRecord(data) && data._metadata_hint === undefined) return { ...data, _metadata_hint: hint };
  return data;
}

function compactSearchGraphData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, ["project", "query", "label", "total", "has_more", "limit", "offset"]);
  if (Array.isArray(data.results)) compact.results = compactSymbolArray(data.results);
  if (Array.isArray(data.semantic_results)) compact.semantic_results = compactSymbolArray(data.semantic_results);
  if (Array.isArray(data.connected)) compact.connected = compactSymbolArray(data.connected);
  if (Array.isArray(data.candidates)) compact.candidates = compactSymbolArray(data.candidates);
  return { data: appendMetadataHint(compact), pruned: true };
}

function compactCodeSnippetData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = compactSymbolLike(data, { includeSource: true });
  if (!isRecord(compact)) return { data, pruned: false };
  Object.assign(compact, pickDefined(data, ["callers", "callees", "caller_names", "callee_names", "route_method", "route_path"]));
  if (Array.isArray(data.callers)) compact.callers = compactSymbolArray(data.callers);
  if (Array.isArray(data.callees)) compact.callees = compactSymbolArray(data.callees);
  return { data: appendMetadataHint(compact), pruned: true };
}

function compactReadSymbolData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  if (data.ambiguous || data.error) return { data, pruned: false };
  const snippet = compactCodeSnippetData(data);
  if (!isRecord(snippet.data)) return snippet;
  return { data: { resolved: data.resolved, ...snippet.data }, pruned: snippet.pruned };
}

function compactBatchSourceResult(item: unknown): unknown {
  if (!isRecord(item)) return item;
  const compact = pickDefined(item, [
    "index",
    "rank",
    "status",
    "request",
    "qualified_name",
    "query",
    "considered_candidates",
    "error",
    "hint",
  ]);

  if (isRecord(item.resolved)) compact.resolved = compactSymbolLike(item.resolved);
  if (isRecord(item.search_result)) compact.search_result = compactSymbolLike(item.search_result);
  if (Array.isArray(item.candidates)) compact.candidates = compactSymbolArray(item.candidates);

  if (isRecord(item.snippet)) {
    compact.snippet = compactCodeSnippetData(item.snippet).data;
  } else if (item.snippet !== undefined) {
    compact.snippet = item.snippet;
  }

  return compact;
}

function compactBatchSourceData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, [
    "project",
    "requested_count",
    "returned_count",
    "read_count",
    "ok_count",
    "ambiguous_count",
    "not_found_count",
    "failed_count",
    "error_count",
    "max_concurrency",
    "search",
  ]);

  if (Array.isArray(data.results)) compact.results = data.results.map(compactBatchSourceResult);
  if (Array.isArray(data.unread_candidates)) compact.unread_candidates = compactSymbolArray(data.unread_candidates);
  return { data: appendMetadataHint(compact), pruned: true };
}

function compactTraceDataForOutput(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, ["function", "resolved_function", "direction", "mode", "parameter_name", "depth"]);
  for (const key of ["callers", "callees", "paths", "nodes", "edges", "data_flow", "cross_service_paths"]) {
    const value = data[key];
    compact[key] = Array.isArray(value) ? compactTraceArray(value) : value;
  }
  return { data: appendMetadataHint(removeUndefined(compact)), pruned: true };
}

function compactSearchCodeData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, [
    "pattern",
    "files",
    "directories",
    "total_grep_matches",
    "total_results",
    "raw_match_count",
    "dedup_ratio",
    "has_more",
    "limit",
    "offset",
  ]);
  if (Array.isArray(data.results)) compact.results = compactSymbolArray(data.results, { includeSource: true, includeMatches: true });
  return { data: appendMetadataHint(compact), pruned: true };
}

function compactArchitectureEntry(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return pickDefined(value, [
    "name",
    "qualified_name",
    "label",
    "kind",
    "file_path",
    "file",
    "path",
    "start_line",
    "end_line",
    "route_method",
    "route_path",
    "fan_in",
    "fan_out",
    "call_count",
    "from",
    "to",
    "layer",
    "reason",
    "language",
    "count",
  ]);
}

function compactArchitectureData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, [
    "project",
    "total_nodes",
    "total_edges",
    "languages",
    "packages",
    "modules",
    "entry_points",
    "hotspots",
    "routes",
    "boundaries",
    "layers",
    "dependencies",
  ]);

  for (const [key, value] of Object.entries(compact)) {
    if (Array.isArray(value)) compact[key] = value.map(compactArchitectureEntry);
  }

  return { data: appendMetadataHint(compact), pruned: true };
}

function compactDetectChangesData(data: unknown): MetadataProjection {
  if (!isRecord(data)) return { data, pruned: false };
  const compact = pickDefined(data, ["changed_files", "changed_count", "depth", "risk", "summary"]);
  if (Array.isArray(data.impacted_symbols)) compact.impacted_symbols = compactSymbolArray(data.impacted_symbols);
  if (Array.isArray(data.impacts)) compact.impacts = compactSymbolArray(data.impacts);
  return { data: appendMetadataHint(compact), pruned: true };
}

function projectMetadata(toolName: string, data: unknown, controls: OutputControls): MetadataProjection {
  if (controls.includeMetadata) return { data, pruned: false };

  switch (toolName) {
    case "search_graph":
      return compactSearchGraphData(data);
    case "get_code_snippet":
      return compactCodeSnippetData(data);
    case "get_code_snippets":
    case "read_symbols":
    case "search_and_read_symbols":
      return compactBatchSourceData(data);
    case "read_symbol":
      return compactReadSymbolData(data);
    case "trace_path":
      return compactTraceDataForOutput(data);
    case "search_code":
      return compactSearchCodeData(data);
    case "get_architecture":
      return compactArchitectureData(data);
    case "detect_changes":
      return compactDetectChangesData(data);
    default:
      return { data, pruned: false };
  }
}

async function buildCompactableToolResult(
  title: string,
  data: unknown,
  params: Record<string, unknown>,
  details: Record<string, unknown>,
) {
  const controls = outputControls(params);
  const toolName = typeof details.tool === "string" ? details.tool : "";
  const projected = projectMetadata(toolName, data, controls);
  const compaction = compactSymbolBlocks(projected.data, controls);
  const resultDetails: Record<string, unknown> = {
    ...details,
    full_output: controls.fullOutput,
    include_metadata: controls.includeMetadata,
    max_symbol_lines: controls.maxSymbolLines,
  };

  if (projected.pruned) {
    resultDetails.metadataPruned = true;
    resultDetails.metadataHint = "Rerun with include_metadata=true for full upstream graph metrics/raw fields.";
  }

  if (compaction.compacted) {
    resultDetails.uncompactedOutputPath = await saveJsonResult(data, "result.uncompacted.json");
    resultDetails.symbolCompaction = {
      max_symbol_lines: controls.maxSymbolLines,
      hint: "Increase max_symbol_lines or set full_output=true to include complete code blocks.",
    };
  }

  return buildToolTextResult(title, compaction.data, resultDetails);
}

export class OutputService {
  buildCompactableToolResult(
    title: string,
    data: unknown,
    params: Record<string, unknown>,
    details: Record<string, unknown>,
  ) {
    return buildCompactableToolResult(title, data, params, details);
  }
}
