import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button, Input } from "@beam/ui";
import { formatDate, formatDateTime, formatMoney, t } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { closePosDay, reopenPosDay } from "@/modules/commerce/actions";
import { businessDayOf, getPosDaySummary } from "@/modules/commerce/queries";

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
 * `/admin/pos/day` (commerce spec 5.1, rule 55; `commerce.sell`): the day's POS totals by method
 * (terminal, cash, bank transfer, euro credit), refunds and order count; the cash float and the
 * expected cash in the drawer; the close state. Close the day with the counted cash (a note when
 * it differs); reopen a closed day (`commerce.refund`).
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

  const rows: [string, number][] = [
    [c("terminal"), totals.terminal],
    [c("cash"), totals.cash],
    [c("bank_transfer"), totals.bank_transfer],
    [c("credit_balance"), totals.credit_balance],
    [c("refunds", { count: totals.refund_count }), -totals.refunds],
  ];
  return (
    <div className="grid max-w-3xl gap-6">
      <header className="grid gap-1">
        <Link href="/admin/pos" className="text-sm underline">{c("back_to_pos")}</Link>
        <h1 className="text-2xl font-semibold">{c("title")}</h1>
        <p className="text-sm text-muted-foreground">{c("intro")}</p>
      </header>
      <div role="status" aria-live="polite">
        {sp.error ? <p className="rounded-md border border-destructive p-3 text-sm">{c("failed", { message: errorText(sp.error) })}</p> : null}
        {sp.closed !== undefined ? <p className="rounded-md border p-3 text-sm">{c("closed_ok", { difference: money(Number(sp.closed)) })}</p> : null}
        {sp.reopened ? <p className="rounded-md border p-3 text-sm">{c("reopened")}</p> : null}
      </div>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          <span>{c("day")}</span>
          <Input type="date" name="day" defaultValue={day} max={today} className="h-11 w-48" />
        </label>
        <Button type="submit" variant="outline" className="min-h-11">{c("show")}</Button>
      </form>

      <section aria-labelledby="pos-day-totals" className="grid gap-2">
        <h2 id="pos-day-totals" className="text-lg font-semibold">
          {formatDate(day, locale, "long")} · {c("status", { status: c(`status_${summary.close.status}`) })}
        </h2>
        {totals.payments === 0 && totals.refund_count === 0 ? <p className="text-sm text-muted-foreground">{c("empty")}</p> : null}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-1">{c("col_method")}</th>
              <th scope="col" className="py-1 text-right">{c("col_amount")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, amount]) => (
              <tr key={label} className="border-b">
                <th scope="row" className="py-2 text-left font-normal">{label}</th>
                <td className="py-2 text-right tabular-nums">{money(amount)}</td>
              </tr>
            ))}
            <tr className="border-b">
              <th scope="row" className="py-2 text-left font-normal">{c("orders")}</th>
              <td className="py-2 text-right tabular-nums">{totals.orders}</td>
            </tr>
          </tbody>
        </table>
        <dl className="grid grid-cols-2 gap-1 text-sm">
          <dt>{c("float")}</dt>
          <dd className="text-right tabular-nums">{money(totals.float)}</dd>
          <dt>{c("cash_refunds")}</dt>
          <dd className="text-right tabular-nums">- {money(totals.cash_refunds)}</dd>
          <dt className="font-semibold">{c("expected")}</dt>
          <dd className="text-right font-semibold tabular-nums" data-testid="pos-expected-cash">{money(expected)}</dd>
        </dl>
      </section>

      {summary.close.status === "closed" ? (
        <section aria-labelledby="pos-day-reopen" className="grid gap-2 rounded-md border p-4">
          <p className="text-sm">
            {c("closed_info", { time: summary.close.closedAt ? formatDateTime(summary.close.closedAt, locale, "short") : "", counted: money(summary.close.countedCashCents ?? 0), difference: money(summary.close.differenceCents ?? 0) })}
          </p>
          {summary.close.note ? <p className="text-sm">{c("closed_note", { note: summary.close.note })}</p> : null}
          <h2 id="pos-day-reopen" className="text-lg font-semibold">{c("reopen_title")}</h2>
          {canReopen ? (
            <form action={onReopen} className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1 text-sm">
                <span>{c("reason")}</span>
                <Input name="reason" required minLength={3} maxLength={500} className="h-11 w-80" />
              </label>
              <Button type="submit" variant="outline" className="min-h-11">{c("reopen")}</Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{c("reopen_forbidden")}</p>
          )}
        </section>
      ) : (
        <section aria-labelledby="pos-day-close" className="grid gap-2 rounded-md border p-4">
          <h2 id="pos-day-close" className="text-lg font-semibold">{c("close_title")}</h2>
          <form action={onClose} className="grid gap-2">
            <label className="grid gap-1 text-sm">
              <span>{c("counted")}</span>
              <Input name="counted" inputMode="decimal" required className="h-11 w-40" autoComplete="off" />
            </label>
            <label className="grid gap-1 text-sm">
              <span>{c("note")}</span>
              <Input name="note" maxLength={1000} className="h-11" />
            </label>
            <Button type="submit" className="min-h-11 w-fit">{c("close")}</Button>
          </form>
        </section>
      )}
    </div>
  );
}
