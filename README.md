# pi-cbm

Pi extension that exposes [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) as native Pi tools. `codebase-memory-mcp provides a fast local code graph. pi-cbm adds auto-indexing and adapts it for Pi agents in a way that is deliberately optimized for agent workflows and token saving.

This package does not implement an MCP client. It uses `codebase-memory-mcp cli --json <tool> <args>` and registers the core tools directly with Pi. When a Pi session starts, it automatically indexes the current git root, or a safe non-git working directory when enabled, in full mode in the background, then periodically refreshes it so graph tools stay current.

## What makes this different

- **Token-saving output by default.** Several upstream tools return rich graph metadata, fingerprints, scores, and raw analysis fields. `pi-cbm` strips less-useful metadata by default and returns compact, location-first results. Use `include_metadata: true` when you need the full upstream payload.
- **Source compaction controls.** Tools that may return code support `full_output` and `max_symbol_lines`. Normal-sized symbols are returned directly; oversized code blocks are compacted and the full uncompacted JSON is saved to a temp file.
- **Symbol-first helpers.** Upstream `get_code_snippet` works best when you already know the exact `qualified_name`. `pi-cbm` adds `resolve_symbol` and `read_symbol` so the agent can start from a normal symbol name, disambiguate with file/class/route filters, and only read source when the match is unambiguous.
- **Safe-by-default symbol reading.** `read_symbol` fails closed on ambiguity: it returns candidate identities instead of guessing and reading the wrong source. When exactly one symbol matches, it calls upstream `get_code_snippet` and can optionally include compact direct callers/callees.
- **Batch source-reading workflows.** `get_code_snippets`, `read_symbols`, and `search_and_read_symbols` let agents inspect several relevant symbols in one tool call instead of looping through many single-symbol calls. These batch tools keep the same compact metadata defaults while preserving essential locations, per-item ambiguity/error results, and source compaction controls.
- **Current project stays indexed.** On Pi session start, the extension indexes the current git root, or a safe non-git working directory when explicitly enabled, in full mode and refreshes it periodically in the background. A cross-process per-repository lease prevents duplicate indexers for one repository, while a configurable global token queue limits indexing across repositories (`PI_CBM_MAX_CONCURRENT_INDEXES`, default `1`). Root, home, system, and common builtin OS directories are never auto-indexed.
- **Project inference for cwd workflows.** Most tools accept optional `project`, but for normal current-repo work the extension infers the indexed project from Pi's current working directory.
- **Query tools only.** The agent gets code-exploration tools, not administrative controls. `index_repository` and `list_projects` are used internally for background indexing and project inference; destructive/admin MCP tools such as project deletion are not registered as Pi tools.

## Security

Pi extensions run with your local user permissions. This extension also shells out to the `codebase-memory-mcp` binary installed on your machine, so install both this package and `codebase-memory-mcp` only from sources you trust.

## Requirements: install codebase-memory-mcp

Install [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) first. These are the upstream recommended install paths.

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
```

With the optional graph visualization UI:

```sh
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --ui
```

### Windows PowerShell

```powershell
# 1. Download the installer
Invoke-WebRequest -Uri https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1

# 2. Optional but recommended: inspect the script
notepad install.ps1

# 3. Run it
.\install.ps1
```

Useful installer options from upstream:

- `--ui` — install the graph visualization variant.
- `--skip-config` — install the binary only, without configuring other agents.
- `--dir=<path>` — install to a custom location.

### Arch Linux AUR

```sh
yay -S codebase-memory-mcp-bin
```

or:

```sh
paru -S codebase-memory-mcp-bin
```

### Manual release archive

