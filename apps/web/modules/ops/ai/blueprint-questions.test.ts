/**
 * ops-P10 (coverage critic, round 1): the six example questions of blueprint 40 on the full demo
 * seed. Each has a recorded SQL answer that the fake gateway returns; the answer passes
 * `validateAiSql`, runs as `beam_ai_ro` through the real `answerQuestion` flow and returns at
 * least one row, with no sensitive, email or phone column. A question whose data the `ai`
 * schema lacks is a bug in `0101_ai_views_ops.sql`.
 *
 * The SQL anchors "this year", "September versus August" and "this week" on the demo data (the
 * latest paid order), not on the database clock, so the recorded answers hold on any test day.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db, DbHandle } from "@beam/db";
import { dpiaRecords, featureFlags, nlQuestions, SENSITIVE_COLUMNS } from "@beam/db/schema";
import { DPIA_KEYS, type DpiaKey } from "@beam/core/ops";
import { SENSITIVE_FIELD_KEYS } from "@beam/core/privacy";
import { applyCustomSql, createTestDb, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import type { ClaudeRequest } from "@beam/integrations/anthropic";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: () => undefined }));
vi.stubEnv("APP_ENV", "local");
vi.stubEnv("INTEGRATIONS", "fake");
vi.stubEnv("APP_URL", "https://app.example.com");
vi.stubEnv("AUTH_SECRET", "ops-p10-blueprint-auth-secret-0123456789");
vi.stubEnv("SENSITIVE_DATA_KEY_V1", Buffer.alloc(32, 9).toString("base64"));
vi.stubEnv("VOUCHER_CODE_SECRET", "ops-p10-blueprint-voucher-secret-012345");

const { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime } = await import("@/lib/testing");
const { runSeed } = await import("@/scripts/seed-demo");
const { answerQuestion, EXPLAIN_SYSTEM_PREFIX } = await import("./ask");
const { validateAiSql } = await import("@beam/core/ops");
const { runRefreshPersonStats } = await import("../stats/jobs");
const { sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");

/** 12:00 Brussels on a Thursday; the demo seed's dates are relative to the start of this day. */
const NOW = new Date("2026-10-15T10:00:00.000Z");
/** The latest paid order: the demo's "now" for the recorded answers. */
const ANCHOR = "(select max(paid_at) from ai.orders)";

