import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup-env.ts"],
    // Agent worktrees under .claude/worktrees hold full copies of the test suite.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
