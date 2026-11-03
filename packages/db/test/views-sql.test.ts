import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  collectViews,
  main,
  orderViews,
  planViewMigration,
  previousViewDefinitions,
  viewDependencies,
  viewStatements,
  type ViewDef,
} from "../scripts/views-sql";

const view = (name: string, sql: string): ViewDef => ({ name, sql, deps: [] });
/** Recomputes deps the way collectViews does. */
const withDeps = (views: ViewDef[]) => {
  const names = new Set(views.map((v) => v.name));
  return views.map((v) => ({
    ...v,
    deps: viewDependencies(v.sql).filter((d) => d !== v.name && names.has(d)),
  }));
};

/** A temporary migrations folder with an empty journal, plus a fake `drizzle-kit generate --custom`. */
function tempMigrations() {
  const folder = mkdtempSync(path.join(tmpdir(), "platform-p2-views-"));
  mkdirSync(path.join(folder, "meta"));
  const journalPath = path.join(folder, "meta/_journal.json");
  writeFileSync(
    journalPath,
    JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }),
  );
  const generateCustom = vi.fn((name: string) => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: unknown[];
    };
    const idx = journal.entries.length;
    const tag = `${String(idx).padStart(4, "0")}_${name}`;
    journal.entries.push({
      idx,
      version: "7",
      when: 1_793_700_000_000 + idx,
      tag,
      breakpoints: true,
    });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(
      path.join(folder, `${tag}.sql`),
      "-- Custom SQL migration file, put your code below! --\n",
    );
  });
  return { folder, generateCustom };
}

const quiet = { log: () => undefined, error: () => undefined };

describe("views-sql: collection and order", () => {
  it("collects the platform views from the schema index with their SQL", () => {
    const views = collectViews();
    expect(views.map((v) => v.name).sort()).toEqual(
      expect.arrayContaining([
        "v_ai_usage_month",
        "v_integration_health",
        "v_job_stats",
        "v_support_sla",
      ]),
    );
    const statements = viewStatements();
    expect(statements[0]).toMatch(/^create or replace view v_\w+ as\n/);
    expect(statements.every((s) => s.endsWith(";"))).toBe(true);
  });

  it("names a view after its pgView export, or the snake case of the export name", () => {
    const views = collectViews({
      vFooBarSql: "select 1 as x",
      other: 3,
      notSqlSql: 4,
    });
    expect(views).toEqual([
      { name: "v_foo_bar", sql: "select 1 as x", deps: [] },
    ]);
  });

  it("finds v_ and ai. targets of from and join", () => {
    expect(
      viewDependencies(
        "select * from v_a a join lateral v_b b on true left join persons p on true, x from ai.customers",
      ),
    ).toEqual(["ai.customers", "v_a", "v_b"]);
  });

  it("orders views after the views they read, ties by name, and refuses cycles", () => {
    const ordered = orderViews(
      withDeps([
        view("v_c", "select * from v_b"),
        view("v_b", "select * from v_a"),
        view("v_a", "select 1"),
        view("v_0", "select 2"),
      ]),
    );
    expect(ordered.map((v) => v.name)).toEqual(["v_0", "v_a", "v_b", "v_c"]);
    expect(() =>
      orderViews(
        withDeps([
          view("v_x", "select * from v_y"),
          view("v_y", "select * from v_x"),
        ]),
      ),
    ).toThrow(/cycle/);
  });
});

describe("views-sql: --migration and --check", () => {
  it("passes --check and writes nothing when there are no views", async () => {
    const { folder, generateCustom } = tempMigrations();
    expect(
      await main(["--check"], {
        views: [],
        migrationsFolder: folder,
        ...quiet,
      }),
    ).toBe(0);
    expect(
      await main(["--migration", "init_views"], {
        views: [],
        migrationsFolder: folder,
        generateCustom,
        ...quiet,
      }),
    ).toBe(0);
    expect(generateCustom).not.toHaveBeenCalled();
  });

  it("writes new views in dependency order, then --check passes and a second run writes nothing", async () => {
    const { folder, generateCustom } = tempMigrations();
    const views = withDeps([
      view("v_b", "select lane from v_a"),
      view("v_a", "select lane, status from jobs"),
    ]);
    expect(
      await main(["--check"], { views, migrationsFolder: folder, ...quiet }),
    ).toBe(1);
    expect(
      await main(["--migration", "init_views"], {
        views,
        migrationsFolder: folder,
        generateCustom,
        ...quiet,
      }),
    ).toBe(0);
    expect(generateCustom).toHaveBeenCalledWith("init_views");
    const written = readFileSync(
      path.join(folder, "0000_init_views.sql"),
      "utf8",
    );
    expect(written.indexOf("create or replace view v_a")).toBeLessThan(
      written.indexOf("create or replace view v_b"),
    );
    expect(written).toContain("--> statement-breakpoint");
    expect([...previousViewDefinitions(folder).keys()].sort()).toEqual([
      "v_a",
      "v_b",
    ]);
    expect(
      await main(["--check"], { views, migrationsFolder: folder, ...quiet }),
    ).toBe(0);
    expect(
      await main(["--migration", "w04_views"], {
        views,
        migrationsFolder: folder,
        generateCustom,
        ...quiet,
      }),
    ).toBe(0);
    expect(generateCustom).toHaveBeenCalledTimes(1);
  });

  it("detects a changed view and writes only that one", async () => {
    const { folder, generateCustom } = tempMigrations();
    const v1 = withDeps([
      view("v_a", "select lane, status from jobs"),
      view("v_z", "select 1 as one"),
    ]);
    await main(["--migration", "init_views"], {
      views: v1,
      migrationsFolder: folder,
      generateCustom,
      ...quiet,
    });
    const v2 = withDeps([
      view(
        "v_a",
        "select lane, status, count(*)::int as n from jobs group by 1, 2",
      ),
      view("v_z", "select 1 as one"),
    ]);
    expect(
      await main(["--check"], {
        views: v2,
        migrationsFolder: folder,
        ...quiet,
      }),
    ).toBe(1);
    expect(
      await main(["--migration", "w04_views"], {
        views: v2,
        migrationsFolder: folder,
        generateCustom,
        ...quiet,
      }),
    ).toBe(0);
    const written = readFileSync(
      path.join(folder, "0001_w04_views.sql"),
      "utf8",
    );
    expect(written).toContain("create or replace view v_a");
    expect(written).not.toContain("v_z");
    expect(
      await main(["--check"], {
        views: v2,
        migrationsFolder: folder,
        ...quiet,
      }),
    ).toBe(0);
  });

  it("drops and re-creates a view whose columns shrink, with its dependent views", async () => {
    const previous = new Map([
      ["v_a", "select lane, status from jobs"],
      ["v_b", "select lane from v_a"],
    ]);
    const next = withDeps([
      view("v_a", "select lane from jobs"),
      view("v_b", "select lane from v_a"),
    ]);
    const plan = await planViewMigration(next, previous);
    expect(plan.dropped).toEqual(["v_a"]);
    expect(plan.statements).toEqual([
      "drop view if exists v_a cascade;",
      "create or replace view v_a as\nselect lane from jobs;",
      "create or replace view v_b as\nselect lane from v_a;",
    ]);
    expect(plan.warnings).toHaveLength(1);
  });

  it("refuses a --migration name that is not snake_case", async () => {
    expect(
      await main(["--migration", "Bad-Name"], { views: [], ...quiet }),
    ).toBe(1);
  });
});
