import { afterAll } from "vitest";

// These are user configuration for the extension, so an exported shell value must not change test results.
// CBM_CACHE_DIR is cbm's own variable, which pi-cbm still follows for its cache dir.
const CONFIGURED_ENV = [
  "PI_CBM_MAX_CONCURRENT_INDEXES",
  "PI_CBM_AUTO_REFRESH_INTERVAL_MS",
  "PI_CBM_FRESH_INDEX_TIMEOUT_MS",
  "PI_CBM_CACHE_DIR",
  "CBM_CACHE_DIR",
  "PI_CBM_SKIP_VERSION_CHECK",
  "PI_CBM_BIN",
  // Removed names: set, they make the session start warn.
  "CODEBASE_MEMORY_MCP_BIN",
  "CBM_BIN",
  "CBM_MAX_CONCURRENT_INDEXES",
  "CBM_AUTO_REFRESH_INTERVAL_MS",
  "CBM_FRESH_INDEX_TIMEOUT_MS",
  "CBM_SKIP_VERSION_CHECK",
];

const ambient = new Map(CONFIGURED_ENV.map((key) => [key, process.env[key]]));
for (const key of CONFIGURED_ENV) delete process.env[key];

afterAll(() => {
  for (const [key, value] of ambient) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
