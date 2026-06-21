import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { isRecord } from "./object.js";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeForMatch(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

export function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.error === "string") return value.error;
  return JSON.stringify(value);
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
