import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, buttonVariants, EmptyState, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { ORDER_CHANNELS, ORDER_STATUSES, type OrderChannel, type OrderStatus } from "@beam/core/commerce";
import { formatDateTime, formatMoney } from "@beam/core/i18n";
import { zonedTimeToUtc } from "@beam/core/platform";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listOrders } from "@/modules/commerce/queries";

const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type Search = { q?: string; status?: string; channel?: string; from?: string; to?: string; cursor?: string };

/** `YYYY-MM-DD` as the start of that Brussels day. */
function dayStart(value: string | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc({ year, month, day, hour: 0, minute: 0 });
}

/**
 * `/admin/orders` (commerce spec 5.1; `commerce.sell`, `commerce.refund` or `invoices.read`): the
 * orders table with reference, date, person or company, channel, status, total and paid; search
 * by reference, email or name; filters on status, channel and dates; 50 per page (keyset).
 */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  if (!["commerce.sell", "commerce.refund", "invoices.read"].some((p) => hasPermission(actor, p as "commerce.sell"))) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_orders.${k}`, p);
  const status = (ORDER_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as OrderStatus) : undefined;
  const channel = (ORDER_CHANNELS as readonly string[]).includes(sp.channel ?? "") ? (sp.channel as OrderChannel) : undefined;
  const from = dayStart(sp.from);
  const toStart = dayStart(sp.to);
  const to = toStart ? new Date(toStart.getTime() + 86_400_000) : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const { rows, nextCursor } = await listOrders(await getAppDb(), {
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(q ? { q } : {}),
    ...(sp.cursor ? { cursor: sp.cursor } : {}),
  });
  const filtered = !!(status || channel || from || to || q);
  const canSell = hasPermission(actor, "commerce.sell");
  const nextHref = nextCursor
    ? `/admin/orders?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(channel ? { channel } : {}), ...(sp.from ? { from: sp.from } : {}), ...(sp.to ? { to: sp.to } : {}), cursor: nextCursor }).toString()}`
    : null;

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{c("title")}</h1>
        <div className="flex gap-2">
          <Link href="/admin/orders/attention" className={buttonVariants({ variant: "outline" })}>
            {tr("commerce.nav.attention")}
          </Link>
          {canSell ? (
            <Link href="/admin/orders/new" className={buttonVariants()}>
              {c("new")}
            </Link>
          ) : null}
        </div>
      </header>
      <form className="flex flex-wrap items-end gap-2" role="search">
        <label className="grid gap-1 text-sm">
          <span>{c("search")}</span>
          <Input name="q" defaultValue={q ?? ""} className="w-64" />
        </label>
        <label className="grid gap-1 text-sm">
          <span>{c("filter_status")}</span>
          <select name="status" defaultValue={status ?? ""} className={selectClass}>
            <option value="">{tr("commerce.common.all")}</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {tr(`commerce.order_status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>{c("filter_channel")}</span>
          <select name="channel" defaultValue={channel ?? ""} className={selectClass}>
            <option value="">{tr("commerce.common.all")}</option>
            {ORDER_CHANNELS.map((ch) => (
              <option key={ch} value={ch}>
                {tr(`commerce.channel.${ch}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>{c("from")}</span>
          <Input type="date" name="from" defaultValue={sp.from ?? ""} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>{c("to")}</span>
          <Input type="date" name="to" defaultValue={sp.to ?? ""} />
        </label>
        <Button type="submit" variant="outline">
          {tr("commerce.common.filter")}
        </Button>
        {filtered ? (
          <Link href="/admin/orders" className={buttonVariants({ variant: "ghost" })}>
            {tr("commerce.common.clear_filters")}
          </Link>
        ) : null}
      </form>
      {rows.length === 0 ? (
        <EmptyState
          title={c("empty")}
          action={
            canSell ? (
              <Link href="/admin/orders/new" className={buttonVariants()}>
                {c("new")}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{c("col_reference")}</TableHead>
              <TableHead>{c("col_date")}</TableHead>
              <TableHead>{c("col_customer")}</TableHead>
              <TableHead>{c("col_channel")}</TableHead>
              <TableHead>{c("col_status")}</TableHead>
              <TableHead className="text-right">{c("col_total")}</TableHead>
              <TableHead className="text-right">{c("col_paid")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => (
              <TableRow key={o.id}>
                <TableCell>
                  <Link href={`/admin/orders/${o.id}`} className="font-medium underline">
                    {o.reference}
                  </Link>
                </TableCell>
                <TableCell>{formatDateTime(o.createdAt, locale, "short")}</TableCell>
                <TableCell>{o.companyName ?? o.personName ?? c("walk_in")}</TableCell>
                <TableCell>{tr(`commerce.channel.${o.channel}`)}</TableCell>
                <TableCell>
                  <Badge variant={o.status === "paid" ? "default" : "secondary"}>{tr(`commerce.order_status.${o.status}`)}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(o.totalCents, locale)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(o.paidCents, locale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {nextHref ? (
        <Link href={nextHref as never} className={buttonVariants({ variant: "outline" })}>
          {c("next_page")}
        </Link>
      ) : null}
    </div>
  );
}
