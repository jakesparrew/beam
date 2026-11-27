import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { ORDER_CHANNELS, ORDER_STATUSES, type OrderChannel, type OrderStatus } from "@beam/core/commerce";
import { formatDate, formatDateTime, formatMoney, formatTime, TIME_ZONE, type Locale } from "@beam/core/i18n";
import { zonedTimeToUtc } from "@beam/core/platform";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getAttentionFeed, listOrders, type OrderListRow } from "@/modules/commerce/queries";
import { PageHeader, PrimaryAction, SecondaryAction, StatusPill, Surface, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Field, fieldClass, Initials, ListToolbar, listToolbarLabels, rowClass, rowLink, type AppliedFilter } from "@/modules/platform/ui/admin-list-kit";
import { AttentionTable } from "./attention-table";

type Search = { q?: string; status?: string; channel?: string; from?: string; to?: string; cursor?: string };

/** The status chips; `attention` is the payment follow-up feed, not an order status. */
const TABS = ["attention", "pending_payment", "paid", "refunded"] as const;
const STATUS_TONE: Record<OrderStatus, Tone> = { draft: "muted", pending_payment: "warn", paid: "ok", cancelled: "muted", expired: "muted", refunded: "info", partially_refunded: "info" };
/** How an order is paid, as staff say it: the provider folds into card, cash, online, transfer, credit or on account. */
type Method = "terminal" | "cash" | "online" | "bank_transfer" | "credit_balance" | "on_account";
const METHOD: Record<NonNullable<OrderListRow["paymentProvider"]>, Method> = { terminal: "terminal", cash: "cash", mollie: "online", stripe: "online", viva: "online", bank_transfer: "bank_transfer", credit_balance: "credit_balance" };
/** An open order on the client's account reads "Op rekening"; once settled, the settling payment shows. */
const methodOf = (o: OrderListRow): Method | null => (o.onAccount && o.status === "pending_payment" ? "on_account" : o.paymentProvider ? METHOD[o.paymentProvider] : o.onAccount ? "on_account" : null);

/** `YYYY-MM-DD` as the start of that Brussels day. */
function dayStart(value: string | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc({ year, month, day, hour: 0, minute: 0 });
}

/** The Brussels calendar day of `at`. */
const brusselsDay = (at: Date) => at.toLocaleDateString("sv-SE", { timeZone: TIME_ZONE });

/** "Vandaag 14:32", "Gisteren 09:10", else "12 nov." (with the year when it is not this year). */
function whenLabel(at: Date, now: Date, locale: Locale, tr: (k: string, p?: Record<string, string | number>) => string): string {
  const today = brusselsDay(now);
  // Noon UTC sits inside the same Brussels day, so one day back is yesterday across a DST change.
  const yesterday = brusselsDay(new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000));
  const day = brusselsDay(at);
  if (day === today) return tr("commerce.admin_orders.today_at", { time: formatTime(at, locale) });
  if (day === yesterday) return tr("commerce.admin_orders.yesterday_at", { time: formatTime(at, locale) });
  return new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, day: "numeric", month: "short", ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }) }).format(at);
}

