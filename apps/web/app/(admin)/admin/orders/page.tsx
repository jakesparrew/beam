import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { ORDER_CHANNELS, ORDER_STATUSES, type OrderChannel, type OrderStatus } from "@beam/core/commerce";
import { formatDateTime, formatMoney } from "@beam/core/i18n";
import { zonedTimeToUtc } from "@beam/core/platform";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getAttentionFeed, listOrders } from "@/modules/commerce/queries";
import { PageHeader, PrimaryAction, SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Disclosure, Field, fieldClass, Initials, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";
import { AttentionTable } from "./attention-table";

type Search = { q?: string; status?: string; channel?: string; from?: string; to?: string; cursor?: string };

/** The status tabs; `attention` is the payment follow-up feed, not an order status. */
const TABS = ["attention", "pending_payment", "paid", "refunded"] as const;
const STATUS_TONE: Record<OrderStatus, Tone> = { draft: "muted", pending_payment: "warn", paid: "ok", cancelled: "muted", expired: "muted", refunded: "info", partially_refunded: "info" };

/** `YYYY-MM-DD` as the start of that Brussels day. */
function dayStart(value: string | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc({ year, month, day, hour: 0, minute: 0 });
}

/**
 * `/admin/orders` (commerce spec 5.1; `commerce.sell`, `commerce.refund` or `invoices.read`;
 * "Bestellingen & betalingen" in the menu): the orders with reference, date, person or company,
 * channel, status, total and paid; a wide search on reference, email or name; status tabs with
 * "Op te volgen" (`?status=attention`: the failed and pending payments of
 * `/admin/orders/attention`, with their number, for `commerce.sell` or `reports.read`); channel,
 * other statuses and dates behind "Filters"; 50 per page (keyset).
 */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  if (!["commerce.sell", "commerce.refund", "invoices.read"].some((p) => hasPermission(actor, p as "commerce.sell"))) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_orders.${k}`, p);
  const canAttention = hasPermission(actor, "commerce.sell") || hasPermission(actor, "reports.read");
  const attentionView = sp.status === "attention" && canAttention;
  const status = (ORDER_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as OrderStatus) : undefined;
  const channel = (ORDER_CHANNELS as readonly string[]).includes(sp.channel ?? "") ? (sp.channel as OrderChannel) : undefined;
  const from = dayStart(sp.from);
  const toStart = dayStart(sp.to);
  const to = toStart ? new Date(toStart.getTime() + 86_400_000) : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const db = await getAppDb();
  // ponytail: the tab count reads the whole feed (at most 500 rows); a count query if the feed grows.
  const [{ rows, nextCursor }, attention] = await Promise.all([
    attentionView
      ? Promise.resolve({ rows: [], nextCursor: null })
      : listOrders(db, {
          ...(status ? { status } : {}),
          ...(channel ? { channel } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(q ? { q } : {}),
          ...(sp.cursor ? { cursor: sp.cursor } : {}),
        }),
    canAttention ? getAttentionFeed(db, { limit: 500 }) : Promise.resolve([]),
  ]);
  const needle = q?.toLowerCase();
  const attentionRows = attention.filter((r) => (!channel || r.channel === channel) && (!needle || [r.reference, r.personName, r.personEmail].some((v) => v?.toLowerCase().includes(needle))));
  const canSell = hasPermission(actor, "commerce.sell");

  const tab = attentionView ? "attention" : status;
  const current: Record<string, string | undefined> = { q, status: tab, channel, from: from ? sp.from : undefined, to: toStart ? sp.to : undefined };
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/orders?${s}` : "/admin/orders";
  };
  const otherStatus = status && !(TABS as readonly string[]).includes(status);
  const moreFilters = [channel, current.from, current.to, otherStatus ? status : undefined].filter(Boolean).length;

  return (
    <div className="grid gap-4">
      <PageHeader title={tr("platform.nav.orders")} description={c("subtitle")} actions={canSell ? <PrimaryAction href="/admin/orders/new">+ {c("new")}</PrimaryAction> : null} />
      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          <SearchField label={c("search")} placeholder={c("search")} defaultValue={q} />
          <Segmented
            label={c("filter_status")}
            items={[
              { key: "all", label: tr("commerce.common.all"), href: href({ status: undefined }), active: !tab },
              ...TABS.filter((t) => t !== "attention" || canAttention).map((t) => ({
                key: t,
                label: t === "attention" ? c("tab_attention") : tr(`commerce.order_status.${t}`),
                href: href({ status: t }),
                active: tab === t,
                ...(t === "attention" ? { count: attention.length } : {}),
              })),
            ]}
          />
          <Disclosure label={c("filters")} count={moreFilters} clear={moreFilters ? { href: href({ channel: undefined, from: undefined, to: undefined, status: otherStatus ? undefined : tab }), label: tr("commerce.common.clear_filters") } : null}>
            <Field label={c("filter_status")}>
              <select name="status" defaultValue={tab ?? ""} className={fieldClass}>
                <option value="">{tr("commerce.common.all")}</option>
                {canAttention ? <option value="attention">{c("tab_attention")}</option> : null}
                {ORDER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {tr(`commerce.order_status.${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={c("filter_channel")}>
              <select name="channel" defaultValue={channel ?? ""} className={fieldClass}>
                <option value="">{tr("commerce.common.all")}</option>
                {ORDER_CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {tr(`commerce.channel.${ch}`)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={c("from")}>
                <input type="date" name="from" defaultValue={current.from ?? ""} className={fieldClass} />
              </Field>
              <Field label={c("to")}>
                <input type="date" name="to" defaultValue={current.to ?? ""} className={fieldClass} />
              </Field>
            </div>
          </Disclosure>
        </Toolbar>
      </form>

      {attentionView ? (
        <AttentionTable rows={attentionRows} locale={locale} tr={tr} />
      ) : rows.length === 0 ? (
        <EmptyState title={c("empty")} action={canSell ? <PrimaryAction href="/admin/orders/new">+ {c("new")}</PrimaryAction> : undefined} />
      ) : (
        <Surface flush data-testid="orders-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-[0.8125rem]">
              <caption className="sr-only">{c("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={cn(th, "w-40")}>{c("col_reference")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{c("col_date")}</th>
                  <th scope="col" className={th}>{c("col_customer")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{c("col_status")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{c("col_total")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{c("col_paid")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const who = o.companyName ?? o.personName;
                  return (
                    <tr key={o.id} className={rowClass} data-testid="orders-row">
                      <td className={cn(td, "font-semibold whitespace-nowrap")}>
                        <Link href={`/admin/orders/${o.id}`} className={cn(rowLink, "hover:underline")}>
                          {o.reference}
                        </Link>
                        <span className="block text-[0.75rem] font-normal text-muted-foreground">{tr(`commerce.channel.${o.channel}`)}</span>
                      </td>
                      <td className={cn(td, "whitespace-nowrap")}>{formatDateTime(o.createdAt, locale, "short")}</td>
                      <td className={td}>
                        <span className="flex items-center gap-2.5">
                          <Initials name={who} />
                          <span className="grid leading-tight">
                            <span className="font-medium">{who ?? c("walk_in")}</span>
                            {o.companyName && o.personName ? <span className="text-[0.75rem] text-muted-foreground">{o.personName}</span> : o.personEmail ? <span className="text-[0.75rem] text-muted-foreground">{o.personEmail}</span> : null}
                          </span>
                        </span>
                      </td>
                      <td className={td}>
                        <StatusPill tone={STATUS_TONE[o.status]}>{tr(`commerce.order_status.${o.status}`)}</StatusPill>
                      </td>
                      <td className={cn(td, "text-right font-semibold whitespace-nowrap tabular-nums")}>{formatMoney(o.totalCents, locale)}</td>
                      <td className={cn(td, "text-right whitespace-nowrap tabular-nums", o.status === "pending_payment" ? "text-[var(--status-warn)]" : "text-muted-foreground")}>{formatMoney(o.paidCents, locale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {!attentionView && nextCursor ? (
        <div>
          <SecondaryAction href={href({ cursor: nextCursor })}>{c("next_page")}</SecondaryAction>
        </div>
      ) : null}
    </div>
  );
}
