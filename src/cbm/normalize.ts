import { isRecord } from "../shared/object.js";

type Json = Record<string, unknown>;

export type CbmData = Json | CbmData[] | string | number | boolean | null | undefined;

const COLUMN_ALIASES: Record<string, string> = {
  qn: "qualified_name",
  file: "file_path",
  in: "in_degree",
  out: "out_degree",
  matches: "match_lines",
};

/**
 * cbm 0.12 returns compact `{cols, rows}` / `{qn_rule, cols, groups}` tables.
 * Turn them into the object arrays earlier pi-cbm consumers expect, leaving
 * 0.9-style JSON and `query_graph`'s `{columns, rows}` untouched.
 */
export function normalizeCbmData(data: unknown): CbmData {
  return normalizeValue(data);
}

function normalizeValue(value: unknown): CbmData {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (!isRecord(value)) return value as CbmData;

  if (isPagedGroupsTable(value)) return normalizePagedGroups(value);
  if (isPagedRowsTable(value)) return normalizePagedRows(value);
  if (isGroupsTable(value)) return expandGroups(value);
  if (isRowsTable(value)) return expandRows(value);

  const result: Json = {};
  for (const [key, entry] of Object.entries(value)) result[key] = normalizeValue(entry);
  return result;
}

function isGroupsTable(value: Json): boolean {
  return Array.isArray(value.cols) && Array.isArray(value.groups);
}

function isPagedGroupsTable(value: Json): boolean {
  return isGroupsTable(value) && !Array.isArray(value.rows) && ("total" in value || "has_more" in value);
}

function isRowsTable(value: Json): boolean {
  return Array.isArray(value.cols) && Array.isArray(value.rows);
}

// A table with sibling paging/meta keys is promoted to `results` so those keys survive;
// a bare `{cols, rows}` table (node_labels, raw_matches, ...) collapses to an array.
function isPagedRowsTable(value: Json): boolean {
  return isRowsTable(value) && Object.keys(value).some((key) => key !== "cols" && key !== "rows");
}

function normalizePagedRows(value: Json): Json {
  const result: Json = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "cols" || key === "rows") continue;
    result[key] = normalizeValue(entry);
  }
  result.results = expandRows(value);
  return result;
}

function normalizePagedGroups(value: Json): Json {
  const results = expandGroups(value);
  const result: Json = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "cols" || key === "groups") continue;
    result[key] = normalizeValue(entry);
  }
  result.results = results;
  return result;
}

function expandGroups(value: Json): Json[] {
  const columns = value.cols as unknown[];
  const groups = value.groups as unknown[];
  const result: Json[] = [];

  for (const group of groups) {
    if (!isRecord(group)) continue;
    const prefix = typeof group.qn_prefix === "string" ? group.qn_prefix : "";
    const groupFile = typeof group.file === "string" ? group.file : undefined;
    const rows = Array.isArray(group.rows) ? group.rows : [];
    for (const row of rows) {
      const item = rowToObject(columns, row);
      const name = typeof item.name === "string" ? item.name : "";
      item.qualified_name = prefix === "" ? name : `${prefix}.${name}`;
      if (groupFile !== undefined && item.file_path === undefined) item.file_path = groupFile;
      result.push(applyAliases(item));
    }
  }

  return result;
}

function expandRows(value: Json): Json[] {
  const columns = value.cols as unknown[];
  const rows = value.rows as unknown[];
  return rows.map((row) => applyAliases(rowToObject(columns, row)));
}

function rowToObject(columns: unknown[], row: unknown): Json {
  const item: Json = {};
  columns.forEach((column, index) => {
    const key = typeof column === "string" ? column : String(column);
    item[key] = Array.isArray(row) ? row[index] : undefined;
  });
  return item;
}

function applyAliases(item: Json): Json {
  for (const [from, to] of Object.entries(COLUMN_ALIASES)) {
    if (item[to] === undefined && item[from] != null) item[to] = item[from];
  }
  if (typeof item.lines === "string") {
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(item.lines.trim());
    if (match) {
      if (typeof item.start_line !== "number") item.start_line = Number(match[1]);
      if (typeof item.end_line !== "number") item.end_line = Number(match[2]);
    }
  }
  return item;
}
