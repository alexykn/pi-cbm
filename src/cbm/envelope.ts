export type CbmEnvelope = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

export function parseCbmEnvelope(stdout: string): { envelope: CbmEnvelope; text: string } {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("codebase-memory-mcp produced no JSON output");

  const candidates = [
    trimmed,
    ...trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") && line.endsWith("}"))
      .reverse(),
  ];

  let envelope: CbmEnvelope | undefined;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as CbmEnvelope;
      if (parsed && typeof parsed === "object" && (Array.isArray(parsed.content) || "isError" in parsed)) {
        envelope = parsed;
        break;
      }
    } catch {
      // Ignore log lines or partial output before the JSON envelope.
    }
  }

  if (!envelope) throw new Error(`Could not parse codebase-memory-mcp JSON envelope from output: ${trimmed.slice(0, 500)}`);

  const firstText = envelope.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  return { envelope, text: firstText ?? trimmed };
}

export function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}
