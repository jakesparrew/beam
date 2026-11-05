/**
 * forms-P10 (R4): the `ai` schema views `ai.form_funnel_daily` and `ai.form_outcomes` expose no
 * person, contact, answer, score or sensitive column (checked on the real database columns, their
 * source columns and the Drizzle declarations); outcome counts below 5 per day and version are
 * merged into `other`; `beam_ai_ro` reads them once `select` is granted; and the dashboard sources
 * `forms.funnel`, `forms.outcomes` and `forms.conversion` return the same totals as `getFormReport`.
 */
import { getViewConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import * as schema from "@beam/db/schema";
import {
  AI_FORM_OUTCOME_MIN_COUNT,
  AI_FORM_OUTCOME_OTHER,
  bookings,
  formSubmissions,
  formVersions,
  formViewsDaily,
  SENSITIVE_COLUMNS,
  type NewFormSubmissionRow,
} from "@beam/db/schema";
import { applyCustomSql, createTestDb, makePerson, makeSession } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { resetRuntime } from "@/lib/testing";
import { FORMS_DASHBOARD_SOURCE_KEYS, FORMS_DASHBOARD_SOURCES, isFormsDashboardSourceKey, loadFormsDashboardSource } from "./dashboard-sources";
import { assessment, createForm, setupEnv } from "./forms-p3.fixtures";
import { getFormReport } from "./queries";

const AI_VIEWS = [
  { name: "form_funnel_daily", typed: schema.aiFormFunnelDaily, ddl: schema.aiFormFunnelDailyDdl },
  { name: "form_outcomes", typed: schema.aiFormOutcomes, ddl: schema.aiFormOutcomesDdl },
] as const;

/** Column names no `ai` view may have (contact, identity, free answers, scores). */
const FORBIDDEN = ["email", "phone", "first_name", "last_name", "name", "address", "answers", "score", "total_score", "ip_hash", "utm", "referrer_url", "landing_path", "embed_host", "consent_snapshot", "payload"];

let h: DbHandle;
const q = async <T>(text: ReturnType<typeof sql>) => rowsOf<T>(await h.db.execute(text));

beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const DAY = 86_400_000;

describe("ai views: no person id, no sensitive column", () => {
  it("both views exist in schema ai with the declared columns, typed and DDL handles alike", async () => {
    for (const v of AI_VIEWS) {
      const typed = getViewConfig(v.typed);
      const ddl = getViewConfig(v.ddl);
      expect(typed.schema).toBe("ai");
      expect(typed.name).toBe(v.name);
      expect(ddl.name).toBe(`ai.${v.name}`);
      const declared = Object.values(typed.selectedFields).map((c) => (c as { name: string }).name);
      expect(Object.values(ddl.selectedFields).map((c) => (c as { name: string }).name)).toEqual(declared);
      const actual = await q<{ column_name: string }>(
        sql`select column_name::text from information_schema.columns where table_schema = 'ai' and table_name = ${v.name} order by ordinal_position`,
      );
      expect(actual.map((c) => c.column_name)).toEqual(declared);
    }
  });

  it("no column is a person reference, a contact field or a SENSITIVE_COLUMNS member", async () => {
    const sensitive = new Set(SENSITIVE_COLUMNS.map((c) => c.column));
    expect(sensitive.size).toBeGreaterThan(0);
    for (const v of AI_VIEWS) {
      const cols = await q<{ column_name: string }>(sql`select column_name::text from information_schema.columns where table_schema = 'ai' and table_name = ${v.name}`);
      expect(cols.length).toBeGreaterThan(0);
      for (const { column_name: c } of cols) {
        expect(c, `ai.${v.name}.${c}`).not.toMatch(/person|email|phone|user|token|sensitive/);
        expect(FORBIDDEN, `ai.${v.name}.${c}`).not.toContain(c);
        expect(sensitive.has(c), `ai.${v.name}.${c} is a SENSITIVE_COLUMNS member`).toBe(false);
      }
    }
  });

  it("no view reads persons.id, a person column or a sensitive table, directly or through another view", async () => {
    type Use = { view_schema: string; view_name: string; table_schema: string; table_name: string; column_name: string };
    const seen = new Set<string>();
    const sources: Use[] = [];
    let frontier: { schema: string; name: string }[] = AI_VIEWS.map((v) => ({ schema: "ai", name: v.name }));
    while (frontier.length) {
      const next: { schema: string; name: string }[] = [];
      for (const f of frontier) {
        if (seen.has(`${f.schema}.${f.name}`)) continue;
        seen.add(`${f.schema}.${f.name}`);
        const uses = await q<Use>(
          sql`select view_schema::text, view_name::text, table_schema::text, table_name::text, column_name::text
              from information_schema.view_column_usage where view_schema = ${f.schema} and view_name = ${f.name}`,
        );
        expect(uses.length, `${f.schema}.${f.name} has source columns`).toBeGreaterThan(0);
        sources.push(...uses);
        const views = await q<{ table_schema: string; table_name: string }>(
          sql`select u.table_schema::text as table_schema, u.table_name::text as table_name from information_schema.view_table_usage u
              join information_schema.views v on v.table_schema = u.table_schema and v.table_name = u.table_name
              where u.view_schema = ${f.schema} and u.view_name = ${f.name}`,
        );
        next.push(...views.map((v) => ({ schema: v.table_schema, name: v.table_name })));
      }
      frontier = next;
    }
    expect(seen.has("public.v_form_funnel_daily")).toBe(true);
    const sensitiveTables = new Set(SENSITIVE_COLUMNS.map((c) => c.table));
    for (const u of sources) {
      const where = `${u.view_schema}.${u.view_name} <- ${u.table_name}.${u.column_name}`;
      expect(u.table_name, where).not.toBe("persons");
      expect(sensitiveTables.has(u.table_name), where).toBe(false);
      expect(u.column_name, where).not.toMatch(/person_id$/);
      expect(["answers", "ip_hash", "utm", "consent_snapshot", "result_token_hash", "resume_token_hash"], where).not.toContain(u.column_name);
    }
  });

  it("beam_ai_ro reads both views once select is granted, and still not the tables behind them", async () => {
    await applyCustomSql(h, { files: ["0100_ai_readonly.sql"] });
    // The grant the custom SQL of the ai schema gives every ai view (forms-P10 request).
    await h.db.execute(sql.raw("grant select on ai.form_funnel_daily, ai.form_outcomes to beam_ai_ro"));
    const asAi = (text: string) =>
      h.db.transaction(async (tx) => {
        await tx.execute(sql.raw("set transaction read only"));
        await tx.execute(sql.raw("set local role beam_ai_ro"));
        await tx.execute(sql.raw("set local search_path = ai"));
        return rowsOf<Record<string, unknown>>(await tx.execute(sql.raw(text)));
      });
    await expect(asAi("select form_slug, day_on, completed from form_funnel_daily limit 1")).resolves.toBeDefined();
    await expect(asAi("select form_slug, outcome_key, completions from form_outcomes limit 1")).resolves.toBeDefined();
    const denied = await asAi("select id from public.form_submissions limit 1").then(
      () => "allowed",
      (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e),
    );
    expect(denied).toMatch(/permission denied/);
  });
});

describe("ai.form_outcomes: no re-identification", () => {
  it(`merges an outcome with fewer than ${AI_FORM_OUTCOME_MIN_COUNT} completions per Brussels day and version into '${AI_FORM_OUTCOME_OTHER}'`, async () => {
    const content = assessment();
    const f = await createForm(h.db, content);
    const [v1] = await h.db.select().from(formVersions).where(eq(formVersions.id, f.versionId));
    const [v2] = await h.db.insert(formVersions).values({ ...v1!, id: undefined, version: 2, definitionHash: "p10-v2", publishedAt: new Date() }).returning();
    const [a, b] = content.scoring.outcomes.map((o) => o.key) as [string, string];
    // 2026-10-10 22:30 UTC is 00:30 on 11 October in Brussels: the Brussels day is the 11th.
    const day1 = new Date("2026-10-10T22:30:00Z");
    const day2 = new Date("2026-10-12T09:00:00Z");
    const done = (at: Date, versionId: string, outcomeKey: string | null, count: number): NewFormSubmissionRow[] =>
      Array.from({ length: count }, (_, i) => ({
        formId: f.formId,
        formVersionId: versionId,
        locale: "en",
        funnel: "form:p10",
        status: "completed" as const,
        startedAt: new Date(at.getTime() + i * 1000),
        completedAt: new Date(at.getTime() + i * 1000 + 60_000),
        outcomeKey,
      }));
    await h.db.insert(formSubmissions).values([
      ...done(day1, v1!.id, a, 5),
      ...done(day1, v1!.id, b, 2),
      ...done(day1, v1!.id, null, 1),
      ...done(day1, v2!.id, b, 4),
      ...done(day2, v1!.id, b, 6),
      // Not completed: never an outcome row.
      { formId: f.formId, formVersionId: v1!.id, locale: "en", funnel: "form:p10", startedAt: day1, status: "started", outcomeKey: a },
    ]);
    const rows = await q<{ form_slug: string; form_version: number; day_on: string; outcome_key: string | null; completions: number }>(
      sql`select form_slug, form_version, to_char(day_on, 'YYYY-MM-DD') as day_on, outcome_key, completions
          from ai.form_outcomes where form_id = ${f.formId} order by day_on, form_version, completions desc`,
    );
    expect(rows).toEqual([
      { form_slug: f.slug, form_version: 1, day_on: "2026-10-11", outcome_key: a, completions: 5 },
      { form_slug: f.slug, form_version: 1, day_on: "2026-10-11", outcome_key: AI_FORM_OUTCOME_OTHER, completions: 3 },
      { form_slug: f.slug, form_version: 2, day_on: "2026-10-11", outcome_key: AI_FORM_OUTCOME_OTHER, completions: 4 },
      { form_slug: f.slug, form_version: 1, day_on: "2026-10-12", outcome_key: b, completions: 6 },
    ]);
    // Every visible outcome group has at least the minimum count, or is `other`; the totals stay exact.
    for (const r of rows) expect(r.outcome_key === AI_FORM_OUTCOME_OTHER || r.completions >= AI_FORM_OUTCOME_MIN_COUNT).toBe(true);
    expect(rows.reduce((n, r) => n + r.completions, 0)).toBe(18);
  });

  it("ai.form_funnel_daily is v_form_funnel_daily with the form's slug and kind", async () => {
    const f = await createForm(h.db, assessment());
    await h.db.insert(formViewsDaily).values({ formId: f.formId, dayOn: "2026-10-20", locale: "en", views: 3 });
    await h.db.insert(formSubmissions).values({ formId: f.formId, formVersionId: f.versionId, locale: "en", funnel: "form:p10", startedAt: new Date("2026-10-20T10:00:00Z") });
    const rows = await q<Record<string, unknown>>(
      sql`select form_slug, form_kind, to_char(day_on, 'YYYY-MM-DD') as day_on, views, started, engaged, completed, abandoned from ai.form_funnel_daily where form_id = ${f.formId}`,
    );
    expect(rows).toEqual([{ form_slug: f.slug, form_kind: "assessment", day_on: "2026-10-20", views: 3, started: 1, engaged: 0, completed: 0, abandoned: 0 }]);
  });
});

describe("dashboard sources", () => {
  const D1 = new Date("2026-09-01T08:00:00Z");
  const D2 = new Date("2026-09-02T08:00:00Z");

  /** The report test's scenario plus enough completions for an outcome to stay unmerged. */
  async function scenario() {
    const content = assessment();
    const f = await createForm(h.db, content);
    const [o1, o2] = content.scoring.outcomes.map((o) => o.key) as [string, string];
    const p1 = await makePerson(h.db);
    const p2 = await makePerson(h.db);
    const base = { formId: f.formId, formVersionId: f.versionId, locale: "en", funnel: "form:p10" } as const;
    const done = (at: Date, i = 0) => ({ status: "completed" as const, startedAt: new Date(at.getTime() + i * 1000), completedAt: new Date(at.getTime() + i * 1000 + 60_000), path: ["about"] });
    await h.db.insert(formSubmissions).values([
      { ...base, ...done(D1), personId: p1.id, outcomeKey: o1 },
      { ...base, ...done(D1, 1), personId: p2.id, outcomeKey: o1 },
      ...Array.from({ length: 4 }, (_, i) => ({ ...base, ...done(D1, i + 2), outcomeKey: o1 })),
      { ...base, ...done(D1, 9), outcomeKey: o2 },
      { ...base, startedAt: D1, status: "abandoned" as const, abandonedAt: new Date(D1.getTime() + DAY), path: ["about"] },
      { ...base, startedAt: D2, status: "started" as const },
      { ...base, startedAt: D2, status: "partial" as const, path: ["about"] },
      // Outside the range.
      { ...base, ...done(new Date("2026-08-01T08:00:00Z")), personId: p1.id, outcomeKey: o2 },
    ]);
    await h.db.insert(formViewsDaily).values([
      { formId: f.formId, dayOn: "2026-09-01", locale: "en", views: 10 },
      { formId: f.formId, dayOn: "2026-09-01", linkKey: "p10flyer", locale: "nl-BE", views: 5 },
      { formId: f.formId, dayOn: "2026-09-02", locale: "en", views: 4 },
      { formId: f.formId, dayOn: "2026-08-01", locale: "en", views: 99 },
    ]);
    const completedAt = D1.getTime() + 60_000;
    const session = await makeSession(h.db);
    await h.db.insert(bookings).values({ sessionId: session.id, personId: p1.id, status: "confirmed", paidWith: "free", source: "portal", createdAt: new Date(completedAt + 5 * DAY) });
    await makeOrder(h.db, { personId: p2.id, channel: "portal", status: "paid", subtotalCents: 4500, vatCents: 0, totalCents: 4500, paidAt: new Date(completedAt + 3 * DAY) });
    return { f, o1, o2 };
  }

  it("declares the three sources with a catalogue label and reports.read", () => {
    expect([...FORMS_DASHBOARD_SOURCE_KEYS].sort()).toEqual(["forms.conversion", "forms.funnel", "forms.outcomes"]);
    for (const key of FORMS_DASHBOARD_SOURCE_KEYS) {
      expect(FORMS_DASHBOARD_SOURCES[key].key).toBe(key);
      expect(FORMS_DASHBOARD_SOURCES[key].label).toMatch(/^forms\.report\./);
      expect(FORMS_DASHBOARD_SOURCES[key].permission).toBe("reports.read");
      expect(isFormsDashboardSourceKey(key)).toBe(true);
    }
    expect(isFormsDashboardSourceKey("forms.answers")).toBe(false);
  });

  it("return the same totals as getFormReport for one form", async () => {
    const { f, o1, o2 } = await scenario();
    const range = { from: "2026-09-01", to: "2026-09-30", formId: f.formId };
    const report = await getFormReport(h.db, { formId: f.formId, from: range.from, to: range.to, groupBy: "day" });
    const funnel = await loadFormsDashboardSource(h.db, "forms.funnel", range);
    const outcomes = await loadFormsDashboardSource(h.db, "forms.outcomes", range);
    const conversion = await loadFormsDashboardSource(h.db, "forms.conversion", range);

    const { views, started, engaged, completed, abandoned, completionRate } = report.totals;
    expect(funnel.totals).toEqual({ views, started, engaged, completed, abandoned, completionRate });
    expect(funnel.totals).toMatchObject({ views: 19, started: 10, completed: 7, abandoned: 1 });
    expect(funnel.series).toHaveLength(30);
    expect(funnel.series.find((p) => p.day === "2026-09-01")).toMatchObject({ views: 15, started: 8, completed: 7 });

    expect(outcomes.completed).toBe(report.outcomes.reduce((n, o) => n + o.count, 0));
    // o1 has 6 completions that day and stays visible; o2's single completion is merged into `other`.
    expect(outcomes.rows.map((r) => [r.key, r.count])).toEqual([
      [o1, 6],
      [AI_FORM_OUTCOME_OTHER, 1],
    ]);
    expect(report.outcomes.find((o) => o.key === o1)?.count).toBe(6);
    expect(report.outcomes.find((o) => o.key === o2)?.count).toBe(1);

    const { linked, booked, purchased, revenueCents, bookingRate, purchaseRate } = report.totals;
    expect(conversion.totals).toEqual({ linked, booked, purchased, revenueCents, bookingRate, purchaseRate });
    expect(conversion.totals).toMatchObject({ linked: 2, booked: 1, purchased: 1, revenueCents: 4500 });
  });

  it("without formId sums every form; a day range of one day counts that day only", async () => {
    const one = await scenario();
    const two = await scenario();
    const range = { from: "2026-09-02", to: "2026-09-02" };
    const all = await loadFormsDashboardSource(h.db, "forms.funnel", range);
    let started = 0;
    for (const s of [one, two]) {
      const r = await getFormReport(h.db, { formId: s.f.formId, from: range.from, to: range.to, groupBy: "day" });
      started += r.totals.started;
    }
    expect(started).toBe(4);
    const [every] = await q<{ n: number }>(
      sql`select count(*)::int as n from form_submissions where (started_at at time zone 'Europe/Brussels')::date = ${range.from}::date`,
    );
    expect(all.series).toHaveLength(1);
    expect(all.totals.started).toBe(every!.n);
    expect(all.totals.started).toBeGreaterThanOrEqual(started);
  });

  it("refuses an invalid or reversed range and an unknown source", async () => {
    await expect(loadFormsDashboardSource(h.db, "forms.funnel", { from: "2026-09-30", to: "2026-09-01" })).rejects.toThrow("invalid_range");
    await expect(loadFormsDashboardSource(h.db, "forms.outcomes", { from: "yesterday", to: "2026-09-01" })).rejects.toThrow("invalid_range");
    await expect(loadFormsDashboardSource(h.db, "forms.conversion", { from: "2020-01-01", to: "2026-01-01" })).rejects.toThrow("invalid_range");
    expect(() => loadFormsDashboardSource(h.db, "forms.answers" as never, { from: "2026-09-01", to: "2026-09-02" })).toThrow("unknown_source");
  });
});
