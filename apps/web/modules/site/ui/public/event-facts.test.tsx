/**
 * site-P8 (R2): event detail facts with ticket types and member prices, the lead-window state of a
 * Lead Magnet event (scenario 3), the waitlist entry of a full event, the webinar link of a
 * webinar-linked event (edge case 36) and the `webinar_signup` block mapping.
 */
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeSession } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { bookings, priceVersions, ticketTypes } from "@beam/db/schema";
import { formatDateTime, formatMoney, t, type Locale } from "@beam/core/i18n";
import type * as WebinarApi from "@/modules/webinar/api";
import type { EventFacts } from "../../queries/public";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn, revalidateTag: () => undefined }));
const webinarFlag = vi.fn(async () => true);
vi.mock("@/lib/flags", () => ({ flag: (...args: unknown[]) => webinarFlag(...(args as [])), clearFlagCache: () => undefined }));
vi.mock("@/modules/webinar/api", async () => {
  const { createElement: h } = await import("react");
  return {
    getWebinarForSession: vi.fn(),
    WebinarSignup: vi.fn((p: { webinarId: string; locale: Locale }) => h("div", { "data-webinar-signup": p.webinarId, "data-locale": p.locale })),
  };
});

const webinar = await import("@/modules/webinar/api");
const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { getEventFacts } = await import("../../queries/public");
const { EventFactsView, WebinarSignupBlockView, eventAction } = await import("./event-facts");
const { emptyRenderData, eventOfferPrice } = await import("../../server/render-data");

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => {
  webinarFlag.mockReset();
  webinarFlag.mockResolvedValue(true);
  vi.mocked(webinar.getWebinarForSession).mockReset();
  vi.mocked(webinar.getWebinarForSession).mockResolvedValue(null);
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const trFor = (locale: Locale) => (key: string, params?: Record<string, string | number | Date>) => t(locale, key, params);
const render = (facts: EventFacts | null, locale: Locale = "en", now?: Date) => renderToStaticMarkup(createElement(EventFactsView, { facts, tr: trFor(locale), locale, now }));

/** A published, open event `daysAhead` days from now (fractional offsets keep it clear of midnight). */
function publishedEvent(overrides: Parameters<typeof makeSession>[1] = {}, daysAhead = 10.4) {
  const startsAt = new Date(Date.now() + daysAhead * DAY);
  return makeSession(handle.db, {
    kind: "event",
    creditKind: null,
    eventCategory: "lecture",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * HOUR),
    publishedAt: new Date(Date.now() - DAY),
    capacitySeats: 40,
    ...overrides,
  });
}

/** Ticket types are booking rows without a shared factory: inserted directly (booking-P8 schema). */
async function ticketType(sessionId: string, productId: string, values: Partial<typeof ticketTypes.$inferInsert> = {}) {
  const [row] = await handle.db
    .insert(ticketTypes)
    .values({ sessionId, productId, name: { "nl-BE": "Standaard", "fr-BE": "Standard", en: "Standard" }, ...values })
    .returning();
  return row!;
}

function facts(overrides: Partial<EventFacts> = {}): EventFacts {
  const sessionId = randomUUID();
  return {
    sessionId,
    title: "Breathwork evening",
    startsAt: "2026-07-10T17:00:00.000Z",
    endsAt: "2026-07-10T19:00:00.000Z",
    status: "open",
    location: "BEAM Gent",
    isMemberOnly: false,
    isLeadMagnet: false,
    priceCents: 2500,
    memberPriceCents: null,
    band: "available",
    bookHref: `/en/account/book/${sessionId}`,
    ticketTypes: [],
    priorityUntil: null,
    accessDependsOnViewer: false,
    isWebinar: false,
    webinar: null,
    ...overrides,
  };
}

const NOW = new Date("2026-06-20T10:00:00.000Z");

