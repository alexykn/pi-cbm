import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { isRecord } from "./object.js";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeForMatch(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

export function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.error === "string") return value.error;
  return JSON.stringify(value);
}

/** Like `errorText`, but keeps cbm's `hint`/`available_projects` context for user-facing throws. */
export function errorTextWithDetails(value: unknown): string {
  const text = errorText(value);
  if (!isRecord(value)) return text;
  const parts = [text];
  const hint = value.hint;
  if (typeof hint === "string" && hint.trim()) parts.push(hint.trim());
  const available = value.available_projects;
  if (Array.isArray(available)) {
    const projects = available.filter((item): item is string => typeof item === "string");
    if (projects.length > 0) parts.push(`available_projects: ${projects.join(", ")}`);
  }
  return parts.join(" ");
}

export function normalizePathForDisplay(path: string): string {
  if (!isAbsolute(path)) return path;
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

export function basename(path: string): string {
  const parent = dirname(path);
  return parent === path ? path : path.slice(parent.length + 1);
}
