import path from "node:path";
import { fileURLToPath } from "node:url";
import { beamVitest } from "@beam/config";
import react from "@vitejs/plugin-react";
import { defineConfig, mergeConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

// DR-9: `@` resolves to apps/web, and `server-only` (which throws outside a React Server
// build) resolves to an empty stub. Playwright specs under e2e/ are never collected.
export default defineConfig(
  mergeConfig(
    beamVitest({ include: ["**/*.test.ts", "**/*.test.tsx"] }),
    {
      plugins: [react()],
      resolve: {
        alias: [
          { find: /^server-only$/, replacement: path.resolve(here, "../../packages/config/src/server-only-stub.ts") },
          { find: /^@\//, replacement: `${here}/` },
        ],
      },
      test: { exclude: ["e2e/**"] },
    },
  ),
);
