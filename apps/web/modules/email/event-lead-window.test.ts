/**
 * email-P8, scenario 3 (email side): the `event` block with `showLeadWindow`. While a Lead Magnet
 * session is in its lead window with no general seat left, booking's `getSessionCards` carries
 * `opensForCustomersAt`; a recipient whose status is `lead` sees the booking button, any other
 * recipient "Opens for you on <date time>" (booking's portal format) and a link to the event.
 * After the release (`opensForCustomersAt` null) both see the button. The cards come from
 * booking's real `getSessionCards` on a lead-magnet session; the render goes through
 * `renderEmail` both ways `email.send` uses it: compiled on the fly and precompiled at publish.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb, makeSession } from "@beam/db/testing";
import { sessions } from "@beam/db/schema";
import type { Block, BlockDocument } from "@beam/core/email";
import { formatDateTime, LOCALES, type Locale } from "@beam/core/i18n";
import { buildFooter, DEFAULT_FOOTER_SETTINGS, compileDocument, selectVariant, type EventCard, type PersonStatus, type ResolveCards } from "@beam/email";
import { renderEmail } from "@beam/email/render";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { getSessionCards } from "@/modules/booking/api";
import { COMPANY } from "./email-p3.fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CTA: Record<Locale, string> = { "nl-BE": "Reserveer je plaats", "fr-BE": "Réservez votre place", en: "Book your seat" };
const OPENS: Record<Locale, string> = { "nl-BE": "Opent voor jou op", "fr-BE": "Ouvert pour vous le", en: "Opens for you on" };
const STATUSES: (PersonStatus | null)[] = ["lead", "customer", "member", null];

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** A Lead Magnet event whose seats are all reserved for leads: no general seat, so customers wait for the window end. */
async function leadMagnet(windowEndAt = new Date(Date.now() + DAY)) {
  return makeSession(h.db, {
    kind: "event",
    creditKind: null,
    creditCost: 0,
    capacitySeats: 2,
    startsAt: new Date(Date.now() + 5 * DAY),
    isLeadMagnet: true,
    leadReservedSeats: 2,
    leadWindowStartAt: new Date(Date.now() - 2 * DAY),
    leadWindowEndAt: windowEndAt,
  });
}

/** Booking's cards mapped onto the renderer's `EventCard`, `opensForCustomersAt` included (the event page link is the portal booking URL here). */
function bookingCards(locale: Locale): ResolveCards {
  return async (refs) => {
    const events: Record<string, EventCard> = {};
    for (const s of await getSessionCards(h.db, refs.sessionIds, locale)) {
      events[s.sessionId] = { id: s.sessionId, title: s.title, startsAt: s.startsAt, url: `https://beam.be${s.bookUrl}`, active: true, opensForCustomersAt: s.opensForCustomersAt };
    }
    return { products: {}, events };
  };
}

const eventDoc = (sessionId: string, showLeadWindow = true): BlockDocument => ({
  schemaVersion: 1,
  locales: Object.fromEntries(
    LOCALES.map((l) => [l, [{ id: "ev00000001", type: "event", sessionId, ctaLabel: CTA[l], ...(showLeadWindow ? { showLeadWindow: true } : {}) } satisfies Block]]),
  ),
});

const footerFor = (locale: Locale) =>
  buildFooter({ company: COMPANY, footerSettings: DEFAULT_FOOTER_SETTINGS, legalLinks: { privacy: "https://beam.be/privacy", terms: "https://beam.be/terms" }, purpose: "events", locale });

/** `email.send`'s on-the-fly path: the document, the recipient's status, the cards resolved now. */
async function renderFor(doc: BlockDocument, locale: Locale, status: PersonStatus | null) {
  return renderEmail({ source: "blocks", locale, subject: { [locale]: "Vitality Evening" }, document: doc, recipient: { status, outcomes: {} }, footer: footerFor(locale), resolveCards: bookingCards(locale) });
}

