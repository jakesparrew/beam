/**
 * `pnpm db:seed` / `pnpm seed:demo` (runbook 3.4 and 6, BS-11, PL-79, edge case 28).
 *
 * Profiles: `defaults` runs every module's `packages/db/src/seed/<m>.ts` through
 * `seedDefaults(db, { permissions: PERMISSIONS })`, so role grants follow the generated
 * permission registry. `demo` runs `defaults` first, then `DEMO_SEEDS`
 * (`apps/web/modules/<m>/seed.ts`, in `after` order), then the job runner until no due fast job
 * is left, so seeded orders, invoices and emails are processed. Without `--profile`, production
 * runs `defaults` only and every other environment runs `demo`.
 *
 * The demo profile refuses before any write when `APP_ENV=production`, or when `persons` holds
 * more than 500 rows with `is_tester = false` (a real database). It is deterministic (`rand` is
 * seeded with 20261103, `now` is the start of the Brussels day) and idempotent: module seeds
 * find their rows by natural keys, so a second run prints "0 created" for every module.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startOfDay } from "date-fns";
import { TZDate } from "@date-fns/tz";
import type { Db, DbOrTx, Tx } from "@beam/db";
import { seedDefaults } from "@beam/db/seed";
import { TIME_ZONE } from "@beam/core/i18n";
import { createCtx, flushDurableWrites, flushIntegrationLog, sql, type Ctx } from "@/lib/ctx";
import { runJobs } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { PERMISSIONS } from "@/registry/permissions.generated";
import { DEMO_SEEDS } from "@/registry/seeds.generated";

export type SeedProfile = "defaults" | "demo";

/** Ids created by one module seed and looked up by later ones (`ids.get('crm.person.lotte-peeters')`). */
export type DemoIds = Map<string, string>;

/** What a demo seed's `run` receives (runbook 3.4). `db` is the module's own transaction. */
export type SeedCtx = {
  db: DbOrTx;
  /** A system-actor context on the same transaction. */
  ctx: Ctx;
  /** The start of the current Brussels day; demo dates are relative to it. */
  now: Date;
  /** Deterministic PRNG in [0, 1), seeded with `DEMO_PRNG_SEED`. */
  rand: () => number;
  ids: DemoIds;
};

/** The shape of a `modules/<m>/seed.ts` `seed` export as listed in `DEMO_SEEDS`. */
export type DemoSeed = { module: string; after: readonly string[]; run: (s: SeedCtx) => Promise<unknown> };

export const DEMO_PRNG_SEED = 20261103;
/** Edge case 28: more real persons than this means the database is not a demo database. */
export const MAX_NON_TESTER_PERSONS = 500;

export class DemoSeedRefusedError extends Error {
  override readonly name = "DemoSeedRefusedError";
}

/** mulberry32: small, fast and deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The start of the Brussels calendar day of `at`, as an instant. */
export function brusselsDayStart(at: Date): Date {
  return new Date(startOfDay(new TZDate(at.getTime(), TIME_ZONE)).getTime());
}

export function parseProfile(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): SeedProfile {
  const at = argv.indexOf("--profile");
  const given = at >= 0 ? argv[at + 1] : argv.find((a) => a.startsWith("--profile="))?.slice("--profile=".length);
  if (given === undefined) return env.APP_ENV === "production" ? "defaults" : "demo";
  if (given !== "defaults" && given !== "demo") throw new Error(`--profile must be "defaults" or "demo", got "${given}"`);
  return given;
}

/** PL-79 and edge case 28: throws before any write when the demo profile must not run. */
export async function assertDemoAllowed(db: DbOrTx, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  if (env.APP_ENV === "production") throw new DemoSeedRefusedError("demo seed refused: APP_ENV=production");
  const [row] = rowsOf<{ n: number | string }>(await db.execute(sql`select count(*)::int as n from persons where not is_tester`));
  const realPersons = Number(row?.n ?? 0);
  if (realPersons > MAX_NON_TESTER_PERSONS) {
    throw new DemoSeedRefusedError(`demo seed refused: ${realPersons} persons are not testers (more than ${MAX_NON_TESTER_PERSONS}); this is not a demo database`);
  }
}

