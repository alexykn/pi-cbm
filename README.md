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

- `list_projects`
- `index_status`
- `index_repository`
- `get_graph_schema`
- `get_architecture`
- `search_graph`
- `search_code`
- `get_code_snippet`
- `trace_path`
- `query_graph`
- `detect_changes`
- `manage_adr`
- `ingest_traces`
- `delete_project`

Most tools accept optional `project`. When omitted, the extension infers it from indexed project roots matching Pi's current working directory. Agents should omit `project` for cwd/current-project work and provide it only when intentionally querying an external indexed project.

Notes:

- `index_repository` defaults to `mode: "full"`. The current cwd project is already auto-indexed at startup and periodically refreshed, so use this tool mainly for external repository paths or explicit manual refreshes.
- `trace_path` auto-resolves short function/method names when there is a single unambiguous match; otherwise it returns candidate `qualified_name`s. It also supports explicit plugin-side `exclude_paths` filters.
- Code/source-heavy tools support `full_output` and `max_symbol_lines`. By default, normal-sized symbols are returned in full and only oversized function/method/class-sized blocks are compacted.
- `search_code` defaults to compact output with small context to avoid flooding the agent context, and oversized per-symbol contexts are compacted unless `full_output=true` or `max_symbol_lines` is increased.
- `query_graph` normalizes common numeric metric columns in the returned rows for easier agent consumption, while still relying on upstream for query execution/order.
- `manage_adr(mode="store")` is accepted as a compatibility alias for `mode="update"`; ADR writes are allowed by default.
- `ingest_traces` is exposed for compatibility, but current `codebase-memory-mcp` versions may accept traces without creating runtime graph edges.

## Typical workflow

Ask Pi:

```text
Give me the architecture overview.
```

The extension indexes and periodically refreshes the current repo in the background, so the agent should usually go straight to `get_architecture`, `search_graph`, `get_code_snippet`, `trace_path`, `search_code`, or `query_graph` for structural code exploration. Ask it to call `index_repository` mainly for external folders or explicit manual refreshes.