describe("event facts from booking and commerce", () => {
  it("lists each ticket type with its public price and the members line", async () => {
    const standard = await makeProduct(handle.db, { kind: "ticket", priceCents: 2500, memberDiscountPct: "20.00" });
    const duo = await makeProduct(handle.db, { kind: "ticket", priceCents: 4000 });
    await handle.db.insert(priceVersions).values({ productId: duo.id, version: 1, audience: "member", amountCents: 3000 });
    const memberOnly = await makeProduct(handle.db, { kind: "ticket", priceCents: 1500 });
    const s = await publishedEvent();
    await ticketType(s.id, duo.id, { name: { "nl-BE": "Duo", "fr-BE": "Duo", en: "Duo" }, sortOrder: 2 });
    await ticketType(s.id, standard.id, { sortOrder: 1 });
    await ticketType(s.id, memberOnly.id, { name: { "nl-BE": "Leden", "fr-BE": "Membres", en: "Members" }, isMemberOnly: true, sortOrder: 3 });
    await ticketType(s.id, standard.id, { name: { "nl-BE": "Oud", "fr-BE": "Ancien", en: "Old" }, isActive: false, sortOrder: 0 });

    const f = await getEventFacts(s.id, "en");
    expect(f).not.toBeNull();
    expect(f!.ticketTypes.map((tt) => [tt.name, tt.publicCents, tt.memberCents, tt.isMemberOnly, tt.onSale])).toEqual([
      ["Standard", 2500, 2000, false, true],
      ["Duo", 4000, 3000, false, true],
      ["Members", 1500, null, true, true],
    ]);

    const html = render(f, "en", new Date());
    expect(html).toContain("Standard");
    expect(html).toContain(formatMoney(2500, "en"));
    expect(html).toContain(t("en", "site.blocks.pricing.members", { amount: formatMoney(2000, "en") }));
    expect(html).toContain(t("en", "site.blocks.pricing.members", { amount: formatMoney(3000, "en") }));
    expect(html.match(/data-ticket-type=/g)).toHaveLength(3);
    expect(html).toContain('data-action="tickets"');
    expect(html).toContain(`href="/en/account/book/${s.id}"`);
    // The JSON-LD offer falls back to the lowest public ticket price that anyone can buy.
    expect(eventOfferPrice(f!)).toBe(2500);
  });

  it("shows the members line of an event priced by its session product", async () => {
    const product = await makeProduct(handle.db, { kind: "ticket", priceCents: 3000, memberDiscountPct: "10.00" });
    const s = await publishedEvent({ productId: product.id });
    const f = await getEventFacts(s.id, "nl-BE");
    expect(f).toMatchObject({ priceCents: 3000, memberPriceCents: 2700, ticketTypes: [] });
    const html = render(f, "nl-BE", new Date());
    expect(html).toContain(t("nl-BE", "site.blocks.pricing.members", { amount: formatMoney(2700, "nl-BE") }));
  });

  it("during the lead window shows the priority line and Check your access, never a count, a rank or a booking button", async () => {
    const product = await makeProduct(handle.db, { kind: "ticket", priceCents: 2000 });
    const end = new Date(Date.now() + 2.3 * DAY);
    const s = await publishedEvent({ productId: product.id, isLeadMagnet: true, leadReservedSeats: 10, leadWindowStartAt: new Date(Date.now() - HOUR), leadWindowEndAt: end });
    const f = await getEventFacts(s.id, "en");
    expect(f).toMatchObject({ priorityUntil: end.toISOString(), accessDependsOnViewer: true });
    expect(eventAction(f!, new Date())).toEqual({ kind: "check_access", href: `/en/account/book/${s.id}`, labelKey: "site.blocks.events.checkAccess" });

    const html = render(f, "en", new Date());
    expect(html).toContain(t("en", "site.blocks.events.priorityUntil", { date: formatDateTime(end, "en", "long") }));
    expect(html).toContain('data-action="check_access"');
    expect(html).toContain(t("en", "site.blocks.events.checkAccess"));
    expect(html).not.toContain(t("en", "site.blocks.events.getTickets"));
    expect(html).not.toContain("data-band");
    expect(html).not.toMatch(/\b(30|40|10) (places|seats)\b/);
  });

  it("before and after the lead window books normally", async () => {
    const before = await publishedEvent({ isLeadMagnet: true, leadReservedSeats: 10, leadWindowStartAt: new Date(Date.now() + DAY), leadWindowEndAt: new Date(Date.now() + 3 * DAY) });
    const f = await getEventFacts(before.id, "en");
    expect(f).toMatchObject({ priorityUntil: null, accessDependsOnViewer: false });
    expect(render(f, "en", new Date())).toContain('data-action="tickets"');
  });

  it("a full event shows the waitlist entry", async () => {
    const s = await publishedEvent({ capacitySeats: 1 });
    const person = await makePerson(handle.db);
    await handle.db.insert(bookings).values({ sessionId: s.id, personId: person.id, status: "confirmed", paidWith: "free", source: "admin" });
    const f = await getEventFacts(s.id, "fr-BE");
    expect(f?.band).toBe("full");
    const html = render(f, "fr-BE", new Date());
    expect(html).toContain('data-action="waitlist"');
    expect(html).toContain(t("fr-BE", "site.blocks.events.joinWaitlist").replace("'", "&#x27;"));
    expect(html).toContain(`href="/fr/account/book/${s.id}"`);
  });

  it("a webinar-linked event shows Register for the webinar to the webinar page in the page locale", async () => {
    const webinarId = randomUUID();
    const s = await publishedEvent({ webinarId });
    vi.mocked(webinar.getWebinarForSession).mockResolvedValue({
      id: webinarId,
      slug: "ademwerk-avond",
      title: { "nl-BE": "Ademwerk", "fr-BE": "Respiration", en: "Breathwork" },
      mode: "live",
      status: "scheduled",
      startsAt: s.startsAt,
      sessionId: s.id,
      spokenLocale: "nl-BE",
      landingPath: "/nl/webinars/ademwerk-avond",
    } as Awaited<ReturnType<typeof WebinarApi.getWebinarForSession>>);
    const f = await getEventFacts(s.id, "fr-BE");
    expect(webinar.getWebinarForSession).toHaveBeenCalledWith(expect.anything(), s.id);
    expect(f).toMatchObject({ isWebinar: true, webinar: { href: "/fr/webinars/ademwerk-avond" }, band: null });
    const html = render(f, "fr-BE", new Date());
    expect(html).toContain('data-action="webinar"');
    expect(html).toContain('href="/fr/webinars/ademwerk-avond"');
    expect(html).toContain(t("fr-BE", "site.blocks.events.registerWebinar"));
    expect(html).not.toContain("/account/book/");
  });

  it("a webinar-linked event shows no button while webinars are not public", async () => {
    webinarFlag.mockResolvedValue(false);
    const s = await publishedEvent({ webinarId: randomUUID() });
    const f = await getEventFacts(s.id, "en");
    expect(f).toMatchObject({ isWebinar: true, webinar: null });
    expect(webinar.getWebinarForSession).not.toHaveBeenCalled();
    expect(render(f, "en", new Date())).not.toContain("data-action");
  });
});

