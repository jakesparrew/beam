# Dependency request: platform-P5

| Package | Version (`npm view`) | Workspace | Why |
| --- | --- | --- | --- |
| `drizzle-orm` | `0.45.4` (`catalog:`, already in the catalog and in `@beam/db`) | `apps/web` (`dependencies`) | Every server file in `apps/web` (`lib/*`, every module's `actions.ts`, `queries.ts`, `api.ts` and jobs) builds queries with Drizzle's operators (`sql`, `eq`, `and`, `inArray`, ...). `apps/web/package.json` does not list `drizzle-orm`, and pnpm's strict layout does not hoist it, so `import { sql } from "drizzle-orm"` cannot be resolved from `apps/web`. |

Files that need it: `apps/web/lib/ctx.ts` (and through it every `apps/web/lib/*.ts` file of platform-P5).

**Workaround in this package.** `apps/web/lib/ctx.ts` re-exports the operators from the copy `@beam/db`
already uses (`../../../packages/db/node_modules/drizzle-orm`, the same physical package, so `sql`
objects and tables stay compatible; typecheck, Vitest and the Next build resolve it). Other `apps/web`
code imports them from `@/lib/ctx` (`import { eq, sql } from "@/lib/ctx"`). Once W0-0 adds
`"drizzle-orm": "catalog:"` to `apps/web/package.json`, the re-export in `ctx.ts` can point at
`drizzle-orm` directly (a one-line orchestrator change to a frozen file); no caller changes.
