#!/usr/bin/env node
// A stand-in for the cbm CLI in the freshness tests. Its project list lives in
// the JSON file named by FAKE_CBM_STATE, every call is appended to
// `<state>.log`, and `index_repository` blocks while `<state>.hold` exists.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_CBM_STATE;
const tool = process.argv[process.argv.indexOf("--json") + 1];
const input = tool === "list_projects" ? {} : JSON.parse(readFileSync(0, "utf8") || "{}");
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const log = (entry) => appendFileSync(`${statePath}.log`, `${JSON.stringify(entry)}\n`);

function reply(data, isError = false) {
  process.stdout.write(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(data) }], isError }));
  process.exitCode = isError ? 1 : 0;
}

log({ tool, ...input });
if (tool === "list_projects") {
  reply({ projects: readState().projects.map(({ name, root_path }) => ({ name, root_path })), has_more: false });
} else if (tool === "index_status") {
  const project = readState().projects.find((entry) => entry.name === input.project);
  if (project) reply({ ...project, status: "ready" });
  else reply({ error: "project not found or not indexed" }, true);
} else if (tool === "index_repository") {
  const name = input.name ?? input.repo_path.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[-.]+/, "");
  while (existsSync(`${statePath}.hold`)) await new Promise((resolve) => setTimeout(resolve, 20));
  // Like cbm, stamp the completion time with second precision.
  const indexed_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const state = readState();
  state.projects = [...state.projects.filter((entry) => entry.name !== name), { name, root_path: input.repo_path, indexed_at }];
  writeFileSync(statePath, JSON.stringify(state));
  log({ tool: "index_repository:done", name });
  reply({ project: name, nodes: 1, edges: 1 });
} else if (tool === "detect_changes") {
  reply({ changed_files: [], impacted: [] });
} else {
  reply({ error: `unexpected tool: ${tool}` }, true);
}