describe("EventFactsView", () => {
  it("formats the lead window end in Europe/Brussels", () => {
    // 22:30 UTC on 30 June is 00:30 on 1 July in Brussels (summer time).
    const html = render(facts({ priorityUntil: "2026-06-30T22:30:00.000Z", accessDependsOnViewer: true }), "nl-BE", NOW);
    const brusselsDay = new Intl.DateTimeFormat("nl-BE", { timeZone: "Europe/Brussels", day: "numeric", month: "long" }).format(new Date("2026-06-30T22:30:00.000Z"));
    expect(brusselsDay).toBe("1 juli");
    expect(html).toContain("1 juli 2026");
    expect(html).toContain("00:30");
  });

  it("past and cancelled events show their banner and no action", () => {
    const past = render(facts({ priorityUntil: "2026-07-01T10:00:00.000Z", accessDependsOnViewer: true }), "en", new Date("2026-08-01T10:00:00.000Z"));
    expect(past).toContain(t("en", "site.blocks.events.past"));
    expect(past).not.toContain("data-action");
    expect(past).not.toContain("data-lead-window");
    const cancelled = render(facts({ status: "cancelled" }), "en", NOW);
    expect(cancelled).toContain(t("en", "site.blocks.events.cancelled"));
    expect(cancelled).not.toContain("data-action");
  });

  it("ticket types sold out or not yet on sale say so; all sold out leads to the waitlist", () => {
    const tt = (id: string, extra: Partial<EventFacts["ticketTypes"][number]>) => ({ id, name: id, publicCents: 1000, memberCents: null, isMemberOnly: false, onSale: true, salesStartAt: null, soldOut: false, ...extra });
    const f = facts({ ticketTypes: [tt("early", { soldOut: true }), tt("late", { onSale: false, salesStartAt: "2026-06-25T08:00:00.000Z" })] });
    const html = render(f, "en", NOW);
    expect(html).toContain(t("en", "site.blocks.events.soldOut"));
    expect(html).toContain(t("en", "site.blocks.events.salesFrom", { date: formatDateTime("2026-06-25T08:00:00.000Z", "en", "long") }));
    expect(html).toContain('data-action="tickets"');
    const allGone = facts({ ticketTypes: [tt("a", { soldOut: true }), tt("b", { soldOut: true })] });
    expect(eventAction(allGone, NOW)?.kind).toBe("waitlist");
  });

  it("renders nothing without facts", () => {
    expect(render(null)).toBe("");
  });
});

describe("webinar_signup block", () => {
  it("renders webinar's WebinarSignup with the block's webinarId and the page locale", () => {
    const webinarId = randomUUID();
    const html = renderToStaticMarkup(
      createElement(WebinarSignupBlockView, {
        block: { id: randomUUID(), type: "webinar_signup", webinarId },
        ctx: { locale: "nl-BE", tr: trFor("nl-BE"), data: emptyRenderData("nl-BE", "/nl/webinar") },
      }),
    );
    expect(webinar.WebinarSignup).toHaveBeenCalledWith(expect.objectContaining({ webinarId, locale: "nl-BE" }), undefined);
    expect(html).toContain(`data-webinar-signup="${webinarId}"`);
    expect(html).toContain('data-locale="nl-BE"');
  });
});