const QUESTIONS: { key: string; question: string; sql: string }[] = [
  {
    key: "top_revenue",
    question: "Which customers generated the most revenue this year?",
    sql: `select c.person_id, c.first_name, sum(o.total_cents) as revenue_cents, count(*) as orders
from ai.orders o join ai.customers c on c.person_id = o.person_id
where o.status in ('paid', 'partially_refunded', 'refunded')
  and o.paid_at >= date_trunc('year', ${ANCHOR})
group by c.person_id, c.first_name
order by revenue_cents desc
limit 10`,
  },
  {
    key: "best_campaign",
    question: "Which campaign brought in the highest-value customers?",
    sql: `select coalesce(acquisition_campaign, acquisition_source, 'direct') as campaign, count(*) as customers,
       round(avg(revenue_cents)) as avg_revenue_cents, sum(revenue_cents) as revenue_cents
from ai.customers
where purchases > 0
group by 1
order by avg_revenue_cents desc`,
  },
  {
    key: "no_repurchase",
    question: "Who bought a 10-session package and did not repurchase?",
    sql: `select g.person_id, c.first_name, g.product_sku, g.status, g.remaining_units, g.starts_at
from ai.grants g
join ai.customers c on c.person_id = g.person_id
join ai.products p on p.product_id = g.product_id
where g.source = 'purchase' and p.kind = 'package' and p.credit_units = 10
  and not exists (select 1 from ai.grants g2 where g2.person_id = g.person_id and g2.credit_kind = g.credit_kind
                  and g2.source = 'purchase' and g2.starts_at > g.starts_at)
  and (g.status in ('exhausted', 'expired') or g.remaining_units <= 2 or g.last_used_at is not null)
order by g.starts_at`,
  },
  {
    key: "month_change",
    question: "How does revenue in September compare with August, and which product kinds changed most?",
    sql: `with y as (select extract(year from ${ANCHOR})::int as y),
m as (
  select r.product_kind,
         coalesce(sum(r.gross_cents - r.refunds_cents) filter (where r.day_on >= make_date(y.y, 9, 1) and r.day_on < make_date(y.y, 10, 1)), 0) as september_cents,
         coalesce(sum(r.gross_cents - r.refunds_cents) filter (where r.day_on >= make_date(y.y, 8, 1) and r.day_on < make_date(y.y, 9, 1)), 0) as august_cents
  from ai.revenue r cross join y
  group by r.product_kind
)
select product_kind, september_cents, august_cents, september_cents - august_cents as change_cents
from m
where september_cents <> 0 or august_cents <> 0
order by greatest(september_cents - august_cents, august_cents - september_cents) desc`,
  },
  {
    key: "b2b_attention",
    question: "Which B2B opportunities need attention?",
    sql: `select opportunity_id, company_name, stage, value_cents, probability_pct, next_action_at, expected_close_on
from ai.opportunities
where stage not in ('won', 'lost')
  and (next_action_at is null or next_action_at < ${ANCHOR} + interval '7 days'
       or expected_close_on < (${ANCHOR})::date + 30
       or stage_entered_at < ${ANCHOR} - interval '30 days')
order by value_cents desc, opportunity_id`,
  },
  {
    key: "contact_week",
    question: "Which 50 customers should we contact this week?",
    sql: `with ranked as (
  select r.person_id, max(r.score) as score, string_agg(r.reason, ', ' order by r.score desc) as reasons
  from ai.retention_candidates r
  group by r.person_id
)
select ranked.person_id, c.first_name, ranked.score, ranked.reasons, c.days_since_activity, c.revenue_cents
from ranked join ai.customers c on c.person_id = ranked.person_id
order by ranked.score desc, c.revenue_cents desc
limit 50`,
  },
];

const FORBIDDEN = new Set<string>([...SENSITIVE_COLUMNS.map((c) => c.column), ...SENSITIVE_FIELD_KEYS, "email", "phone", "last_name", "address", "notes", "answers", "birth_date"]);

/**
 * The demo seed holds a few orders of one day and no packages or opportunities, so the test tops
 * it up through the shared factories (prefix `ops-p10`): paid orders in August, September and
 * October for six demo customers, a bought 10-session package each (two used up), one expiring
 * package, and one open B2B opportunity of a demo company (crm has no opportunity factory).
 */
async function topUpDemo(): Promise<void> {
  const people = rowsOf<{ id: string }>(await db.execute(sql`select id from persons where email like 'crm-demo-%' order by email limit 6`));
  expect(people.length).toBe(6);
  const [pkg] = rowsOf<{ id: string }>(await db.execute(sql`select id from products where kind = 'package' and credit_units = 10 limit 1`));
  const at = (iso: string) => new Date(`${iso}T10:00:00Z`);
  for (const [i, p] of people.entries()) {
    for (const day of ["2026-08-1", "2026-09-1", "2026-10-0"]) {
      await makePaidOrder(db, { personId: p.id, lines: [{ unitAmountCents: 4_500 + i * 1_000 }], order: { paidAt: at(`${day}${i + 1}`) } });
    }
    const bought = await makePaidOrder(db, { personId: p.id, lines: [{ productId: pkg!.id, unitAmountCents: 15_000 }], order: { paidAt: at("2026-05-02") } });
    await makeCreditGrant(db, {
      personId: p.id,
      productId: pkg!.id,
      orderLineId: bought.lines[0]!.id,
      lineUnitIndex: 1,
      source: "purchase",
      units: 10,
      startsAt: at("2026-05-02"),
      expiresAt: i === 5 ? new Date(Date.now() + 10 * 86_400_000) : at("2027-05-02"),
      ...(i < 2 ? { status: "exhausted" as const } : {}),
    });
  }
  const [seeded] = rowsOf<{ id: string }>(await db.execute(sql`select id from companies order by name limit 1`));
  const company = seeded ?? rowsOf<{ id: string }>(await db.execute(sql`insert into companies (name) values ('ops-p10 Example BV') returning id`))[0]!;
  const owner = await makeUser(db, { roleKey: "sales", email: "ops-p10-sales@example.com" });
  await db.execute(sql`insert into opportunities (company_id, title, stage, value_cents, probability_pct, owner_user_id, next_action_at, expected_close_on)
    values (${company.id}, 'ops-p10 corporate wellness pilot', 'proposal', 480000, 40, ${owner.id}, '2026-10-01T09:00:00Z', '2026-10-31')`);
}

