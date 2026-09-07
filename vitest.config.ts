import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // No threshold on purpose. A number that fails a build gets met by whatever test raises it
    // fastest, which is not the same as the line being tested. What this is for is noticing a
    // module that stops being covered at all.
    coverage: { provider: "v8", include: ["src/**"], reporter: ["text", "html"] },
  },
});
