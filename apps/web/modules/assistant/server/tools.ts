/**
 * The agent's tools (docs/plan/modules/assistant.md section 3.3). The model never touches the
 * database: it asks, a tool answers with a small shaped result, and some tools add a card the
 * widget renders (sessions, a booking button, the contact form, the handoff note). The agent can
 * read and link, never book, cancel or charge: the existing flows do that.
 */
import "server-only";
import type { ChatTool } from "@beam/integrations/anthropic";
import { URL_SEGMENT, type Locale } from "@beam/core/i18n";
import type { AssistantCard } from "@beam/db/schema";
import type { DbOrTx } from "@/lib/ctx";
import { getPersonBookingSummary, getSessionCards, getWellbeingJourney, listBookableSessions, listUpcomingBookingsForPerson, type SessionKind } from "@/modules/booking/api";
import { listPublicPrices } from "@/modules/commerce/api";
import { getPersonCreditSummary } from "@/modules/credits/api";

export type ToolEffects = { contactOffered: boolean; handoff: string | null; unanswered: string[]; bookingLinks: number; shownLinks: string[] };

export type ToolCtx = {
  db: DbOrTx;
  locale: Locale;
  role: "guide" | "coach";
  personId: string | null;
  contactKnown: boolean;
  /** allowed: consent and BEAM's sensitive-processing switch; no_consent: the customer did not allow it; unavailable: BEAM has not switched it on. */
  checkins: "allowed" | "no_consent" | "unavailable";
  now: Date;
  effects: ToolEffects;
};

export type ToolOutcome = { result: unknown; card?: AssistantCard };

type ToolDef = ChatTool & { roles: readonly ("guide" | "coach")[]; run: (ctx: ToolCtx, input: Record<string, unknown>) => Promise<ToolOutcome> };

