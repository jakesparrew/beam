import Link from "next/link";
import type { Route } from "next";
import { Badge, Button, EmptyState, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, buttonVariants } from "@beam/ui";
import { BOOKING_SOURCES, BOOKING_STATUSES, PAID_WITH, addDays, brusselsTime, zonedTimeToUtc, type BookingSource, type BookingStatus, type PaidWith } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { listBookings } from "@/modules/booking/queries";
import { searchPersons } from "@/modules/crm/api";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type Search = { q?: string; personId?: string; sessionId?: string; status?: string; paidWith?: string; source?: string; from?: string; to?: string; cursor?: string };

/** `<createdAt ISO>_<id>` (keyset of `listBookings`). */
function parseCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = raw.split("_");
  const createdAt = new Date(at ?? "");
  return id && UUID.test(id) && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

/**
 * `/admin/bookings` (`bookings.read`, booking spec 5.1): bookings filtered by person (crm search),
 * session, status and the session's date range, newest first, 50 per page (keyset); links to the
 * booking and to a new manual booking (`bookings.write`).
 */
export default async function BookingsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "bookings.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const db = await getAppDb();
  const sp = await searchParams;
  const status = (BOOKING_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as BookingStatus) : undefined;
  const personId = sp.personId && UUID.test(sp.personId) ? sp.personId : undefined;
  const sessionId = sp.sessionId && UUID.test(sp.sessionId) ? sp.sessionId : undefined;
  const paidWith = (PAID_WITH as readonly string[]).includes(sp.paidWith ?? "") ? (sp.paidWith as PaidWith) : undefined;
  const source = (BOOKING_SOURCES as readonly string[]).includes(sp.source ?? "") ? (sp.source as BookingSource) : undefined;
  const from = sp.from && DATE.test(sp.from) ? sp.from : undefined;
  const to = sp.to && DATE.test(sp.to) ? sp.to : undefined;
  const q = (sp.q ?? "").trim();

  const [page, people] = await Promise.all([
    listBookings(db, {
      ...(personId ? { personId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(status ? { status } : {}),
      ...(paidWith ? { paidWith } : {}),
      ...(source ? { source } : {}),
      ...(from ? { from: zonedTimeToUtc(from, "00:00") } : {}),
      ...(to ? { to: zonedTimeToUtc(addDays(to, 1), "00:00") } : {}),
      cursor: parseCursor(sp.cursor),
    }),
    q && !personId ? searchPersons(db, { q, limit: 10 }) : Promise.resolve([]),
  ]);

  const keep = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ personId, sessionId, status, paidWith, source, from, to, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return `/admin/bookings${s ? `?${s}` : ""}` as Route;
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("booking.bookings.title")}</h1>
        {hasPermission(actor, "bookings.write") ? (
          <Link href={"/admin/bookings/new"} className={buttonVariants({ size: "sm" })}>
            {tr("booking.bookings.new")}
          </Link>
        ) : null}
      </div>

      <form method="get" className="grid gap-3 rounded-md border p-3 sm:grid-cols-3 lg:grid-cols-6 lg:items-end" role="search">
        <div className="grid gap-1 lg:col-span-2">
          <Label htmlFor="bookings-q">{tr("booking.bookings.person")}</Label>
          <Input id="bookings-q" name="q" defaultValue={q} placeholder={soft("crm.persons.list.search_placeholder")} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="bookings-status">{tr("booking.bookings.filter_status")}</Label>
          <select id="bookings-status" name="status" defaultValue={status ?? ""} className={selectClass}>
            <option value="">—</option>
            {BOOKING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {tr(`booking.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="bookings-paid-with">{tr("booking.bookings.filter_paid_with")}</Label>
          <select id="bookings-paid-with" name="paidWith" defaultValue={paidWith ?? ""} className={selectClass}>
            <option value="">—</option>
            {PAID_WITH.map((s) => (
              <option key={s} value={s}>
                {tr(`booking.paidWith.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="bookings-source">{tr("booking.bookings.filter_source")}</Label>
          <select id="bookings-source" name="source" defaultValue={source ?? ""} className={selectClass}>
            <option value="">—</option>
            {BOOKING_SOURCES.map((s) => (
              <option key={s} value={s}>
                {tr(`booking.source.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="bookings-from">{tr("booking.bookings.filter_from")}</Label>
          <Input id="bookings-from" name="from" type="date" defaultValue={from ?? ""} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="bookings-to">{tr("booking.bookings.filter_to")}</Label>
          <Input id="bookings-to" name="to" type="date" defaultValue={to ?? ""} />
        </div>
        {personId ? <input type="hidden" name="personId" value={personId} /> : null}
        {sessionId ? <input type="hidden" name="sessionId" value={sessionId} /> : null}
        <Button type="submit" variant="outline">
          {soft("crm.common.search")}
        </Button>
      </form>

      {people.length ? (
        <ul className="flex flex-wrap gap-2" aria-label={tr("booking.bookings.person")}>
          {people.map((p) => (
            <li key={p.personId}>
              <Link href={keep({ personId: p.personId })} className={buttonVariants({ variant: "outline", size: "sm" })}>
                {p.name} · {p.customerNumber}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {personId || sessionId ? (
        <p className="text-sm">
          <Link href={keep({ personId: undefined, sessionId: undefined })} className="underline">
            {tr("booking.common.show_all")}
          </Link>
        </p>
      ) : null}

      {page.rows.length === 0 ? (
        <EmptyState
          title={tr("booking.bookings.empty")}
          action={
            hasPermission(actor, "bookings.write") ? (
              <Link href={"/admin/bookings/new"} className={buttonVariants({ size: "sm" })}>
                {tr("booking.bookings.new")}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr("booking.bookings.person")}</TableHead>
                <TableHead>{tr("booking.bookings.session")}</TableHead>
                <TableHead>{tr("booking.bookings.starts_at")}</TableHead>
                <TableHead>{tr("booking.bookings.filter_status")}</TableHead>
                <TableHead>{tr("booking.bookings.filter_paid_with")}</TableHead>
                <TableHead>{tr("booking.bookings.filter_source")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.map((r) => (
                <TableRow key={r.id} data-booking-id={r.id}>
                  <TableCell className="font-medium">
                    <Link href={`/admin/bookings/${r.id}` as Route} className="underline-offset-4 hover:underline">
                      {r.personName || "—"}
                    </Link>
                    {r.isGuest ? <span className="text-sm text-muted-foreground"> · {tr("booking.session.attendee_guest_of")}</span> : null}
                  </TableCell>
                  <TableCell>
                    <Link href={`/admin/sessions/${r.sessionId}` as Route} className="underline-offset-4 hover:underline">
                      {show(r.sessionTitle, locale)}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatDate(r.startsAt, locale)} {brusselsTime(r.startsAt)}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      <Badge variant="outline">{tr(`booking.status.${r.status}`)}</Badge>
                      {r.isPayAtDesk ? <Badge variant="warning">{tr("booking.manual.pay_at_desk")}</Badge> : null}
                      {r.isOverCapacity ? <Badge variant="destructive">{tr("booking.manual.over_capacity")}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell>{tr(`booking.paidWith.${r.paidWith}`)}</TableCell>
                  <TableCell>{tr(`booking.source.${r.source}`)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {page.nextCursor ? (
        <Link href={keep({ cursor: `${page.nextCursor.createdAt.toISOString()}_${page.nextCursor.id}` })} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
          {soft("platform.table.next") === "platform.table.next" ? "→" : soft("platform.table.next")}
        </Link>
      ) : null}
    </div>
  );
}