/** One query that sums the rows of every base table except `jobs` (for the per-module line). */
async function totalRows(db: DbOrTx): Promise<number> {
  const tables = rowsOf<{ t: string }>(
    await db.execute(sql`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'jobs' order by table_name`),
  ).map((r) => r.t);
  if (!tables.length) return 0;
  const parts = tables.map((t) => sql`select count(*)::bigint as c from ${sql.identifier(t)}`);
  const [row] = rowsOf<{ n: number | string | null }>(await db.execute(sql`select coalesce(sum(c), 0)::bigint as n from (${sql.join(parts, sql` union all `)}) s`));
  return Number(row?.n ?? 0);
}

export type SeedRunOptions = {
  profile: SeedProfile;
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to the generated `DEMO_SEEDS` (tests pass fixture seeds). */
  seeds?: readonly DemoSeed[];
  /** Run the job runner after the demo seeds (default true). */
  runJobsAfter?: boolean;
  /** Overall budget of the job runner loop. */
  jobsBudgetMs?: number;
  /** The instant `now` is derived from (default the current time). */
  clock?: Date;
  log?: (line: string) => void;
};

export type SeedRunReport = { defaults: string[]; demo: { module: string; created: number }[]; jobs: { succeeded: number; retried: number; dead: number } };

async function drainFastJobs(db: Db, budgetMs: number): Promise<SeedRunReport["jobs"]> {
  const started = Date.now();
  const totals = { succeeded: 0, retried: 0, dead: 0 };
  while (Date.now() - started < budgetMs) {
    const summary = await runJobs({ db, budgetMs: Math.max(1_000, budgetMs - (Date.now() - started)) });
    totals.succeeded += summary.succeeded;
    totals.retried += summary.retried;
    totals.dead += summary.dead;
    const [due] = rowsOf<{ n: number | string }>(
      await db.execute(sql`select count(*)::int as n from jobs where status = 'pending' and lane = 'fast' and run_at <= now()`),
    );
    if (Number(due?.n ?? 0) === 0) break;
  }
  return totals;
}

/** Runs the profile against `db`. Throws `DemoSeedRefusedError` before any write when refused. */
export async function runSeed(db: Db, opts: SeedRunOptions): Promise<SeedRunReport> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  if (opts.profile === "demo") await assertDemoAllowed(db, env);

  const report: SeedRunReport = { defaults: [], demo: [], jobs: { succeeded: 0, retried: 0, dead: 0 } };
  report.defaults = await seedDefaults(db, { permissions: PERMISSIONS });
  log(`defaults: ${report.defaults.join(", ")}`);
  if (opts.profile === "defaults") return report;

  const seeds = opts.seeds ?? (DEMO_SEEDS as unknown as readonly DemoSeed[]);
  const now = brusselsDayStart(opts.clock ?? new Date());
  const rand = seededRandom(DEMO_PRNG_SEED);
  const ids: DemoIds = new Map();
  for (const s of seeds) {
    const before = await totalRows(db);
    let ctx: Ctx | undefined;
    await db.transaction(async (tx: Tx) => {
      ctx = createCtx({ tx, actor: { kind: "system", jobId: `seed:${s.module}` }, requestId: `seed:${s.module}`, now });
      await s.run({ db: tx, ctx, now, rand, ids });
    });
    if (ctx) {
      await flushDurableWrites(db, ctx);
      await flushIntegrationLog(db, ctx);
    }
    const created = (await totalRows(db)) - before;
    report.demo.push({ module: s.module, created });
    log(`${s.module}: ${created} created`);
  }

  if (opts.runJobsAfter ?? true) {
    report.jobs = await drainFastJobs(db, opts.jobsBudgetMs ?? 120_000);
    log(`jobs: ${report.jobs.succeeded} succeeded, ${report.jobs.retried} retried, ${report.jobs.dead} dead`);
  }
  return report;
}

async function main(argv: string[]): Promise<number> {
  const { config } = await import("dotenv");
  config({ path: ["../../.env.local", "../../.env", ".env.local"], quiet: true });
  const profile = parseProfile(argv);
  const { getDbHandle } = await import("@beam/db");
  const handle = await getDbHandle();
  try {
    await runSeed(handle.db, { profile });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await handle.close();
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
