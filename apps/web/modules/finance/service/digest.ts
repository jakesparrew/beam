/**
 * The finance section of ops' daily digest (finance spec 4.1 `getFinanceDigest`, rules 16 and
 * 35, finance-P5): Billit documents that failed and that have been failing for longer than
 * `settings.finance.alert_after_minutes`, pending pushes, PDF failures, overdue open invoices,
 * the last reconcile run and the documents of `day` rendered in the nl-BE fallback. Counts and
 * amounts only: no names, emails or numbers of customers. Labels are `finance.digest.*` in `en`
 * (the digest goes to the internal team, like the platform section).
 */
import type { DbOrTx } from "@beam/db";
import { billitReconcileRuns } from "@beam/db/schema";
import { formatMoney, t, type MessageParams } from "@beam/core/i18n";
import { desc, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import type { DigestSection } from "@/modules/platform/api";

type Level = DigestSection["lines"][number]["level"];

const label = (key: string, params?: MessageParams) => t("en", `finance.digest.${key}`, params);
const n = (v: unknown) => Number(v ?? 0);

export type FinanceDigestCounts = {
  billitFailed: number;
  billitFailing: number;
  billitPending: number;
  pdfFailed: number;
  overdueCount: number;
  overdueCents: number;
  fallbackCount: number;
  lastReconcile: { runOn: string; status: "ok" | "issues" | "failed"; issuesCount: number } | null;
};

/** The numbers behind the section (also used by the overview screen's tests). */
export async function financeDigestCounts(db: DbOrTx, day: string): Promise<FinanceDigestCounts> {
  const settings = await getSetting(db, "finance");
  const alertAfter = settings.alert_after_minutes;
  const [billit] = rowsOf<{ failed: number; failing: number; pending: number }>(
    await db.execute(sql`select
        count(*) filter (where billit_status = 'failed')::int as failed,
        count(*) filter (where billit_status = 'failed' and failing_minutes >= ${alertAfter})::int as failing,
        count(*) filter (where billit_status = 'pending')::int as pending
      from v_finance_billit_backlog`),
  );
  const [pdf] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from invoices where pdf_status = 'failed'`));
  const [overdue] = rowsOf<{ n: number; cents: number }>(
    await db.execute(sql`select count(*)::int as n, coalesce(sum(amount_due_cents), 0)::int as cents from v_finance_open_invoices where days_overdue > 0`),
  );
  // Rule 16: a document whose customer's language is not nl-BE but which was issued in nl-BE.
  const [fallback] = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n
      from invoices i
      join orders o on o.id = i.order_id
      left join persons p on p.id = i.person_id
      where i.issued_on = ${day}::date and i.locale = 'nl-BE'
        and coalesce(p.locale::text, o.locale::text, 'nl-BE') <> 'nl-BE'`),
  );
  const [run] = await db
    .select({ runOn: billitReconcileRuns.runOn, status: billitReconcileRuns.status, issuesCount: billitReconcileRuns.issuesCount })
    .from(billitReconcileRuns)
    .orderBy(desc(billitReconcileRuns.runOn))
    .limit(1);
  return {
    billitFailed: n(billit?.failed),
    billitFailing: n(billit?.failing),
    billitPending: n(billit?.pending),
    pdfFailed: n(pdf?.n),
    overdueCount: n(overdue?.n),
    overdueCents: n(overdue?.cents),
    fallbackCount: n(fallback?.n),
    lastReconcile: run ? { runOn: String(run.runOn), status: run.status, issuesCount: run.issuesCount } : null,
  };
}

/** For ops.daily_digest (`day` is the Brussels date of the digest). Ids and counts only. */
export async function getFinanceDigest(db: DbOrTx, day: string): Promise<DigestSection> {
  const c = await financeDigestCounts(db, day);
  const reconcileLevel: Level = !c.lastReconcile ? "warn" : c.lastReconcile.status === "failed" ? "alert" : c.lastReconcile.status === "issues" ? "warn" : "ok";
  const lines: DigestSection["lines"] = [
    { label: label("billit_failed"), value: String(c.billitFailed), level: c.billitFailed > 0 ? "warn" : "ok" },
    { label: label("billit_failing"), value: String(c.billitFailing), level: c.billitFailing > 0 ? "alert" : "ok" },
    { label: label("billit_pending"), value: String(c.billitPending), level: "ok" },
    { label: label("pdf_failed"), value: String(c.pdfFailed), level: c.pdfFailed > 0 ? "alert" : "ok" },
    {
      label: label("overdue"),
      value: label("overdue_value", { count: c.overdueCount, amount: formatMoney(c.overdueCents, "en") }),
      level: c.overdueCount > 0 ? "warn" : "ok",
    },
    {
      label: label("last_reconcile"),
      value: c.lastReconcile
        ? label("last_reconcile_value", { date: c.lastReconcile.runOn, status: label(`reconcile_${c.lastReconcile.status}`), issues: c.lastReconcile.issuesCount })
        : label("never"),
      level: reconcileLevel,
    },
    { label: label("locale_fallback"), value: String(c.fallbackCount), level: c.fallbackCount > 0 ? "warn" : "ok" },
  ];
  return { title: label("title"), lines };
}
