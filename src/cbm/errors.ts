import { errorTextWithDetails } from "../shared/strings.js";
import type { CbmData } from "./normalize.js";

/** A cbm tool answered with `isError`; `data` is its normalized error payload. */
export class CbmToolError extends Error {
  constructor(
    readonly tool: string,
    readonly data: CbmData,
  ) {
    super(errorTextWithDetails(data));
    this.name = "CbmToolError";
  }
}
