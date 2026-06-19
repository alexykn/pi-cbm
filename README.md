# pi-codebase-memory

Pi extension that exposes [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) as native Pi tools.

This package does not implement an MCP client. It uses `codebase-memory-mcp cli --json <tool> <args>` and registers the core tools directly with Pi. When a Pi session starts, it automatically indexes the current git root in full mode in the background, then periodically refreshes it so graph tools stay current.

## Requirements

Install `codebase-memory-mcp` first:

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
```

If the binary is not on `PATH`, set:

```sh
export CODEBASE_MEMORY_MCP_BIN=/Users/alxknt/.local/bin/codebase-memory-mcp
```

## Install

```sh
pi install /Users/alxknt/github/pi-codebase-memory
```

Or test for one run:

```sh
pi -e /Users/alxknt/github/pi-codebase-memory
```

## Tools

Registers:

- `get_graph_schema`
- `get_architecture`
- `search_graph`
- `resolve_symbol`
- `read_symbol`
- `search_code`
- `get_code_snippet`
- `trace_path`
- `query_graph`
- `detect_changes`

Most tools accept optional `project`. When omitted, the extension infers it from indexed project roots matching Pi's current working directory. Agents should omit `project` for cwd/current-project work and provide it only when intentionally querying an external indexed project.

Notes:

- Use `search_graph` first for symbol/workflow/route/class/function discovery and “where is X implemented?” questions. Use a small limit for targeted lookup.
- Use `resolve_symbol` when you know a symbol name but need the exact `qualified_name` or need to disambiguate candidates.
- Use `read_symbol` when you know a symbol name plus enough disambiguators, such as `file_path`, `parent_class`, `label`, `route_path`, or `route_method`, and want source only if the match is unambiguous.
- `read_symbol` fails closed on ambiguity; if it returns candidates, retry with more disambiguators or use `get_code_snippet` with an exact `qualified_name`.
- `read_symbol` supports `neighbors: "callers" | "callees" | "both"` plus `neighbor_limit` for direct, compact, source-free surrounding call context. Use `trace_path` for multi-hop workflow or impact tracing.
- Use `get_code_snippet` when you already have an exact `qualified_name`; prefer `read_symbol` when you have a concrete symbol name plus disambiguators but not the exact `qualified_name`.
- If the query is a symbol name, prefer `resolve_symbol`/`read_symbol`; if it is an exact non-symbol string or you need all textual occurrences, use `search_code`.
- Use `search_code` for exact literal text/regex searches such as env vars, config keys, route strings, error messages, constants, template text, comments, and docstrings.
- Use `trace_path` after identifying an anchor symbol when you need callers, callees, workflow, dependency, data-flow, or blast-radius context. Keep depth shallow by default.
- Use `get_code_snippet` only after `search_graph`/`search_code` identifies the exact symbol. Keep snippet retrieval targeted instead of bulk-reading many symbols.
- Use `get_architecture` for broad orientation in unfamiliar repos, not targeted implementation lookup. Requested aspects may be absent if the index has no data for them.
- Use `get_graph_schema` before non-trivial `query_graph` queries, and keep `query_graph` returned columns narrow.
- Use `detect_changes` for diff review or blast-radius analysis, not ordinary code lookup.
- Read obvious README/package/deployment/config manifest paths directly instead of forcing graph tools into file-inspection work.
- `trace_path` auto-resolves short function/method names when there is a single unambiguous match; otherwise it returns candidate `qualified_name`s. It also supports explicit plugin-side `exclude_paths` filters.
- Exploration tools such as `search_graph`, `get_code_snippet`, `trace_path`, `get_architecture`, `search_code`, and `detect_changes` default to compact, location-first output. Less-useful upstream graph metadata such as fingerprints, token fields, and raw metrics is hidden unless `include_metadata: true` is set.
- Compact output hides analysis metadata, not edit-critical location identity. Symbol-like outputs preserve `file_path`, `start_line`, and `end_line` when available, and the plugin enriches missing locations for resolver, trace, and architecture outputs where possible.
- Code/source-heavy tools support `full_output` and `max_symbol_lines`. By default, normal-sized symbols are returned in full and only oversized function/method/class-sized blocks are compacted.
- `search_code` defaults to compact output with small context to avoid flooding the agent context, and oversized per-symbol contexts are compacted unless `full_output=true` or `max_symbol_lines` is increased. If a result is compacted/truncated, agents should retry the same codebase-memory tool with a higher `max_symbol_lines` or `full_output=true` before falling back to file reads/grep.
- `query_graph` normalizes common numeric metric columns in the returned rows for easier agent consumption, while still relying on upstream for query execution/order.

## Typical workflow

Ask Pi:

```text
Give me the architecture overview.
```

The extension indexes and periodically refreshes the current repo in the background, so the agent should usually go straight to `get_architecture`, `search_graph`, `get_code_snippet`, `trace_path`, `search_code`, or `query_graph` for structural code exploration. Administrative index operations remain available through the `codebase-memory-mcp` CLI when needed.
