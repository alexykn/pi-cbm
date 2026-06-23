export const CODEBASE_MEMORY_PROMPT = `

Codebase-memory guidance:
- Strongly prefer codebase-memory tools over bash/read/grep/find/cat for code exploration. They return compact, symbol-aware, location-first results and usually save substantial tokens/context compared with raw filesystem output.
- Use shell tools mainly for builds, tests, linting, filesystem state, or reading obvious non-code files. Do not use grep/find/cat as the first step for symbol, workflow, relationship, caller/callee, or indexed-text discovery.
- The current cwd project is auto-indexed in full mode in the background at startup and periodically refreshed.
- For cwd/current-project tools, omit the project parameter; the plugin infers it automatically. Provide project only when intentionally querying an external indexed project.
- Exploration tools default to compact, location-first output to save context. Set include_metadata=true only when raw graph metrics/fingerprints/full upstream metadata are needed.
- Compact output hides analysis metadata, not edit-critical location identity; symbol-like results should include file_path/start_line/end_line when available.
- If a codebase-memory result is compacted or truncated, retry the same codebase-memory tool with a higher max_symbol_lines or full_output=true before falling back to raw file reads.
- When you need to inspect multiple symbols, prefer read_symbols or get_code_snippets over repeated read_symbol/get_code_snippet calls.
- When you need to discover implementation locations and inspect likely code, prefer search_and_read_symbols over search_graph followed by many individual snippet reads.
- Keep batch reads focused, usually 3-12 symbols; use small search_and_read_symbols read_limit values, usually 3-8.

Use codebase-memory for symbol, workflow, relationship, indexed-text, and impact discovery:
- If given a concrete symbol/function/class/method name, prefer resolve_symbol or read_symbol before search_graph.
- If given multiple concrete symbol/function/class/method names, prefer read_symbols before repeated resolve_symbol/read_symbol calls.
- Use search_graph when the target is conceptual, unknown, or a workflow rather than a known symbol name.
- Use search_and_read_symbols when the target is conceptual/unknown and you need source for the likely top matches, not just locations.
- For conceptual “where is X implemented/handled/performed?” questions, use search_graph first with a small limit, then read_symbol or get_code_snippet only for the likely target symbol.
- For conceptual “find and inspect the implementation” tasks, use search_and_read_symbols with a small read_limit instead of search_graph plus several separate reads.
- Use resolve_symbol when you know a symbol name but need the exact qualified_name or candidate list; add file_path, parent_class, label, route_path, or route_method to narrow ambiguous names.
- Use read_symbol when you know a symbol name plus enough disambiguators and want source only if the match is unambiguous.
- read_symbol fails closed on ambiguity; if it returns candidates, retry with more disambiguators or use get_code_snippet with an exact qualified_name.
- Use get_code_snippet when you already have an exact qualified_name; prefer read_symbol when you have a concrete symbol name plus disambiguators but not the exact qualified_name.
- Use get_code_snippets when you already have multiple exact qualified_name values.
- Use read_symbol neighbors='callers'/'callees'/'both' for direct, source-free callers/callees. Use trace_path only for multi-hop workflow, dependency, impact, data-flow, or cross-service tracing.
- Prefer read_symbol/get_code_snippet over raw file reads when the target is a symbol; prefer file reads for known files, configs, docs, manifests, and non-symbol content.
- For direct “what calls X?” or “what does X call?” questions about a known symbol, prefer read_symbol(neighbors='callers'/'callees'/'both'); use trace_path with shallow depth, usually 2–3, when multi-hop tracing is needed.
- If the query is a symbol name, prefer resolve_symbol/read_symbol; if it is an exact non-symbol string or you need all textual occurrences, use search_code.
- For exact strings, env vars, route literals, config keys, or template text, use search_code instead of search_graph.
- For broad architecture orientation in an unfamiliar repo, use get_architecture. Requested aspects may be absent if the index has no data for them; use search_graph/query_graph for targeted route/entry-point lookup.
- For custom graph questions or aggregates, use get_graph_schema before query_graph and keep returned columns narrow.
- For local diff review or blast-radius analysis, use detect_changes.

When not to use codebase-memory:
- If the user asks about README/package/deployment/config manifests and the file path is obvious, read the file directly.
- If the task is to run tests, build, lint, or inspect filesystem state, use shell tools.
- If a graph search returns no results, check spelling and try a more specific symbol, literal, or file-pattern query before falling back to filesystem inspection.
`;