describe("event block with the lead window (scenario 3, email side)", () => {
  it("a lead inside the window sees the booking button; customers and members see \"Opens for you on ...\"", async () => {
    const session = await leadMagnet();
    const [card] = await getSessionCards(h.db, [session.id], "en");
    expect(card?.opensForCustomersAt).not.toBeNull(); // precondition: booking says customers wait

    const lead = await renderFor(eventDoc(session.id), "en", "lead");
    expect(lead.html).toContain(CTA.en);
    expect(lead.html).not.toContain(OPENS.en);
    expect(lead.text).toContain(`${CTA.en} (https://beam.be/en/account/book/${session.id})`);

    const opensText = `${OPENS.en} ${formatDateTime(session.leadWindowEndAt!, "en", "full")}`;
    for (const status of ["customer", "member", null] as const) {
      const r = await renderFor(eventDoc(session.id), "en", status);
      expect(r.html).toContain(opensText);
      expect(r.html).not.toContain(CTA.en);
      expect(r.text).toContain(opensText);
      // The link still leads to the booking page, which shows the customer queue (booking edge case 37).
      expect(r.html).toContain(`https://beam.be/en/account/book/${session.id}`);
    }
  });

  it("writes the notice in the recipient's language with the Brussels date of the window end", async () => {
    const session = await leadMagnet(new Date(Date.now() + 1.5 * DAY));
    for (const locale of LOCALES) {
      const r = await renderFor(eventDoc(session.id), locale, "customer");
      expect(r.html).toContain(OPENS[locale]);
      expect(r.text).toContain(formatDateTime(session.leadWindowEndAt!, locale, "full"));
      expect(r.html).not.toContain(CTA[locale]);
    }
  });

  it("after the release both a lead and a customer see the booking button", async () => {
    const session = await leadMagnet();
    await h.db
      .update(sessions)
      .set({ leadWindowStartAt: new Date(Date.now() - 3 * DAY), leadWindowEndAt: new Date(Date.now() - HOUR) })
      .where(eq(sessions.id, session.id));
    const [card] = await getSessionCards(h.db, [session.id], "en");
    expect(card?.opensForCustomersAt).toBeNull();
    for (const status of STATUSES) {
      const r = await renderFor(eventDoc(session.id), "en", status);
      expect(r.html).toContain(CTA.en);
      expect(r.html).not.toContain(OPENS.en);
    }
  });

  it("the precompiled versions of publish carry both views, and each recipient gets theirs", async () => {
    const session = await leadMagnet();
    const doc = eventDoc(session.id);
    const compiled = await compileDocument(doc, ["en"], { footerFor, resolveCards: bookingCards("en") });
    expect(Object.keys(compiled.htmlByLocale.en!).sort()).toEqual(["lead_window:0", "lead_window:f"]);
    expect(selectVariant(doc, "en", { status: "lead", outcomes: {} })).toBe("lead_window:0");
    expect(selectVariant(doc, "en", { status: "customer", outcomes: {} })).toBe("lead_window:f");
    const send = (status: PersonStatus | null) =>
      renderEmail({ source: "blocks", locale: "en", subject: { en: "Vitality Evening" }, document: doc, compiled, recipient: { status, outcomes: {} } });
    expect((await send("lead")).html).toContain(CTA.en);
    expect((await send("customer")).html).toContain(OPENS.en);
    // Without a recipient the renderer falls back to the cautious view.
    expect((await renderEmail({ source: "blocks", locale: "en", subject: { en: "Vitality Evening" }, compiled })).html).toContain(OPENS.en);
  });

  it("combines with dynamic blocks: one path per variant and view", async () => {
    const session = await leadMagnet();
    const blocks: Block[] = [
      { id: "dy00000001", type: "dynamic", variants: [{ when: { status: "member" }, blocks: [{ id: "tx00000001", type: "text", markdown: "Members first." }] }], fallback: [] },
      { id: "ev00000001", type: "event", sessionId: session.id, ctaLabel: CTA.en, showLeadWindow: true },
    ];
    const doc: BlockDocument = { schemaVersion: 1, locales: { en: blocks } };
    const compiled = await compileDocument(doc, ["en"], { footerFor, resolveCards: bookingCards("en") });
    expect(Object.keys(compiled.htmlByLocale.en!).sort()).toEqual(["dy00000001:0,lead_window:0", "dy00000001:0,lead_window:f", "dy00000001:f,lead_window:0", "dy00000001:f,lead_window:f"]);
    expect(selectVariant(doc, "en", { status: "member", outcomes: {} })).toBe("dy00000001:0,lead_window:f");
    expect(selectVariant(doc, "en", { status: "lead", outcomes: {} })).toBe("dy00000001:f,lead_window:0");
  });

  it("an event block without the option keeps the booking button for everyone", async () => {
    const session = await leadMagnet();
    const doc = eventDoc(session.id, false);
    expect(selectVariant(doc, "en", { status: "customer", outcomes: {} })).toBe("default");
    for (const status of STATUSES) {
      const r = await renderFor(doc, "en", status);
      expect(r.html).toContain(CTA.en);
      expect(r.html).not.toContain(OPENS.en);
    }
  });
});
