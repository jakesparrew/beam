import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { Button, Input } from "@beam/ui";
import { addDays } from "@beam/core/booking";
import { formatDate, formatDateTime, formatMoney, t } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { closePosDay, reopenPosDay } from "@/modules/commerce/actions";
import { businessDayOf, getPosDaySummary } from "@/modules/commerce/queries";
import { PageHeader, PeriodSwitch, SecondaryAction, StatusPill, Surface, Toolbar, td, th } from "@/modules/platform/ui/admin-kit";
import { BackLink, fieldClass, Notice } from "@/modules/platform/ui/admin-list-kit";

type Search = Record<string, string | undefined>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const field = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** The error code a failed action shows: the first field code, else the message. */
function errorCode(error: { message: string; fields?: Record<string, string> }): string {
  const [name, code] = Object.entries(error.fields ?? {})[0] ?? [];
  if (name === "note" && code === "required") return "note_required";
  return error.message;
}

/**
 * `/admin/pos/day` (commerce spec 5.1, rule 55; `commerce.sell`), reached from the till: the
 * day's POS totals by method (Kaart (terminal), cash, bank transfer, euro credit, the integrated terminal when used), refunds and order
 * count; the cash float and the expected cash in the drawer; the close state. Close the day with
 * the counted cash (a note when it differs); reopen a closed day (`commerce.refund`). The one-off
 * Lightspeed import is linked from here (it left the menu, owner review November 2026).
 */
