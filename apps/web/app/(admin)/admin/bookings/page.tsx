import Link from "next/link";
import type { Route } from "next";
import { EmptyState, cn } from "@beam/ui";
import { BOOKING_SOURCES, BOOKING_STATUSES, PAID_WITH, addDays, brusselsTime, zonedTimeToUtc, type BookingSource, type BookingStatus, type PaidWith } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { listBookings } from "@/modules/booking/queries";
import { Initials } from "@/modules/booking/ui/kit";
import { searchPersons } from "@/modules/crm/api";
import { PageHeader, PrimaryAction, SecondaryAction, StatusPill, Surface, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { Field, fieldClass, ListToolbar, listToolbarLabels, type AppliedFilter } from "@/modules/platform/ui/admin-list-kit";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Every status, most used first; the first three are the toolbar chips, the rest sit in Filters. */
const STATUS_ORDER: BookingStatus[] = ["confirmed", "reserved", "attended", "no_show", "cancelled", "late_cancelled"];
const CHIP_STATUSES = STATUS_ORDER.slice(0, 3);
const STATUS_TONE: Record<BookingStatus, Tone> = { confirmed: "ok", reserved: "warn", attended: "info", no_show: "bad", cancelled: "muted", late_cancelled: "muted" };

type Search = { q?: string; personId?: string; sessionId?: string; status?: string; paidWith?: string; source?: string; from?: string; to?: string; cursor?: string };

/** `<createdAt ISO>_<id>` (keyset of `listBookings`). */
function parseCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = raw.split("_");
  const createdAt = new Date(at ?? "");
  return id && UUID.test(id) && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

/**
 * `/admin/bookings` (`bookings.read`, booking spec 5.1), in the back-office kit (owner review,
 * November 2026): one header with "New booking" (`bookings.write`), the list toolbar (the person
 * search first; the three main statuses as chips; every status, payment, source and the session's
 * date range behind "Filters"; the applied ones as removable chips), then the bookings newest first, 50 per page (keyset), as one table whose rows open
 * the booking. A search lists the matching people (crm search) to filter on one of them.
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
  const canWrite = hasPermission(actor, "bookings.write");
  const first = page.rows[0];
  const rareStatus = status && !CHIP_STATUSES.includes(status) ? status : undefined;
  const applied: AppliedFilter[] = [
    ...(personId ? [{ key: "person", label: tr("booking.bookings.person"), value: first?.personName || "—", href: keep({ personId: undefined }) }] : []),
    ...(sessionId ? [{ key: "session", label: tr("booking.bookings.session"), value: first ? show(first.sessionTitle, locale) : "—", href: keep({ sessionId: undefined }) }] : []),
    ...(rareStatus ? [{ key: "status", label: tr("booking.bookings.filter_status"), value: tr(`booking.bookings.status_short.${rareStatus}`), href: keep({ status: undefined }) }] : []),
    ...(paidWith ? [{ key: "paidWith", label: tr("booking.bookings.filter_paid_with"), value: tr(`booking.paidWith.${paidWith}`), href: keep({ paidWith: undefined }) }] : []),
    ...(source ? [{ key: "source", label: tr("booking.bookings.filter_source"), value: tr(`booking.source.${source}`), href: keep({ source: undefined }) }] : []),
    ...(from ? [{ key: "from", label: tr("booking.bookings.filter_from"), value: formatDate(from, locale), href: keep({ from: undefined }) }] : []),
    ...(to ? [{ key: "to", label: tr("booking.bookings.filter_to"), value: formatDate(to, locale), href: keep({ to: undefined }) }] : []),
  ];

  return (
    <div className="grid gap-5">
      <PageHeader title={tr("booking.bookings.title")} actions={canWrite ? <PrimaryAction href="/admin/bookings/new">+ {tr("booking.bookings.new")}</PrimaryAction> : null} />

      <ListToolbar
        labels={listToolbarLabels(tr)}
        search={{ placeholder: tr("booking.bookings.search_placeholder"), defaultValue: q, label: tr("booking.bookings.person") }}
        hidden={{ personId, sessionId }}
        filters={{
          count: [rareStatus, paidWith, source, from, to].filter(Boolean).length,
          children: (
            <>
              <Field label={tr("booking.bookings.filter_status")}>
                <select id="bookings-status" name="status" defaultValue={status ?? ""} className={fieldClass}>
                  <option value="">{tr("booking.bookings.status_all")}</option>
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {tr(`booking.bookings.status_short.${s}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={tr("booking.bookings.filter_paid_with")}>
                <select id="bookings-paid-with" name="paidWith" defaultValue={paidWith ?? ""} className={fieldClass}>
                  <option value="">{tr("booking.bookings.status_all")}</option>
                  {PAID_WITH.map((s) => (
                    <option key={s} value={s}>
                      {tr(`booking.paidWith.${s}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={tr("booking.bookings.filter_source")}>
                <select id="bookings-source" name="source" defaultValue={source ?? ""} className={fieldClass}>
                  <option value="">{tr("booking.bookings.status_all")}</option>
                  {BOOKING_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {tr(`booking.source.${s}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={tr("booking.bookings.filter_from")}>
                  <input id="bookings-from" name="from" type="date" defaultValue={from ?? ""} className={fieldClass} />
                </Field>
                <Field label={tr("booking.bookings.filter_to")}>
                  <input id="bookings-to" name="to" type="date" defaultValue={to ?? ""} className={fieldClass} />
                </Field>
              </div>
            </>
          ),
        }}
        chips={{
          label: tr("booking.bookings.filter_status"),
          items: [
            { key: "all", label: tr("booking.bookings.status_all"), href: keep({ status: undefined, q: q || undefined }), active: !status },
            ...CHIP_STATUSES.map((s) => ({ key: s, label: tr(`booking.bookings.status_short.${s}`), href: keep({ status: s, q: q || undefined }), active: status === s })),
          ],
        }}
        applied={applied}
        clearAll={keep({ personId: undefined, sessionId: undefined, status: undefined, paidWith: undefined, source: undefined, from: undefined, to: undefined, q: q || undefined })}
      />

      {people.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[0.8125rem]">
          <span className="text-muted-foreground">{tr("booking.bookings.pick_person")}</span>
          <ul className="flex flex-wrap gap-1.5" aria-label={tr("booking.bookings.person")}>
            {people.map((p) => (
              <li key={p.personId}>
                <Link href={keep({ personId: p.personId })} className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-card pr-2.5 pl-1 font-medium hover:bg-muted">
                  <Initials id={p.personId} name={p.name} className="size-6 text-[0.625rem]" />
                  {p.name}
                  <span className="text-[0.75rem] text-muted-foreground">{p.customerNumber}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {page.rows.length === 0 ? (
        <EmptyState title={tr("booking.bookings.empty")} />
      ) : (
        <Surface flush data-testid="admin-bookings-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[50rem] text-[0.8125rem]">
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{tr("booking.bookings.person")}</th>
                  <th scope="col" className={th}>{tr("booking.bookings.session")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{tr("booking.bookings.starts_at")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{tr("booking.bookings.filter_paid_with")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{tr("booking.bookings.filter_source")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{tr("booking.bookings.filter_status")}</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => {
                  const link = `/admin/bookings/${r.id}` as Route;
                  const gone = r.status === "cancelled" || r.status === "late_cancelled";
                  return (
                    <tr key={r.id} data-booking-id={r.id} className={cn("border-b border-border last:border-b-0 hover:bg-[#faf9f6]", gone && "text-muted-foreground")}>
                      <td className={td}>
                        <Link href={link} className="flex items-center gap-2.5">
                          <Initials id={r.personId} name={r.personName} />
                          <span className="grid leading-tight">
                            <span className={cn("font-semibold hover:underline", !gone && "text-foreground")}>{r.personName || "—"}</span>
                            {r.isGuest ? <span className="text-[0.75rem] text-muted-foreground">{tr("booking.checkin.cue_guest")}</span> : null}
                          </span>
                        </Link>
                      </td>
                      <td className={td}>
                        <Link href={link} className="grid leading-tight">
                          <span className="font-medium">{show(r.sessionTitle, locale)}</span>
                          <span className="text-[0.75rem] text-muted-foreground">{tr(`booking.kind.${r.kind}`)}</span>
                        </Link>
                      </td>
                      <td className={cn(td, "whitespace-nowrap tabular-nums")}>
                        <Link href={link} className="grid leading-tight">
                          <span>{formatDate(r.startsAt, locale)}</span>
                          <span className="text-[0.75rem] text-muted-foreground">{brusselsTime(r.startsAt)}</span>
                        </Link>
                      </td>
                      <td className={td}>
                        <span className="grid leading-tight">
                          <span>{tr(`booking.paidWith.${r.paidWith}`)}</span>
                          {r.isPayAtDesk ? <span className="text-[0.75rem] text-[var(--status-warn)]">{tr("booking.bookings.pay_at_desk_short")}</span> : null}
                        </span>
                      </td>
                      <td className={cn(td, "text-muted-foreground")}>{tr(`booking.source.${r.source}`)}</td>
                      <td className={td}>
                        <span className="flex flex-wrap gap-1">
                          <StatusPill tone={STATUS_TONE[r.status]}>{tr(`booking.status.${r.status}`)}</StatusPill>
                          {r.isOverCapacity ? <StatusPill tone="bad">{tr("booking.bookings.over_capacity_short")}</StatusPill> : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {page.nextCursor ? (
        <div className="flex justify-end">
          <SecondaryAction href={keep({ cursor: `${page.nextCursor.createdAt.toISOString()}_${page.nextCursor.id}` })}>
            {soft("platform.table.next") === "platform.table.next" ? "→" : `${soft("platform.table.next")} →`}
          </SecondaryAction>
        </div>
      ) : null}
    </div>
  );
}
