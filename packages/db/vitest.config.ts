import { beamVitest } from "@beam/config";
import { defineConfig } from "vitest/config";

export default defineConfig(
  beamVitest({ include: ["test/**/*.test.ts", "src/**/*.test.ts", "scripts/**/*.test.ts"] }),
);