export default async function PosDayPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "commerce.sell")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.pos_day.${k}`, p);
  const errorText = (code: string) => (t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error"));
  const money = (n: number) => formatMoney(n, locale);
  const today = businessDayOf(new Date());
  const day = sp.day && DAY.test(sp.day) && sp.day <= today ? sp.day : today;
  const summary = await getPosDaySummary(await getAppDb(), { day });
  const totals = summary.close.frozen ? { ...summary.totals, ...summary.close.frozen } : summary.totals;
  const expected = summary.close.status === "closed" ? totals.float + totals.cash - totals.cash_refunds : summary.expectedCashCents;
  const canReopen = hasPermission(actor, "commerce.refund");
  const dayHref = (d: string) => (d === today ? "/admin/pos/day" : `/admin/pos/day?day=${d}`) as Route;

  async function onClose(form: FormData) {
    "use server";
    const counted = Math.round(Number((field(form, "counted") ?? "").replace(",", ".")) * 100);
    const r = await closePosDay({ businessDayOn: day, countedCashCents: Number.isFinite(counted) ? counted : -1, note: field(form, "note") });
    const q = new URLSearchParams({ day });
    if (r.ok) q.set("closed", String(r.data.differenceCents));
    else q.set("error", errorCode(r.error));
    redirect(`/admin/pos/day?${q.toString()}` as never);
  }
  async function onReopen(form: FormData) {
    "use server";
    const r = await reopenPosDay({ businessDayOn: day, reason: field(form, "reason") ?? "" });
    const q = new URLSearchParams({ day, ...(r.ok ? { reopened: "1" } : { error: errorCode(r.error) }) });
    redirect(`/admin/pos/day?${q.toString()}` as never);
  }

  // Kaart (terminal) is the card taken on a separate terminal; the integrated terminal only shows when used.
  const rows: [string, number][] = [
    [c("card_terminal"), totals.card_terminal ?? 0],
    ...(totals.terminal ? ([[c("terminal"), totals.terminal]] as [string, number][]) : []),
    [c("cash"), totals.cash],
    [c("bank_transfer"), totals.bank_transfer],
    [c("credit_balance"), totals.credit_balance],
    [c("refunds", { count: totals.refund_count }), -totals.refunds],
  ];
  const closed = summary.close.status === "closed";
  return (
    <div className="grid max-w-4xl gap-4">
      <BackLink href="/admin/pos">{tr("commerce.nav.pos")}</BackLink>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            {c("title")}
            <StatusPill tone={closed ? "muted" : "ok"}>{c(`status_${summary.close.status}`)}</StatusPill>
          </span>
        }
        description={c("intro")}
        actions={<SecondaryAction href="/admin/pos/lightspeed">{tr("commerce.nav.lightspeed")}</SecondaryAction>}
      />
      <div role="status" aria-live="polite" className="grid gap-2 empty:hidden">
        {sp.error ? <Notice tone="bad">{c("failed", { message: errorText(sp.error) })}</Notice> : null}
        {sp.closed !== undefined ? <Notice tone="ok">{c("closed_ok", { difference: money(Number(sp.closed)) })}</Notice> : null}
        {sp.reopened ? <Notice tone="ok">{c("reopened")}</Notice> : null}
      </div>
      <Toolbar>
        <PeriodSwitch
          label={formatDate(day, locale, "long")}
          previous={dayHref(addDays(day, -1))}
          next={dayHref(addDays(day, 1) > today ? today : addDays(day, 1))}
          today="/admin/pos/day"
          todayLabel={c("today")}
          previousLabel={c("previous_day")}
          nextLabel={c("next_day")}
        />
        <form data-auto-filter="" method="get">
          <label className="flex items-center gap-2 text-[0.8125rem]">
            <span className="text-muted-foreground">{c("day")}</span>
            <input type="date" name="day" defaultValue={day} max={today} className={`${fieldClass} w-40`} />
          </label>
        </form>
      </Toolbar>

      <div className="grid items-start gap-4 md:grid-cols-2">
        <Surface flush aria-labelledby="pos-day-totals">
          <h2 id="pos-day-totals" className="border-b border-border px-5 py-3 text-[0.8125rem] font-semibold">
            {formatDate(day, locale, "long")} · {c("status", { status: c(`status_${summary.close.status}`) })}
          </h2>
          {totals.payments === 0 && totals.refund_count === 0 ? <p className="px-5 pt-3 text-[0.8125rem] text-muted-foreground">{c("empty")}</p> : null}
          <table className="w-full text-[0.8125rem]">
            <thead className="bg-[#faf9f6]">
              <tr className="border-b border-border">
                <th scope="col" className={th}>{c("col_method")}</th>
                <th scope="col" className={`${th} text-right`}>{c("col_amount")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, amount]) => (
                <tr key={label} className="border-b border-border">
                  <th scope="row" className={`${td} text-left font-normal`}>{label}</th>
                  <td className={`${td} text-right font-semibold tabular-nums`}>{money(amount)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row" className={`${td} text-left font-normal`}>{c("orders")}</th>
                <td className={`${td} text-right font-semibold tabular-nums`}>{totals.orders}</td>
              </tr>
            </tbody>
          </table>
        </Surface>

        <div className="grid gap-4">
          <Surface className="p-4">
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[0.8125rem]">
              <dt className="text-muted-foreground">{c("float")}</dt>
              <dd className="text-right tabular-nums">{money(totals.float)}</dd>
              <dt className="text-muted-foreground">{c("cash")}</dt>
              <dd className="text-right tabular-nums">{money(totals.cash)}</dd>
              <dt className="text-muted-foreground">{c("cash_refunds")}</dt>
              <dd className="text-right tabular-nums">- {money(totals.cash_refunds)}</dd>
              <dt className="border-t border-border pt-1.5 font-semibold">{c("expected")}</dt>
              <dd className="border-t border-border pt-1.5 text-right text-[1.125rem] font-semibold tabular-nums" data-testid="pos-expected-cash">
                {money(expected)}
              </dd>
            </dl>
          </Surface>

          {closed ? (
            <Surface aria-labelledby="pos-day-reopen" className="grid gap-2 p-4">
              <p className="text-[0.8125rem]">
                {c("closed_info", { time: summary.close.closedAt ? formatDateTime(summary.close.closedAt, locale, "short") : "", counted: money(summary.close.countedCashCents ?? 0), difference: money(summary.close.differenceCents ?? 0) })}
              </p>
              {summary.close.note ? <p className="text-[0.8125rem] text-muted-foreground">{c("closed_note", { note: summary.close.note })}</p> : null}
              <h2 id="pos-day-reopen" className="text-[0.9375rem] font-semibold">{c("reopen_title")}</h2>
              {canReopen ? (
                <form action={onReopen} className="flex flex-wrap items-end gap-2">
                  <label className="grid flex-1 gap-1 text-[0.8125rem]">
                    <span>{c("reason")}</span>
                    <Input name="reason" required minLength={3} maxLength={500} className="h-11" />
                  </label>
                  <Button type="submit" variant="outline" className="min-h-11">{c("reopen")}</Button>
                </form>
              ) : (
                <p className="text-[0.8125rem] text-muted-foreground">{c("reopen_forbidden")}</p>
              )}
            </Surface>
          ) : (
            <Surface aria-labelledby="pos-day-close" className="grid gap-3 p-4">
              <h2 id="pos-day-close" className="text-[0.9375rem] font-semibold">{c("close_title")}</h2>
              <form action={onClose} className="grid gap-2">
                <label className="grid gap-1 text-[0.8125rem]">
                  <span>{c("counted")}</span>
                  <Input name="counted" inputMode="decimal" required className="h-11 w-40" autoComplete="off" />
                </label>
                <label className="grid gap-1 text-[0.8125rem]">
                  <span>{c("note")}</span>
                  <Input name="note" maxLength={1000} className="h-11" />
                </label>
                <Button type="submit" className="min-h-11 w-fit">{c("close")}</Button>
              </form>
            </Surface>
          )}
        </div>
      </div>
    </div>
  );
}