let handle: DbHandle;
let db: Db;
let userId: string;

beforeAll(async () => {
  handle = await createTestDb();
  db = handle.db;
  makeCtx(db, { integrations: createFakeIntegrations() });
  await runSeed(db, { profile: "demo", env: { APP_ENV: "local" }, clock: NOW, runJobsAfter: true, jobsBudgetMs: 30_000, log: () => undefined });
  await applyCustomSql(handle, { files: ["0100_ai_readonly.sql", "0101_ai_views_ops.sql"] });
  // The demo seed marks every demo person a tester, and the `ai` schema leaves testers out (ops
  // spec 2.4): the demo people become ordinary customers here, then the nightly stats run.
  await db.execute(sql`update persons set is_tester = false where is_tester and email like '%@example.com'`);
  await topUpDemo();
  await runRefreshPersonStats(makeJobCtx(db, "ops.refresh_person_stats", { now: NOW }), {});
  await db.insert(featureFlags).values({ key: "ff_ops_ai", state: "on" }).onConflictDoUpdate({ target: featureFlags.key, set: { state: "on" } });
  // The questions that rank customers need the `ai_customer_ranking` DPIA (rule 70).
  await db
    .insert(dpiaRecords)
    .values({ key: "ai_customer_ranking", status: "approved", decisionNote: "Approved for the blueprint questions test." })
    .onConflictDoUpdate({ target: dpiaRecords.key, set: { status: "approved", decisionNote: "Approved for the blueprint questions test." } });
  userId = (await makeUser(db, { roleKey: "owner", locale: "en" })).id;
}, 300_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  resetRuntime();
  await handle?.close();
});

describe("blueprint 40: the six example questions", () => {
  it.each(QUESTIONS)("$key: the recorded SQL passes validateAiSql and returns rows as beam_ai_ro", async ({ question, sql }) => {
    const approved = Object.fromEntries(DPIA_KEYS.map((k) => [k, k === "ai_customer_ranking"])) as Record<DpiaKey, boolean>;
    const checked = validateAiSql(sql, { dpiaApproved: approved });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });

    const fakes = createFakeIntegrations();
    fakes.anthropic.script("ai.answer_question", (req: ClaudeRequest) => (req.system.startsWith(EXPLAIN_SYSTEM_PREFIX) ? { explanation: "Recorded explanation." } : { sql }));
    const [row] = await db.insert(nlQuestions).values({ userId, question, status: "error" }).returning({ id: nlQuestions.id });
    const out = await answerQuestion(makeJobCtx(db, "ai.answer_question", { integrations: fakes, now: NOW }), row!.id);

    expect({ status: out.status, explanation: out.status === "answered" ? null : out.explanation }).toEqual({ status: "answered", explanation: null });
    expect(out.rows.length, `${question}: no rows`).toBeGreaterThan(0);
    expect(out.rows.length).toBeLessThanOrEqual(200);
    for (const c of out.columns) {
      expect(FORBIDDEN.has(c), c).toBe(false);
      expect(c).not.toMatch(/email|phone|last_name/);
    }
  });
});
