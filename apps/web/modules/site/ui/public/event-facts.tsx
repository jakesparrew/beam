/**
 * Event detail facts (site-P2 rules 28-32, extended by site-P8 for R2): date, place, price with
 * the members line, seat band, the ticket types of an event with their public and member prices,
 * and one action. Public pages are cached and never personalised (rule 32), so the action never
 * fails for the viewer's status:
 * - a webinar-linked event links to the webinar's own page, "Register for the webinar" (edge case 36);
 * - a Lead Magnet event in its lead window shows "Priority access for new guests until <date>"
 *   (Europe/Brussels) and "Check your access" to the portal session page, never a count, a rank or a
 *   direct booking button (scenario 3);
 * - a full or closed event shows "Join the waitlist" (the portal page holds the waitlist entry);
 * - otherwise "Get tickets".
 *
 * Also the `webinar_signup` block view: it only maps the block to webinar's
 * `WebinarSignup({ webinarId, locale })` server component (a card that registers on, or links to,
 * the webinar's own page).
 */
import { formatDate, formatDateTime, formatMoney, formatTime, type Locale } from "@beam/core/i18n";
import type { AvailabilityBand } from "@beam/core/site";
import { WebinarSignup } from "@/modules/webinar/api";
import type { EventFacts, TicketTypeFact } from "../../queries/public";
import type { BlockContext, BlockOf, Tr } from "./block-renderer";

/** Shared button-like link style (the same tokens as `block-renderer`'s `buttonClass`). */
const actionClass =
  "inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export type EventActionKind = "tickets" | "waitlist" | "check_access" | "webinar";
export type EventAction = { kind: EventActionKind; href: string; labelKey: string };

const ACTION_LABEL: Record<EventActionKind, string> = {
  tickets: "site.blocks.events.getTickets",
  waitlist: "site.blocks.events.joinWaitlist",
  check_access: "site.blocks.events.checkAccess",
  webinar: "site.blocks.events.registerWebinar",
};

export function isEventPast(e: Pick<EventFacts, "endsAt">, now: Date): boolean {
  return new Date(e.endsAt).getTime() < now.getTime();
}

/** Whether no seat is left for the public (band "Full" or the session closed). */
export function isEventFull(e: Pick<EventFacts, "band" | "status" | "ticketTypes">): boolean {
  if (e.band === "full" || e.status === "closed") return true;
  const sellable = e.ticketTypes.filter((t) => t.onSale || t.salesStartAt);
  return sellable.length > 0 && sellable.every((t) => t.soldOut);
}

/** The one action of an event page, or null (past, cancelled, or a webinar that is not public). */
export function eventAction(e: EventFacts, now: Date): EventAction | null {
  if (e.status === "cancelled" || isEventPast(e, now)) return null;
  const make = (kind: EventActionKind, href: string): EventAction => ({ kind, href, labelKey: ACTION_LABEL[kind] });
  if (e.isWebinar) return e.webinar ? make("webinar", e.webinar.href) : null;
  if (e.accessDependsOnViewer) return make("check_access", e.bookHref);
  if (isEventFull(e)) return make("waitlist", e.bookHref);
  return make("tickets", e.bookHref);
}

function bandText(band: AvailabilityBand, tr: Tr): string {
  return band === "full" ? tr("site.blocks.events.full") : band === "few" ? tr("site.blocks.events.fewLeft") : tr("site.blocks.events.available");
}