Download the archive for your platform from the [latest codebase-memory-mcp release](https://github.com/DeusData/codebase-memory-mcp/releases/latest):

- `codebase-memory-mcp-<platform>-<arch>.tar.gz` for macOS/Linux.
- `codebase-memory-mcp-windows-amd64.zip` for Windows.
- `codebase-memory-mcp-ui-...` variants include the graph visualization UI.

Then extract and run the included installer:

```sh
tar xzf codebase-memory-mcp-*.tar.gz
./install.sh
```

Windows PowerShell:

```powershell
Expand-Archive codebase-memory-mcp-windows-amd64.zip -DestinationPath .
.\install.ps1
```

If the binary is not on `PATH`, set:

```sh
export CODEBASE_MEMORY_MCP_BIN="$HOME/.local/bin/codebase-memory-mcp"
```

### Supported versions

This extension requires `codebase-memory-mcp` >= 0.12 and targets the 0.12.x CLI contract (`>=0.12.0 <0.13.0`). Captured/tested versions are 0.12.1 (target) and 0.9.0 (old-shape baseline); 0.10.x and 0.11.x were not tested, and the version gate rejects them conservatively. The 0.9.0 fixtures confirm the older shapes differ (`search_graph` object arrays instead of `cols`/`rows` groups, JSON-only `list_projects`), which this client does not parse; a version with those shapes cannot return useful results.

On startup the extension probes the binary and fails loudly on an unsupported version instead of silently returning empty results:

```text
codebase-memory-mcp 0.10.0 is unsupported; pi-cbm requires 0.12.x (>=0.12.0 <0.13.0).
Upgrade codebase-memory-mcp, or reinstall an earlier pi-cbm release (<= 1.2.1) to keep using it.
```

A newer untested major/minor continues with a one-time warning instead of failing. Set `PI_CBM_SKIP_VERSION_CHECK=1` to skip the probe (useful for packaged/vendored binaries and for tests).

CLI output is normalized before it reaches the tools, so the 0.12 table shapes (`cols`/`rows`, `groups` with `qn_prefix`, `{cols,rows}` label tables, absolute `file` paths, tree-text `list_projects`) are converted to the object arrays and project resolution behavior the rest of the extension expects.

## Install

```sh
pi install npm:pi-cbm
```

Or test for one run:

```sh
pi -e npm:pi-cbm
```

## Tools

Registers:

- `get_graph_schema`
- `get_architecture`
- `search_graph`
- `resolve_symbol`
- `read_symbol`
- `read_symbols`
- `search_code`
- `get_code_snippet`
- `get_code_snippets`
- `search_and_read_symbols`
- `trace_path`
- `query_graph`
- `detect_changes`

Most tools accept optional `project`. When omitted, the extension infers it from indexed project roots matching Pi's current working directory. Agents should omit `project` for cwd/current-project work and provide it only when intentionally querying an external indexed project. A `project` value must be an indexed project name or a path: absolute, or explicitly relative to the current working directory (`.`, `..`, or containing a `/`). A bare word such as `other-repo` is always treated as a project name, never as a directory under the cwd. An unknown value fails with the indexed project list instead of falling back to a guessed name.

Matching uses the longest indexed root that contains the working directory, so a git worktree or nested checkout that is not indexed itself resolves to the containing repo's graph. Index the worktree separately to query its own graph.

## Commands

### `/cbm`

Open the pi-cbm settings menu:

- `/cbm menu` — show the interactive settings menu.
- `/cbm status` — show auto-index settings.
- `/cbm enable-non-git` — auto-index safe non-git working directories.
- `/cbm disable-non-git` — only auto-index git repositories.

Non-git auto-indexing is disabled by default. Enable it explicitly when working in a non-git project. The unsafe-path guard is always enabled: filesystem roots, home directories, system directories, and common macOS/Linux builtin directories are skipped with a status message explaining why.

Set `PI_CBM_MAX_CONCURRENT_INDEXES` to configure the machine-wide maximum number of simultaneous repository indexers. It defaults to `1`; use a higher value only when all Pi sessions share the same cache directory and the machine can safely support the additional concurrency.

Set `PI_CBM_AUTO_REFRESH_INTERVAL_MS` to override the background refresh interval in milliseconds. It defaults to `60000` (60 seconds), so single-agent workflows do not have to wait for a long freshness TTL. `PI_CBM_CACHE_DIR` optionally overrides the coordination/cache directory and is forwarded to the upstream CLI as `CBM_CACHE_DIR`.

Set `PI_CBM_FRESH_INDEX_TIMEOUT_MS` to bound how long a tool waits for a stale index to be refreshed before answering from the existing graph. `detect_changes` also re-indexes before diffing; keep this timeout small on large repositories so a first call after a long pause does not block for minutes.

The legacy `CBM_MAX_CONCURRENT_INDEXES`, `CBM_AUTO_REFRESH_INTERVAL_MS`, and `CBM_CACHE_DIR` names remain supported for backwards compatibility. When both names are set, the `PI_CBM_*` value takes precedence.

Notes:

- Use `search_graph` first for symbol/workflow/route/class/function discovery and “where is X implemented?” questions. Use a small limit for targeted lookup.
- Use `search_and_read_symbols` when you need to both discover implementation locations and inspect source for the top matches. Prefer it over `search_graph` followed by many individual snippet reads. Keep `read_limit` small, usually 3–8.
- Use `resolve_symbol` when you know a symbol name but need the exact `qualified_name` or need to disambiguate candidates.
- Use `read_symbol` when you know a symbol name plus enough disambiguators, such as `file_path`, `parent_class`, `label`, `route_path`, or `route_method`, and want source only if the match is unambiguous.
- Use `read_symbols` when you know multiple concrete symbol names and need their source in one call. Each item fails closed on ambiguity like `read_symbol`; retry only ambiguous items with stronger disambiguators.
- `read_symbol` fails closed on ambiguity; if it returns candidates, retry with more disambiguators or use `get_code_snippet` with an exact `qualified_name`.
- `read_symbol` supports `neighbors: "callers" | "callees" | "both"` plus `neighbor_limit` for direct, compact, source-free surrounding call context. Use `trace_path` for multi-hop workflow or impact tracing.
- Use `get_code_snippet` when you already have an exact `qualified_name`; prefer `read_symbol` when you have a concrete symbol name plus disambiguators but not the exact `qualified_name`.
- Use `get_code_snippets` when you already have multiple exact `qualified_name` values from search, trace, or query results. Prefer it over repeated `get_code_snippet` calls.
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
- Batch/source tools such as `get_code_snippets`, `read_symbols`, and `search_and_read_symbols` use the same compact metadata defaults: they preserve essential identity such as `file_path`, `start_line`, `end_line`, `qualified_name`, signatures, and route fields while stripping less-useful raw graph metadata unless `include_metadata: true` is set.
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

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests read recorded CLI output from `test/fixtures/` instead of running a real binary. To refresh the fixtures after a `codebase-memory-mcp` release, follow `test/fixtures/README.md`: `scripts/capture-fixtures.sh <binary> <version>` indexes a neutral copy of `src/` in a temp directory and records each case's stdout plus a `.meta.json` (invocation, args, exit code, stderr). Adding a new version directory means updating the fixture-driven expectations in the matching `test/*.test.ts` files.