const DAY = 86_400_000;
const isoDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(d);
const when = (d: Date, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
const euros = (cents: number | null | undefined) => (cents == null ? null : Math.round(cents) / 100);
const text = (v: Record<string, string | undefined> | null | undefined, locale: Locale) => v?.[locale] ?? v?.["nl-BE"] ?? v?.en ?? "";
const KINDS: readonly SessionKind[] = ["day", "night", "event"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LINK_LABEL: Record<Locale, { session: string; kind: string }> = {
  "nl-BE": { session: "Boek", kind: "Bekijk beschikbaarheid" },
  "fr-BE": { session: "Réserver", kind: "Voir les disponibilités" },
  en: { session: "Book", kind: "See availability" },
};

export const TOOLS: readonly ToolDef[] = [
  {
    name: "get_availability",
    description: "Bookable sessions with free places, from a date (default today) for a number of days (default 7). Optionally only day, night or event sessions. Returns at most 6, earliest first, with price. Narrow with kind or a later from date to show other moments.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD" },
        days: { type: "integer", minimum: 1, maximum: 14 },
        kind: { type: "string", enum: ["day", "night", "event"] },
      },
    },
    roles: ["guide", "coach"],
    async run(ctx, input) {
      const fromOn = typeof input.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.from) && input.from >= isoDay(ctx.now) ? input.from : isoDay(ctx.now);
      const days = Math.min(14, Math.max(1, Number(input.days) || 7));
      const toOn = isoDay(new Date(new Date(`${fromOn}T12:00:00Z`).getTime() + (days - 1) * DAY));
      const kind = KINDS.includes(input.kind as SessionKind) ? (input.kind as SessionKind) : undefined;
      const all = await listBookableSessions(ctx.db, { fromOn, toOn, ...(kind ? { kind } : {}), ...(ctx.personId ? { personId: ctx.personId } : {}) });
      const open = all.filter((s) => s.status === "open" && s.free > 0 && s.startsAt > ctx.now && !s.isMemberOnly).slice(0, 6);
      const productIds = [...new Set(open.map((s) => s.productId).filter((p): p is string => !!p))];
      const prices = productIds.length ? await listPublicPrices(ctx.db, { productIds, at: ctx.now }) : [];
      const priceOf = new Map(prices.map((p) => [p.productId, p.publicAmountCents]));
      const seg = URL_SEGMENT[ctx.locale];
      const sessions = open.map((s) => ({
        id: s.sessionId,
        title: text(s.title, ctx.locale),
        kind: s.kind,
        startsAt: s.startsAt.toISOString(),
        free: s.free,
        priceCents: s.productId ? (priceOf.get(s.productId) ?? null) : null,
        href: `/${seg}/book/${s.sessionId}`,
      }));
      return {
        result: sessions.length
          ? { from: fromOn, to: toOn, sessions: sessions.map((s, i) => ({ session_id: s.id, title: s.title, kind: s.kind, when: when(open[i]!.startsAt, ctx.locale), free_places: s.free, price_eur: euros(s.priceCents) })) }
          : { from: fromOn, to: toOn, sessions: [], note: "No free places in this period. Offer another period or the waitlist via the contact form." },
        ...(sessions.length ? { card: { type: "sessions", sessions } as AssistantCard } : {}),
      };
    },
  },
  {
    name: "get_offer",
    description: "BEAM's current products and prices: single sessions, nights, packages, memberships and gift vouchers. Optionally one kind. Prices in euro, including VAT; member price when there is one.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["session", "night", "package", "membership", "voucher", "ticket"] } } },
    roles: ["guide", "coach"],
    async run(ctx, input) {
      const all = await listPublicPrices(ctx.db, { at: ctx.now });
      const rows = all.filter((p) => p.isActive && (!input.kind || p.kind === input.kind)).slice(0, 25);
      return {
        result: rows.map((p) => ({
          name: text(p.name, ctx.locale),
          kind: p.kind,
          price_eur: euros(p.publicAmountCents),
          member_price_eur: euros(p.memberAmountCents),
          includes: p.creditUnits ? `${p.creditUnits} ${p.creditKind === "night" ? "night(s)" : "hour(s)/session credit(s)"}` : null,
          valid_days: p.validityDays,
        })),
      };
    },
  },
  {
    name: "booking_link",
    description: "Shows one button into the booking flow: for the session the person chose (session_id from get_availability) or for a kind of session. Use it once the person picked a moment or a kind; the availability card already has a Book button per session.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, kind: { type: "string", enum: ["day", "night", "event"] } },
    },
    roles: ["guide", "coach"],
    async run(ctx, input) {
      const seg = URL_SEGMENT[ctx.locale];
      const sessionId = typeof input.session_id === "string" && UUID.test(input.session_id) ? input.session_id : null;
      const kind = KINDS.includes(input.kind as SessionKind) ? (input.kind as SessionKind) : null;
      const href = sessionId ? `/${seg}/book/${sessionId}` : `/${seg}/book${kind ? `?kind=${kind}` : ""}`;
      if (ctx.effects.shownLinks.includes(href)) return { result: { shown: true, href, note: "Already shown." } };
      ctx.effects.shownLinks.push(href);
      ctx.effects.bookingLinks += 1;
      const card = sessionId ? (await getSessionCards(ctx.db, [sessionId], ctx.locale).catch(() => []))[0] : null;
      const label = card ? `${LINK_LABEL[ctx.locale].session} · ${when(card.startsAt, ctx.locale)}` : sessionId ? LINK_LABEL[ctx.locale].session : LINK_LABEL[ctx.locale].kind;
      return { result: { shown: true, href }, card: { type: "link", label, href } };
    },
  },
  {
    name: "offer_contact_form",
    description: "Shows a short contact form in the chat (first name, email, optional phone, optional newsletter). Use it instead of asking for details in text. Give the reason in a few words.",
    inputSchema: { type: "object", properties: { reason: { type: "string", maxLength: 200 } }, required: ["reason"] },
    roles: ["guide"],
    run(ctx) {
      if (ctx.contactKnown) return Promise.resolve({ result: { shown: false, note: "Their contact details are already known." } });
      ctx.effects.contactOffered = true;
      return Promise.resolve({ result: { shown: true, note: "The form is shown under your answer. Say in one sentence what happens with it; do not ask for the details yourself." }, card: { type: "contact" } });
    },
  },
  {
    name: "handoff",
    description: "Asks a BEAM colleague to take over: for complaints, health worries, special requests, group or company offers, or when the person asks for a human.",
    inputSchema: { type: "object", properties: { reason: { type: "string", maxLength: 300 } }, required: ["reason"] },
    roles: ["guide", "coach"],
    run(ctx, input) {
      ctx.effects.handoff = (typeof input.reason === "string" ? input.reason : "").slice(0, 300) || "handoff";
      return Promise.resolve({
        result: { notified: true, note: ctx.contactKnown ? "A colleague is notified and answers here or by email." : "A colleague is notified. The widget asks for their contact details so the colleague can answer." },
        card: { type: "handoff" as const },
      });
    },
  },
  {
    name: "note_unanswered",
    description: "Records a question you could not answer from the knowledge or the tools, so the team can add the answer.",
    inputSchema: { type: "object", properties: { question: { type: "string", maxLength: 300 } }, required: ["question"] },
    roles: ["guide", "coach"],
    run(ctx, input) {
      ctx.effects.unanswered.push((typeof input.question === "string" ? input.question : "").slice(0, 300));
      return Promise.resolve({ result: { noted: true } });
    },
  },
  {
    name: "my_bookings",
    description: "The customer's upcoming bookings and their visit history (counts, first and last visit).",
    inputSchema: { type: "object", properties: {} },
    roles: ["coach"],
    async run(ctx) {
      if (!ctx.personId) return { result: { error: "not_signed_in" } };
      const [upcoming, summary] = await Promise.all([listUpcomingBookingsForPerson(ctx.db, ctx.personId, 5), getPersonBookingSummary(ctx.db, ctx.personId)]);
      return {
        result: {
          upcoming: upcoming.map((b) => ({ title: text(b.title, ctx.locale), kind: b.kind, when: when(b.startsAt, ctx.locale), guest: b.isGuest ? b.guestFirstName : null })),
          visits: summary.attended,
          nights_booked: summary.nightsBooked,
          first_visit: summary.firstVisitAt ? isoDay(summary.firstVisitAt) : null,
          last_visit: summary.lastVisitAt ? isoDay(summary.lastVisitAt) : null,
          cancellations: summary.cancellations,
        },
      };
    },
  },
  {
    name: "my_balance",
    description: "The customer's remaining credits per kind with expiry, their membership and its end date.",
    inputSchema: { type: "object", properties: {} },
    roles: ["coach"],
    async run(ctx) {
      if (!ctx.personId) return { result: { error: "not_signed_in" } };
      return { result: await getPersonCreditSummary(ctx.db, ctx.personId) };
    },
  },
  {
    name: "my_checkins",
    description: "The customer's wellbeing check-ins (energy, sleep, tension, mood on 1-5, 5 is best): recent averages against before, and the average change a visit brings. Only when the customer allowed it.",
    inputSchema: { type: "object", properties: {} },
    roles: ["coach"],
    async run(ctx) {
      if (!ctx.personId) return { result: { error: "not_signed_in" } };
      if (ctx.checkins === "no_consent") return { result: { available: false, note: "The customer has not allowed the coach to use check-ins. They can switch it on at the top of this chat." } };
      if (ctx.checkins === "unavailable") return { result: { available: false, note: "The customer allowed it, but BEAM has not switched on check-in use for the coach yet. Say so plainly; it is not the customer's doing." } };
      const j = await getWellbeingJourney(ctx.db, ctx.personId, ctx.now);
      const since = isoDay(new Date(ctx.now.getTime() - 14 * DAY));
      const avg = (rows: typeof j.checkins, k: "energy" | "sleep" | "calm" | "mood") => {
        const v = rows.map((r) => r[k]).filter((x): x is number => typeof x === "number");
        return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
      };
      const recent = j.checkins.filter((c) => c.moment !== "before" && c.onDate >= since);
      const earlier = j.checkins.filter((c) => c.moment !== "before" && c.onDate < since);
      const keys = ["energy", "sleep", "calm", "mood"] as const;
      return {
        result: {
          checkins_60_days: j.checkins.length,
          last_14_days: Object.fromEntries(keys.map((k) => [k, avg(recent, k)])),
          before_that: Object.fromEntries(keys.map((k) => [k, avg(earlier, k)])),
          average_change_after_a_visit: j.visitEffect,
          note: "calm is the inverse of tension (5 = no tension). Notes are private and never shared.",
        },
      };
    },
  },
];

export function toolsFor(role: "guide" | "coach"): ChatTool[] {
  return TOOLS.filter((t) => t.roles.includes(role)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function runTool(ctx: ToolCtx, name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const tool = TOOLS.find((t) => t.name === name && t.roles.includes(ctx.role));
  if (!tool) return { result: { error: `unknown_tool: ${name}` } };
  try {
    return await tool.run(ctx, input ?? {});
  } catch (error) {
    return { result: { error: "unavailable", detail: error instanceof Error ? error.message.slice(0, 200) : "error" } };
  }
}