function TicketTypeItem({ t, tr, locale }: { t: TicketTypeFact; tr: Tr; locale: Locale }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 py-3" data-ticket-type={t.id}>
      <div className="space-y-1">
        <p className="font-medium">{t.name}</p>
        <p className="flex flex-wrap gap-2 text-sm">
          {t.isMemberOnly ? <span className="rounded-full bg-muted px-2.5 py-0.5 font-medium">{tr("site.blocks.events.membersOnly")}</span> : null}
          {t.soldOut ? (
            <span data-ticket-state="sold_out">{tr("site.blocks.events.soldOut")}</span>
          ) : t.salesStartAt ? (
            <span data-ticket-state="not_yet">{tr("site.blocks.events.salesFrom", { date: formatDateTime(t.salesStartAt, locale, "long") })}</span>
          ) : !t.onSale ? (
            <span data-ticket-state="ended">{tr("site.blocks.events.salesEnded")}</span>
          ) : null}
        </p>
      </div>
      {t.publicCents !== null ? (
        <div className="text-right">
          <p className="font-semibold" data-price="public">
            {formatMoney(t.publicCents, locale)}
          </p>
          {t.memberCents !== null ? (
            <p className="text-sm text-muted-foreground" data-price="member">
              {tr("site.blocks.pricing.members", { amount: formatMoney(t.memberCents, locale) })}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function EventFactsView({ facts: e, tr, locale, now = new Date() }: { facts: EventFacts | null; tr: Tr; locale: Locale; now?: Date }) {
  if (!e) return null;
  const past = isEventPast(e, now);
  const cancelled = e.status === "cancelled";
  const live = !past && !cancelled;
  const action = eventAction(e, now);
  const showBand = live && e.band && !e.accessDependsOnViewer && !e.isWebinar;
  const hasTypes = e.ticketTypes.length > 0;
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 sm:px-6" data-event={e.sessionId}>
      {cancelled ? (
        <p role="status" className="rounded-lg bg-destructive/10 p-4 font-medium">
          {tr("site.blocks.events.cancelled")}
        </p>
      ) : past ? (
        <p role="status" className="rounded-lg bg-muted p-4 font-medium">
          {tr("site.blocks.events.past")}
        </p>
      ) : null}
      <ul className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <li>
          <time dateTime={e.startsAt}>
            {formatDate(e.startsAt, locale, "full")}, {formatTime(e.startsAt, locale)}-{formatTime(e.endsAt, locale)}
          </time>
        </li>
        {e.location ? <li>{e.location}</li> : null}
        {!hasTypes && e.priceCents !== null ? (
          <li className="font-semibold" data-price="public">
            {formatMoney(e.priceCents, locale)}
          </li>
        ) : null}
        {!hasTypes && e.priceCents !== null && e.memberPriceCents !== null ? (
          <li data-price="member">{tr("site.blocks.pricing.members", { amount: formatMoney(e.memberPriceCents, locale) })}</li>
        ) : null}
        {showBand ? <li data-band={e.band}>{bandText(e.band!, tr)}</li> : null}
        {e.isMemberOnly ? <li className="rounded-full bg-muted px-2.5 py-0.5 font-medium">{tr("site.blocks.events.membersOnly")}</li> : null}
      </ul>
      {live && e.priorityUntil ? (
        <p className="rounded-lg border border-border p-4 text-sm" data-lead-window>
          {tr("site.blocks.events.priorityUntil", { date: formatDateTime(e.priorityUntil, locale, "long") })}
        </p>
      ) : null}
      {hasTypes && !e.isWebinar ? (
        <section aria-labelledby={`tickets-${e.sessionId}`} className="space-y-2" data-ticket-types>
          <h2 id={`tickets-${e.sessionId}`} className="text-lg font-semibold">
            {tr("site.blocks.events.tickets")}
          </h2>
          <ul className="divide-y divide-border rounded-xl border border-border px-4">
            {e.ticketTypes.map((t) => (
              <TicketTypeItem key={t.id} t={t} tr={tr} locale={locale} />
            ))}
          </ul>
        </section>
      ) : null}
      {action ? (
        <a href={action.href} className={actionClass} data-action={action.kind}>
          {tr(action.labelKey)}
        </a>
      ) : null}
    </div>
  );
}

/** `webinar_signup` block: webinar's `WebinarSignup` with the block's webinar and the page locale. */
export function WebinarSignupBlockView({ block, ctx }: { block: BlockOf<"webinar_signup">; ctx: BlockContext }) {
  return <WebinarSignup webinarId={block.webinarId} locale={ctx.locale} />;
}