/**
 * `/admin/orders` (commerce spec 5.1; `commerce.sell`, `commerce.refund` or `invoices.read`;
 * "Bestellingen & betalingen" in the menu), owner review November 2026 ("cleaner, more relevant
 * info"): the list toolbar (a super search on reference, email or name; the chips All, "Op te
 * volgen" with its number (`?status=attention`: the failed and pending payments of
 * `/admin/orders/attention`, for `commerce.sell` or `reports.read`), pending, paid and refunded;
 * every status, the channel and the dates behind "Filters"), then one row per order: the customer
 * with the reference, what was bought, channel and payment method as pills, the status, the total
 * and when; 50 per page (keyset).
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
  const now = new Date();

  const tab = attentionView ? "attention" : status;
  const current: Record<string, string | undefined> = { q, status: tab, channel, from: from ? sp.from : undefined, to: toStart ? sp.to : undefined };
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/orders?${s}` : "/admin/orders";
  };
  const otherStatus = status && !(TABS as readonly string[]).includes(status) ? status : undefined;
  const applied: AppliedFilter[] = [
    ...(otherStatus ? [{ key: "status", label: c("filter_status"), value: tr(`commerce.order_status.${otherStatus}`), href: href({ status: undefined }) }] : []),
    ...(channel ? [{ key: "channel", label: c("filter_channel"), value: tr(`commerce.channel.${channel}`), href: href({ channel: undefined }) }] : []),
    ...(current.from ? [{ key: "from", label: c("from"), value: formatDate(current.from, locale), href: href({ from: undefined }) }] : []),
    ...(current.to ? [{ key: "to", label: c("to"), value: formatDate(current.to, locale), href: href({ to: undefined }) }] : []),
  ];
  const line = (o: OrderListRow) => {
    const first = o.firstLine ? o.firstLine[locale] || o.firstLine["nl-BE"] || o.firstLine.en || o.firstLine["fr-BE"] || "" : "";
    if (!first) return c("no_items");
    return o.lineCount > 1 ? c("items_more", { first, count: o.lineCount - 1 }) : first;
  };

  return (
    <div className="grid gap-4">
      <PageHeader title={tr("platform.nav.orders")} actions={canSell ? <PrimaryAction href="/admin/orders/new">+ {c("new")}</PrimaryAction> : null} />
      <ListToolbar
        labels={listToolbarLabels(tr)}
        search={{ placeholder: c("search_placeholder"), defaultValue: q, label: c("search") }}
        filters={{
          count: applied.length,
          children: (
            <>
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
            </>
          ),
        }}
        chips={{
          label: c("filter_status"),
          items: [
            { key: "all", label: tr("commerce.common.all"), href: href({ status: undefined }), active: !tab },
            ...TABS.filter((t) => t !== "attention" || canAttention).map((t) => ({
              key: t,
              label: t === "attention" ? c("tab_attention") : tr(`commerce.order_status.${t}`),
              href: href({ status: t }),
              active: tab === t,
              ...(t === "attention" ? { count: attention.length } : {}),
            })),
          ],
        }}
        applied={applied}
        clearAll={href({ status: otherStatus ? undefined : tab, channel: undefined, from: undefined, to: undefined })}
      />

      {attentionView ? (
        <AttentionTable rows={attentionRows} locale={locale} tr={tr} />
      ) : rows.length === 0 ? (
        <EmptyState title={c("empty")} action={canSell ? <PrimaryAction href="/admin/orders/new">+ {c("new")}</PrimaryAction> : undefined} />
      ) : (
        <Surface flush data-testid="orders-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-[0.8125rem]">
              <caption className="sr-only">{c("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{c("col_customer")}</th>
                  <th scope="col" className={th}>{c("col_items")}</th>
                  <th scope="col" className={cn(th, "w-28")}>{c("col_channel")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{c("col_payment")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{c("col_status")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{c("col_total")}</th>
                  <th scope="col" className={cn(th, "w-32 text-right")}>{c("col_date")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const who = o.companyName ?? o.personName;
                  const method = methodOf(o);
                  const due = o.status === "pending_payment" && o.paidCents > 0 && o.paidCents < o.totalCents;
                  return (
                    <tr key={o.id} className={rowClass} data-testid="orders-row">
                      <td className={td}>
                        <span className="flex items-center gap-2.5">
                          <Initials name={who} />
                          <span className="grid min-w-0 leading-tight">
                            <Link href={`/admin/orders/${o.id}`} className={cn(rowLink, "truncate font-semibold hover:underline")}>
                              {who ?? c("walk_in")}
                            </Link>
                            <span className="truncate text-[0.75rem] text-muted-foreground">
                              <span className="font-mono tabular-nums">{o.reference}</span>
                              {o.companyName && o.personName ? ` · ${o.personName}` : o.personEmail && who !== o.personEmail ? ` · ${o.personEmail}` : ""}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className={cn(td, "max-w-[16rem] truncate", !o.firstLine && "text-muted-foreground")} title={line(o)}>
                        {line(o)}
                      </td>
                      <td className={td}>
                        <StatusPill tone="muted" className="border border-border bg-card font-medium">
                          {c(`channel_short.${o.channel}`)}
                        </StatusPill>
                      </td>
                      <td className={td}>{method ? <StatusPill tone={method === "on_account" ? "gold" : "muted"}>{c(`method.${method}`)}</StatusPill> : <span className="text-muted-foreground">–</span>}</td>
                      <td className={td}>
                        <StatusPill tone={STATUS_TONE[o.status]}>{tr(`commerce.order_status.${o.status}`)}</StatusPill>
                      </td>
                      <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>
                        <span className="grid leading-tight">
                          <span className="font-semibold">{formatMoney(o.totalCents, locale)}</span>
                          {due ? (
                            <span className="text-[0.75rem] text-[var(--status-warn)]">
                              {c("col_paid")} {formatMoney(o.paidCents, locale)}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className={cn(td, "text-right whitespace-nowrap text-muted-foreground")} title={formatDateTime(o.createdAt, locale, "short")}>
                        {whenLabel(o.createdAt, now, locale, tr)}
                      </td>
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
