/**
 * `pnpm db:views` (data model DM-1): views are custom SQL in dependency order.
 *
 * Every `packages/db/src/schema/*.views.ts` declares `pgView(name, columns).existing()` and
 * exports its SQL as `<name>Sql`. This script collects those exports from the schema index,
 * finds the views each one reads (`from` / `join` targets starting with `v_` or `ai.`), sorts
 * them topologically (ties by name) and:
 *
 * - with no flag, prints the `create or replace view` statements;
 * - `--migration <name>` runs `drizzle-kit generate --custom --name <name>` and writes the
 *   statements of every view that is new or whose SQL changed since the committed migrations
 *   into that file. With nothing to write it creates no migration and exits 0. A changed view
 *   that `create or replace` cannot handle (columns removed, renamed or retyped) is dropped with
 *   `cascade` and re-created together with every view that depends on it; a warning is printed;
 * - `--check` exits 1 when a view in code is missing from the committed migrations or its SQL
 *   differs from the latest committed definition.
 *
 * `createTestDb()` applies `viewStatements()` after the schema, so tests always see the views.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { is } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getViewConfig, PgView } from "drizzle-orm/pg-core";
import * as schemaIndex from "../src/schema/index";

const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const DEFAULT_MIGRATIONS_FOLDER = path.join(PACKAGE_DIR, "migrations");
export const STATEMENT_BREAKPOINT = "\n--> statement-breakpoint\n";

export type ViewDef = { name: string; sql: string; deps: string[] };
export type ViewPlan = {
  statements: string[];
  changed: string[];
  dropped: string[];
  warnings: string[];
};

const toSnake = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const normalise = (sql: string) =>
  sql
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .trim();

/** Every view name a SQL text reads through `from` or `join` (`v_*` and `ai.*` only). */
export function viewDependencies(sql: string): string[] {
  const out = new Set<string>();
  const re =
    /\b(?:from|join)\s+(?:lateral\s+)?("?(?:ai\.)?[a-z_][a-z0-9_]*"?)/gi;
  for (const m of sql.matchAll(re)) {
    const name = m[1]!.replace(/"/g, "").toLowerCase();
    if (name.startsWith("v_") || name.startsWith("ai.")) out.add(name);
  }
  return [...out].sort();
}

/** Collects `<name>Sql` string exports, named after their `pgView` export when present. */
export function collectViews(
  mod: Record<string, unknown> = schemaIndex,
): ViewDef[] {
  const views = new Map<string, ViewDef>();
  for (const [key, value] of Object.entries(mod)) {
    if (!key.endsWith("Sql") || typeof value !== "string") continue;
    const base = key.slice(0, -3);
    const view = mod[base];
    const name =
      view && is(view, PgView) ? getViewConfig(view).name : toSnake(base);
    if (views.has(name))
      throw new Error(`db:views: view "${name}" is declared twice`);
    views.set(name, { name, sql: value.trim().replace(/;\s*$/, ""), deps: [] });
  }
  for (const v of views.values())
    v.deps = viewDependencies(v.sql).filter(
      (d) => d !== v.name && views.has(d),
    );
  return [...views.values()];
}

/** Topological order (a view after every view it reads), ties by name. Throws on a cycle. */
export function orderViews(views: ViewDef[]): ViewDef[] {
  const byName = new Map(views.map((v) => [v.name, v]));
  const done = new Set<string>();
  const out: ViewDef[] = [];
  const visit = (v: ViewDef, stack: string[]) => {
    if (done.has(v.name)) return;
    if (stack.includes(v.name))
      throw new Error(
        `db:views: dependency cycle ${[...stack, v.name].join(" -> ")}`,
      );
    for (const d of [...v.deps].sort()) {
      const dep = byName.get(d);
      if (dep) visit(dep, [...stack, v.name]);
    }
    done.add(v.name);
    out.push(v);
  };
  for (const v of [...views].sort((a, b) => a.name.localeCompare(b.name)))
    visit(v, []);
  return out;
}

export const createViewStatement = (v: Pick<ViewDef, "name" | "sql">) =>
  `create or replace view ${v.name} as\n${v.sql};`;

/** `create or replace view` statements for every view in code, in dependency order. */
export function viewStatements(mod?: Record<string, unknown>): string[] {
  return orderViews(collectViews(mod)).map(createViewStatement);
}

/** The latest committed definition of every view, read from the migrations in journal order. */
export function previousViewDefinitions(
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
): Map<string, string> {
  const defs = new Map<string, string>();
  const create =
    /^\s*create\s+(?:or\s+replace\s+)?view\s+("?[a-z0-9_.]+"?)\s+as\s+([\s\S]*?)\s*;?\s*$/i;
  const drop = /^\s*drop\s+view\s+(?:if\s+exists\s+)?("?[a-z0-9_.]+"?)/i;
  for (const migration of readMigrationFiles({ migrationsFolder })) {
    for (const chunk of migration.sql) {
      for (const statement of chunk.split(/;\s*\n(?=\s*(?:create|drop)\s)/i)) {
        const c = create.exec(statement);
        if (c) {
          defs.set(c[1]!.replace(/"/g, "").toLowerCase(), c[2]!.trim());
          continue;
        }
        const d = drop.exec(statement);
        if (d) defs.delete(d[1]!.replace(/"/g, "").toLowerCase());
      }
    }
  }
  return defs;
}

/** Views in code whose SQL is missing from, or differs from, the committed definitions. */
export function driftedViews(
  views: ViewDef[],
  previous: Map<string, string>,
): string[] {
  return views
    .filter((v) => normalise(previous.get(v.name) ?? "") !== normalise(v.sql))
    .map((v) => v.name);
}

/**
 * Returns the names of changed views that `create or replace` rejects. The default probe
 * builds the schema in PGlite, creates the previous definitions and tries each replacement.
 */
export type ReplaceProbe = (
  ordered: ViewDef[],
  previous: Map<string, string>,
  changed: string[],
) => Promise<Set<string>>;

export const pgliteProbe: ReplaceProbe = async (ordered, previous, changed) => {
  const [{ PGlite }, { schemaToSql }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("../src/testing"),
  ]);
  const client = new PGlite();
  const rejected = new Set<string>();
  try {
    for (const statement of await schemaToSql()) await client.exec(statement);
    const old = orderViews(
      [...previous].map(([name, sql]) => ({
        name,
        sql,
        deps: viewDependencies(sql).filter((d) => previous.has(d)),
      })),
    );
    for (const v of old)
      await client.exec(createViewStatement(v)).catch(() => undefined);
    for (const v of ordered) {
      if (!changed.includes(v.name)) continue;
      try {
        await client.exec(createViewStatement(v));
      } catch {
        rejected.add(v.name);
        await client
          .exec(
            `drop view if exists ${v.name} cascade; ${createViewStatement(v)}`,
          )
          .catch(() => undefined);
      }
    }
  } finally {
    await client.close();
  }
  return rejected;
};

/** The statements of a views migration: new and changed views, plus re-creations after drops. */
export async function planViewMigration(
  views: ViewDef[],
  previous: Map<string, string>,
  probe: ReplaceProbe = pgliteProbe,
): Promise<ViewPlan> {
  const ordered = orderViews(views);
  const changed = driftedViews(ordered, previous);
  const replaced = changed.filter((n) => previous.has(n));
  const rejected = replaced.length
    ? await probe(ordered, previous, replaced)
    : new Set<string>();

  // Every view that reads a dropped view (now or in its previous definition) is dropped by cascade.
  const readers = (name: string) =>
    ordered
      .filter(
        (v) =>
          v.deps.includes(name) ||
          viewDependencies(previous.get(v.name) ?? "").includes(name),
      )
      .map((v) => v.name);
  const recreate = new Set<string>(changed);
  const cascaded = new Set<string>(rejected);
  const queue = [...rejected];
  while (queue.length) {
    for (const r of readers(queue.shift()!)) {
      recreate.add(r);
      if (!cascaded.has(r)) {
        cascaded.add(r);
        queue.push(r);
      }
    }
  }

  const statements: string[] = [];
  const warnings: string[] = [];
  for (const v of ordered) {
    if (!recreate.has(v.name)) continue;
    if (rejected.has(v.name)) {
      statements.push(`drop view if exists ${v.name} cascade;`);
      warnings.push(
        `db:views: ${v.name} changed its column list or types; it is dropped with cascade and re-created with its dependent views.`,
      );
    }
    statements.push(createViewStatement(v));
  }
  return { statements, changed, dropped: [...rejected].sort(), warnings };
}

export type ViewsCliDeps = {
  views?: ViewDef[];
  migrationsFolder?: string;
  probe?: ReplaceProbe;
  /** Runs `drizzle-kit generate --custom --name <name>`; returns nothing, the journal tells the file. */
  generateCustom?: (name: string) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

const defaultGenerateCustom = (name: string) => {
  execFileSync(
    "pnpm",
    ["exec", "drizzle-kit", "generate", "--custom", "--name", name],
    {
      cwd: PACKAGE_DIR,
      stdio: "inherit",
    },
  );
};

/** The SQL file of the newest journal entry named `<name>`. */
function customMigrationFile(migrationsFolder: string, name: string): string {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as {
    entries: { tag: string }[];
  };
  const entry = [...journal.entries]
    .reverse()
    .find((e) => e.tag === name || e.tag.endsWith(`_${name}`));
  if (!entry)
    throw new Error(`db:views: drizzle-kit created no migration named ${name}`);
  return path.join(migrationsFolder, `${entry.tag}.sql`);
}

/** CLI. Returns the exit code. */
export async function main(
  argv: string[] = process.argv.slice(2),
  deps: ViewsCliDeps = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const folder = deps.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const views = deps.views ?? collectViews();

  if (argv.includes("--check")) {
    const drifted = driftedViews(views, previousViewDefinitions(folder));
    if (drifted.length) {
      error(
        `db:views: ${drifted.length} view(s) differ from the committed migrations: ${drifted.join(", ")}`,
      );
      error("Run: pnpm db:views --migration <wave>_views");
      return 1;
    }
    log(`db:views: ${views.length} view(s) match the committed migrations.`);
    return 0;
  }

  const at = argv.indexOf("--migration");
  if (at >= 0) {
    const name = argv[at + 1];
    if (!name || !/^[a-z0-9_]+$/.test(name)) {
      error(
        "db:views: --migration needs a snake_case name, e.g. --migration init_views",
      );
      return 1;
    }
    const plan = await planViewMigration(
      views,
      previousViewDefinitions(folder),
      deps.probe,
    );
    if (!plan.statements.length) {
      log("db:views: no new or changed views; no migration written.");
      return 0;
    }
    (deps.generateCustom ?? defaultGenerateCustom)(name);
    const file = customMigrationFile(folder, name);
    writeFileSync(file, `${plan.statements.join(STATEMENT_BREAKPOINT)}\n`);
    for (const w of plan.warnings) error(w);
    log(
      `db:views: wrote ${plan.statements.length} statement(s) to ${path.relative(PACKAGE_DIR, file)} (${plan.changed.join(", ")}).`,
    );
    return 0;
  }

  for (const statement of orderViews(views).map(createViewStatement))
    log(`${statement}\n`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
