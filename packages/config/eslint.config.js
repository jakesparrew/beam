// Shared ESLint flat config (`@beam/config/eslint`), re-exported by the root
// `eslint.config.js`. File patterns are relative to the repository root, where the
// root config lives (ESLint 10 resolves the config from each linted file upwards).
//
// Boundaries (architecture section 1, PL-51, PL-82) are `no-restricted-imports` rules
// generated in code from MODULE_IDS. ESLint replaces (does not merge) the options of a
// rule when two config objects match the same file, so every scope below gets its
// complete list, including the `@anthropic-ai/sdk` restriction.
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Repository root (two levels above packages/config). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The twelve module ids (architecture section 1); kept equal to `@beam/config` MODULE_IDS by a test. */
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
];

/** The rule every boundary uses (the typescript-eslint variant supports `allowTypeImports`). */
export const BOUNDARY_RULE = "@typescript-eslint/no-restricted-imports";

const TS_FILES = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const JS_FILES = ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx"];

const ANTHROPIC_MESSAGE =
  "Claude is called only through packages/integrations/src/anthropic/ (PL-51); use callClaude() from lib/ai.ts.";

/** A restriction of one package name and all of its subpaths. */
function pkg(name, message, extra = {}) {
  return {
    paths: [{ name, message, ...extra }],
    patterns: [{ group: [`${name}/*`], message, ...extra }],
  };
}

/** A restriction of one exact import path (no subpaths). */
function exact(name, message) {
  return { paths: [{ name, message }], patterns: [] };
}

/** The rule entry for a list of restrictions, plus the Anthropic one unless `anthropic` is false. */
function restrict(entries, { anthropic = true, patterns = [] } = {}) {
  const list = anthropic ? [...entries, pkg("@anthropic-ai/sdk", ANTHROPIC_MESSAGE)] : entries;
  const paths = list.flatMap((e) => e.paths);
  const all = [...patterns, ...list.flatMap((e) => e.patterns)];
  return all.length ? ["error", { paths, patterns: all }] : ["error", { paths }];
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Patterns that forbid module `moduleId` from importing another module's internals:
 * relative (`../booking/queries`), through the app alias (`@/modules/booking/...`) or
 * through `apps/web/modules/...`. Only `modules/<other>/api` is allowed (PL-82).
 */
export function moduleBoundaryPatterns(moduleId) {
  const others = MODULE_IDS.filter((m) => m !== moduleId)
    .map(escapeRegex)
    .join("|");
  const rest = `(?:/(?!api(?:\\.ts)?$).*)?$`;
  const message = `Import another module only through modules/<m>/api (or @beam/core/<m>); ${moduleId} may not reach into another module's internals (PL-82).`;
  return [
    { regex: `^(?:\\.\\./)+(?:modules/)?(?:${others})${rest}`, message },
    { regex: `^@/modules/(?:${others})${rest}`, message },
    { regex: `(?:^|/)apps/web/modules/(?:${others})${rest}`, message },
  ];
}

const msg = (who, what) => `${who} must not import ${what} (architecture section 1).`;

const SCOPES = {
  core: [
    ...["@beam/email", "@beam/integrations", "@beam/ui", "react", "react-dom", "next", "drizzle-orm", "pg"].map((n) =>
      pkg(n, msg("@beam/core", n)),
    ),
    exact("node:crypto", msg("@beam/core", "node:crypto (core is pure)")),
    pkg("@beam/db", "@beam/core may only `import type` from @beam/db (OD-1).", { allowTypeImports: true }),
  ],
  ui: [
    ...["@beam/db", "@beam/core", "@beam/email", "@beam/integrations", "server-only"].map((n) =>
      pkg(n, msg("@beam/ui", n)),
    ),
    exact("next/server", msg("@beam/ui", "Next server code")),
  ],
  db: [
    ...["@beam/email", "@beam/integrations", "@beam/ui", "@beam/web"].map((n) => pkg(n, msg("@beam/db", n))),
    { paths: [], patterns: [{ group: ["@/*"], message: msg("@beam/db", "apps/web code") }] },
  ],
  email: ["@beam/db", "@beam/integrations", "@beam/ui"].map((n) => pkg(n, msg("@beam/email", n))),
  integrations: ["@beam/db", "@beam/email", "@beam/ui"].map((n) => pkg(n, msg("@beam/integrations", n))),
  config: [{ paths: [], patterns: [{ group: ["@beam/*"], message: msg("@beam/config", "any @beam package") }] }],
};

/** The boundary config objects only (exported for eslint-boundaries.test.ts). */
export const boundaries = [
  {
    name: "beam/boundaries/plugin",
    plugins: { "@typescript-eslint": tseslint.plugin },
  },
  {
    name: "beam/boundaries/default",
    files: [...TS_FILES, ...JS_FILES],
    rules: { [BOUNDARY_RULE]: restrict([]) },
  },
  ...MODULE_IDS.map((m) => ({
    name: `beam/boundaries/module-${m}`,
    files: [`apps/web/modules/${m}/**`],
    rules: { [BOUNDARY_RULE]: restrict([], { patterns: moduleBoundaryPatterns(m) }) },
  })),
  ...["core", "ui", "db", "email", "integrations", "config"].map((scope) => ({
    name: `beam/boundaries/${scope}`,
    files: [`packages/${scope}/**`],
    rules: { [BOUNDARY_RULE]: restrict(SCOPES[scope]) },
  })),
  {
    name: "beam/boundaries/anthropic",
    files: ["packages/integrations/src/anthropic/**"],
    rules: { [BOUNDARY_RULE]: restrict(SCOPES.integrations, { anthropic: false }) },
  },
];

export const ignores = [
  "**/node_modules/**",
  "**/*.generated.ts",
  "packages/db/migrations/**",
  "packages/db/src/schema/index.ts",
  "apps/web/scripts/__fixtures__/**",
  "**/.next/**",
  "**/coverage/**",
  "**/dist/**",
  "**/.turbo/**",
  "**/next-env.d.ts",
  "**/playwright-report/**",
  "**/test-results/**",
  "apps/web/public/sw.js",
  ".claude/**",
];

const config = [
  { name: "beam/ignores", ignores },
  { name: "beam/js", files: [...TS_FILES, ...JS_FILES], ...js.configs.recommended },
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: c.files ?? TS_FILES })),
  {
    name: "beam/typescript",
    files: TS_FILES,
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts", "*.config.js", "*.config.mjs", "neon.ts"],
        },
        tsconfigRootDir: ROOT,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // Provider SDK and drizzle-kit typings surface as `any`/error types; these stay visible
      // as warnings instead of failing code that only passes such values through.
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
    },
  },
  {
    name: "beam/language",
    files: [...TS_FILES, ...JS_FILES],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: { "no-console": "error" },
  },
  {
    name: "beam/next",
    files: ["apps/web/**/*.{ts,tsx,js,mjs}"],
    ...nextPlugin.configs.recommended,
    settings: { next: { rootDir: "apps/web/" } },
  },
  {
    name: "beam/react-hooks",
    files: ["apps/web/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
  },
  ...boundaries,
  {
    name: "beam/scripts",
    files: ["apps/web/scripts/**", "packages/*/scripts/**", "scripts/**"],
    rules: { "no-console": "off" },
  },
  { name: "beam/prettier", ...prettier },
];

// ESLint 10 resolves the nearest config file per linted file, so files under
// packages/config load this file directly. `basePath` keeps every pattern root-relative
// whichever file loaded the config.
export default config.map((c) => ({ basePath: ROOT, ...c }));
