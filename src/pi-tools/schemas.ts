import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const DIRECTION = StringEnum(["inbound", "outbound", "both"] as const);
export const TRACE_MODE = StringEnum(["calls", "data_flow", "cross_service"] as const);
export const SEARCH_CODE_MODE = StringEnum(["compact", "full", "files"] as const);
export const SYMBOL_LABEL = StringEnum(["Function", "Method", "Class", "Variable", "Type", "Route"] as const);
export const SYMBOL_NEIGHBORS = StringEnum(["none", "callers", "callees", "both"] as const);

export const OPTIONAL_PROJECT = Type.Optional(Type.String({ description: "Indexed project name. If omitted, inferred from the current working directory." }));
export const TIMEOUT_MS = Type.Optional(Type.Number({ description: "Timeout in milliseconds for this codebase-memory-mcp CLI call." }));
export const FULL_OUTPUT = Type.Optional(
  Type.Boolean({
    description:
      "Return complete per-symbol code/source blocks. Use this if a prior result was compacted and the full function/class is needed. Default false; global safety truncation may still apply.",
  }),
);
export const INCLUDE_METADATA = Type.Optional(
  Type.Boolean({
    description:
      "Include full upstream graph metrics, fingerprints, token fields, and raw metadata. Default false keeps output compact and location-first for context-efficient exploration.",
  }),
);
export const MAX_SYMBOL_LINES = Type.Optional(
  Type.Number({
    default: 220,
    description:
      "Maximum lines to include per returned function, method, class, or symbol-sized code block before compacting. Default 220. Ignored when full_output=true.",
  }),
);
export const OUTPUT_CONTROL_PARAMS = { full_output: FULL_OUTPUT, max_symbol_lines: MAX_SYMBOL_LINES };
export const EXPLORATION_OUTPUT_CONTROL_PARAMS = { include_metadata: INCLUDE_METADATA, ...OUTPUT_CONTROL_PARAMS };
export const METADATA_CONTROL_PARAMS = { include_metadata: INCLUDE_METADATA };
