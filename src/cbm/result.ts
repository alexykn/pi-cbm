import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

export type CbmCallOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  allowError?: boolean;
};

export type CbmCallResult = {
  ok: boolean;
  data: unknown;
  rawText: string;
  stderr: string;
};

export type ToolTextResult = {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
};

export async function buildToolTextResult(title: string, data: unknown, details: Record<string, unknown> = {}): Promise<ToolTextResult> {
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const truncation = truncateHead(json, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });

  let text = `${title}\n\n${truncation.content}`;
  const resultDetails: Record<string, unknown> = { ...details, data };

  if (typeof resultDetails.uncompactedOutputPath === "string") {
    text += `\n\n[Large code blocks were compacted. Full un-compacted output saved to: ${resultDetails.uncompactedOutputPath}. Rerun with full_output=true or increase max_symbol_lines to include more in the response.]`;
  }

  if (truncation.truncated) {
    const dir = await mkdtemp(join(tmpdir(), "pi-cbm-"));
    const path = join(dir, "result.json");
    await writeFile(path, json, "utf8");
    resultDetails.fullOutputPath = path;
    resultDetails.truncation = truncation;
    text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
      truncation.outputBytes,
    )} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${path}]`;
  }

  return { content: [{ type: "text", text }], details: resultDetails };
}

export async function saveJsonResult(data: unknown, filename = "result.full.json"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cbm-"));
  const path = join(dir, filename);
  await writeFile(path, typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf8");
  return path;
}
