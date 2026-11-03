/**
 * Shared constants and presets of the BEAM tooling (`@beam/config`).
 * This package imports no other `@beam/*` package (architecture section 1).
 */
import type { ViteUserConfig } from "vitest/config";

/** The twelve module ids, in the order of architecture section 1. */
export const MODULE_IDS = [
  "platform",
  "crm",
  "booking",
  "commerce",
  "credits",
  "finance",
  "forms",
  "email",
  "automation",
  "ops",
  "site",
  "webinar",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}

export type BeamVitestOptions = {
  /** Run the suite in jsdom (React components) instead of Node. */
  jsdom?: boolean;
  /** Test file globs; defaults to every `*.test.ts(x)` outside e2e and fixtures. */
  include?: string[];
  /** Setup files (for example `@testing-library/jest-dom/vitest`). */
  setupFiles?: string[];
};

/** Files Vitest never collects as tests. */
export const VITEST_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/e2e/**",
  "**/__fixtures__/**",
  "**/playwright-report/**",
  "**/test-results/**",
];

/**
 * The Vitest preset every workspace uses (DR-6): two forked workers so six parallel
 * agents stay inside the sandbox memory, generous timeouts for PGlite, and a package
 * without tests yet is green (`passWithNoTests`).
 */
export function beamVitest(options: BeamVitestOptions = {}): ViteUserConfig {
  return {
    test: {
      environment: options.jsdom ? "jsdom" : "node",
      include: options.include ?? ["**/*.test.ts", "**/*.test.tsx"],
      exclude: VITEST_EXCLUDE,
      setupFiles: options.setupFiles ?? [],
      pool: "forks",
      maxWorkers: 2,
      passWithNoTests: true,
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  };
}
