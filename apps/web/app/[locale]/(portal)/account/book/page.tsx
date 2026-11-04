import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { sessionTemplates } from "@beam/db/schema";
import { addDays, brusselsDate, describeAvailability, type SessionKind, type SessionSummary } from "@beam/core/booking";
import { URL_SEGMENT, formatDate, formatMoney, formatTime, localeFromSegment, pick, type Locale } from "@beam/core/i18n";
import { buttonVariants, cn } from "@beam/ui";
import { requireCustomer } from "@/lib/auth";
import { and, eq, getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { getProductPrice } from "@/modules/commerce/api";
import { getOpeningHours, listBookableSessions } from "@/modules/booking/queries";
import { SessionList, type SessionListItem } from "@/modules/booking/ui/portal/session-list";

const TABS = ["day", "night", "event"] as const;
const STRIP_DAYS = 14;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Search = { tab?: string; day?: string; template?: string };

/**
 * `/[locale]/account/book` (booking spec 5.2): tabs Day / Night / Events, a date strip over the
 * booking horizon (day and night), and the sessions of the chosen day with "x places left"
 * (exact only when 5 or fewer), the price or "1 session from your package", the member badge and
 * the lead-window message. `?template=<id>` opens the tab of that template's kind and lists only
 * its sessions with a "Show all" chip; an unknown or inactive id is ignored. A closed day shows
 * the exception's name.
 */
export default async function BookPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const sp = await searchParams;
  const db = await getAppDb();
  const rules = await getSetting(db, "booking_rules");
  const base = `/${URL_SEGMENT[locale]}/account/book`;

  const [template] =
    sp.template && UUID.test(sp.template)
      ? await db
          .select({ id: sessionTemplates.id, kind: sessionTemplates.kind })
          .from(sessionTemplates)
          .where(and(eq(sessionTemplates.id, sp.template), eq(sessionTemplates.isActive, true)))
      : [];
  const tab: SessionKind = template ? template.kind : TABS.includes(sp.tab as SessionKind) ? (sp.tab as SessionKind) : "day";

  const today = brusselsDate(new Date());
  const lastDay = addDays(today, Math.max(0, rules.booking_horizon_days - 1));
  const stripLength = Math.min(STRIP_DAYS, rules.booking_horizon_days);
  const strip = Array.from({ length: stripLength }, (_, i) => addDays(today, i));
  const day = sp.day && DATE.test(sp.day) && sp.day >= today && sp.day <= lastDay ? sp.day : today;
  const fromOn = tab === "event" ? today : day;
  const toOn = tab === "event" ? lastDay : day;

  const sessions = await listBookableSessions(db, actor.personId, { kind: tab, fromOn, toOn, ...(template ? { templateId: template.id } : {}) });
  const opening = tab === "event" ? [] : await getOpeningHours(db, { from: day, to: day });
  const closedName = opening[0]?.exceptionName ? pick(opening[0].exceptionName, locale) : null;

  const prices = new Map<string, number | null>();
  for (const s of sessions) {
    if (!s.productId || prices.has(s.productId)) continue;
    prices.set(s.productId, (await getProductPrice(db, s.productId, "public").catch(() => null))?.amountCents ?? null);
  }

  const items: SessionListItem[] = sessions.map((s) => toItem(s, locale, tr, prices, base));
  const href = (q: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) u.set(k, v);
    const qs = u.toString();
    return (qs ? `${base}?${qs}` : base) as Route;
  };
  const keep = template ? { template: template.id } : {};
  const tabLabel = (k: SessionKind) => tr(k === "event" ? "booking.portalBook.tab_events" : `booking.portalBook.tab_${k}`);

  return (
    <section aria-labelledby="book-title" className="space-y-5">
      <h1 id="book-title" className="text-2xl font-semibold">
        {tr("booking.portalBook.title")}
      </h1>

      <nav aria-label={tr("booking.portalBook.title")} className="flex flex-wrap gap-2" data-testid="book-tabs">
        {TABS.map((k) => (
          <Link
            key={k}
            href={href({ tab: k })}
            aria-current={k === tab ? "page" : undefined}
            className={cn(buttonVariants({ variant: k === tab ? "default" : "outline" }), "min-h-11")}
            data-testid={`book-tab-${k}`}
          >
            {tabLabel(k)}
          </Link>
        ))}
      </nav>

      {template ? (
        <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="template-filter">
          <span>{tr("booking.portalBook.filtered")}</span>
          <Link href={href({ tab })} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11")}>
            {tr("booking.common.show_all")}
          </Link>
        </p>
      ) : null}

      {tab !== "event" ? (
        <nav aria-label={tr("booking.portalBook.date_strip")} data-testid="date-strip">
          <ul className="flex gap-2 overflow-x-auto pb-1">
            {strip.map((d) => {
              const date = new Date(`${d}T12:00:00Z`);
              return (
                <li key={d}>
                  <Link
                    href={href({ tab, day: d, ...keep })}
                    aria-current={d === day ? "date" : undefined}
                    aria-label={formatDate(date, locale, "full")}
                    className={cn(buttonVariants({ variant: d === day ? "default" : "outline" }), "flex min-h-11 min-w-16 flex-col py-1")}
                  >
                    <span className="text-xs">{new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "Europe/Brussels" }).format(date)}</span>
                    <span>{new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "Europe/Brussels" }).format(date)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      {closedName ? (
        <p className="rounded-md border border-warning bg-warning/10 p-3" data-testid="closed-day">
          {tr("booking.portalBook.closed_day", { name: closedName })}
        </p>
      ) : null}

      <SessionList items={items} emptyLabel={tab === "event" ? tr("booking.portalBook.no_events") : tr("booking.portalBook.empty")} />
    </section>
  );
}

function toItem(
  s: SessionSummary,
  locale: Locale,
  tr: (key: string, params?: Record<string, string | number>) => string,
  prices: Map<string, number | null>,
  base: string,
): SessionListItem {
  const d = describeAvailability(s.availability, locale);
  const availabilityLabel = tr(d.labelKey, d.params.count ? { ...d.params, count: Number(d.params.count) } : d.params);
  const time = `${formatTime(s.startsAt, locale)} – ${formatTime(s.endsAt, locale)}`;
  const title = pick(s.title, locale);
  const cents = s.productId ? prices.get(s.productId) : null;
  const priceLabel =
    s.creditKind && s.creditCost > 0
      ? tr("booking.portalBook.price_from_package")
      : cents != null
        ? tr("booking.portalBook.price_single", { price: formatMoney(cents, locale) })
        : null;
  return {
    sessionId: s.sessionId,
    href: `${base}/${s.sessionId}`,
    timeLabel: s.kind === "event" ? `${formatDate(s.startsAt, locale, "full")}, ${time}` : time,
    title,
    availabilityLabel,
    priceLabel,
    memberLabel: s.isMemberOnly ? tr("booking.portalBook.member_badge") : null,
    opensLabel: null,
    ariaLabel: tr("booking.portalBook.session_label", {
      date: formatDate(s.startsAt, locale, "full"),
      time: formatTime(s.startsAt, locale),
      kind: tr(`booking.kind.${s.kind}`),
      availability: availabilityLabel,
    }),
    muted: s.availability.reason !== "ok",
  };
}
