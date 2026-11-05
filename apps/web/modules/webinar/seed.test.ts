/**
 * webinar templates, seeds and discovery reads (webinar-P3; spec sections 4.7, 4.8 and 8): the
 * five registry templates render in three locales; `reminder` and `replay_available` build their
 * props with `loadProps` from `context.registration_id` and the step key; `access` attaches the
 * `.ics`; the defaults seed writes `webinar-follow-up` once through `email.seedTemplate`; the
 * merge fields resolve from `context` only; `getWebinarCards` leaves out non-public webinars; the
 * id URL of a landing page answers 308; the `.ics` route carries no personal link.
 * `ff_webinar_portal` is mocked on for the page.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { emailTemplates, emailTemplateVersions } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { LOCALES } from "@beam/core/i18n";
import { renderEmail } from "@beam/email/render";
import { TEMPLATE_REGISTRY } from "@beam/email/templates/registry";
import { templates } from "@beam/email/templates/webinar";
import { seedWebinarRows, WEBINAR_FOLLOW_UP_SLUG } from "@beam/db/seed/webinar";
import { eq } from "@/lib/ctx";
import { makeCtx } from "@/lib/testing";
import { seedTemplate } from "@/modules/email/api";
import { GET as icsRoute } from "@/app/api/public/webinars/[slug]/ics/route";
import LandingPage from "@/app/[locale]/(site)/webinars/[slug]/page";
import { getWebinarCards } from "./api";
import { mergeFields } from "./merge-fields";
import { makeRegistration, makeWebinar, WEBINAR_TITLE } from "./test/factories";

vi.mock("@/lib/flags", async (orig) => ({ ...(await orig<Record<string, unknown>>()), flag: vi.fn(() => Promise.resolve(true)) }));

let h: DbHandle;
let ownerId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db);
  ownerId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(async () => {
  await h.close();
});

const byName = (name: string) => templates.find((t) => t.name === name)!;

describe("templates/webinar/index.ts (section 8)", () => {
  it("declares exactly the five names, keyed webinar.<name> in the registry", () => {
    expect(templates.map((t) => t.name).sort()).toEqual(["access", "cancelled", "reminder", "replay_available", "rescheduled"]);
    for (const t of templates) expect(TEMPLATE_REGISTRY[`webinar.${t.name}` as keyof typeof TEMPLATE_REGISTRY]).toBe(t);
  });

  it.each(LOCALES)("each template renders in %s with its sample props", async (locale) => {
    for (const t of templates) {
      const out = await renderEmail({ source: "code", template: t, locale, props: t.sample });
      expect(out.subject.length, `${t.name} subject`).toBeGreaterThan(0);
      expect(out.html).toContain("<html");
      expect(out.subject).not.toMatch(/webinar\.email\./);
    }
  });

  it("the reminder subject follows the variant", async () => {
    const t = byName("reminder");
    const subjects = await Promise.all((["d7", "d3", "h3"] as const).map(async (variant) => (await renderEmail({ source: "code", template: t, locale: "en", props: { ...t.sample, variant } })).subject));
    expect(new Set(subjects).size).toBe(3);
    expect(subjects[0]).toMatch(/^Next week/);
    expect(subjects[2]).toMatch(/^Today/);
  });

  it("access attaches the .ics with the landing URL and never the personal link; on-demand attaches nothing", async () => {
    const t = byName("access");
    const sample = t.sample as Record<string, string | null>;
    const files = await t.attachments!(t.sample, "nl-BE");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: "webinar.ics", contentType: expect.stringContaining("text/calendar") });
    const ics = new TextDecoder().decode(files[0]!.content);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART:20270112T180000Z");
    expect(ics).toContain(sample.landingUrl!);
    expect(ics).not.toContain("/w/");
    expect(await t.attachments!({ ...t.sample, startsAt: null, endsAt: null, icsUrl: null, date: "" }, "nl-BE")).toEqual([]);
  });

  it("reminder and replay_available build props through loadProps from context.registration_id and stepKey", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, replayUntilAt: new Date("2030-02-01T12:00:00Z") }, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const context = { registration_id: r.id, webinar_id: w.id };
    const reminder = await byName("reminder").loadProps!(h.db, { personId: r.personId, locale: "fr-BE", context, stepKey: "d3" });
    expect(reminder).toMatchObject({ variant: "d3", title: WEBINAR_TITLE["fr-BE"], registrationId: r.id, webinarId: w.id });
    expect((reminder as { accessUrl: string }).accessUrl).toContain(`/fr/w/${r.token}`);
    expect(byName("reminder").props.safeParse(reminder).success).toBe(true);
    await expect(byName("reminder").loadProps!(h.db, { personId: r.personId, locale: "fr-BE", context, stepKey: "follow_up" })).rejects.toThrow();

    const replay = await byName("replay_available").loadProps!(h.db, { personId: r.personId, locale: "en", context, stepKey: "replay" });
    expect(replay).toMatchObject({ title: WEBINAR_TITLE.en, registrationId: r.id });
    expect((replay as { until: string }).until).toMatch(/2030/);
    expect((replay as { accessUrl: string }).accessUrl).toContain(`/en/w/${r.token}`);
    expect(byName("replay_available").props.safeParse(replay).success).toBe(true);

    // Another person's registration or a missing id is refused.
    const stranger = await makePerson(h.db);
    await expect(byName("replay_available").loadProps!(h.db, { personId: stranger.id, locale: "en", context, stepKey: null })).rejects.toThrow();
    await expect(byName("replay_available").loadProps!(h.db, { personId: r.personId, locale: "en", context: {}, stepKey: null })).rejects.toThrow();
  });
});

describe("the defaults seed (section 8)", () => {
  it("calls email.seedTemplate once for webinar-follow-up (marketing, events); a second run leaves it unchanged", async () => {
    const writer = vi.fn((db: unknown, input: Parameters<typeof seedTemplate>[1]) => seedTemplate(db as Tx, input));
    expect(await seedWebinarRows(h.db, { seedTemplate: writer })).toEqual({ templates: 1 });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[0]![1]).toMatchObject({ slug: WEBINAR_FOLLOW_UP_SLUG, kind: "marketing", purpose: "events" });
    const [row] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.slug, WEBINAR_FOLLOW_UP_SLUG));
    expect(row).toMatchObject({ kind: "marketing", purpose: "events" });
    const versions = await h.db.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.templateId, row!.id));
    const doc = JSON.stringify(versions.map((v) => v.document));
    for (const field of ["{{webinar.title}}", "{{webinar.access_url}}", "{{webinar.starts_at_local"]) expect(doc).toContain(field);
    expect(doc).not.toContain('"type":"webinar"');
    for (const v of versions) expect([...v.locales].sort()).toEqual([...LOCALES].sort());

    await h.db.update(emailTemplates).set({ name: "Edited by BEAM" }).where(eq(emailTemplates.id, row!.id));
    expect(await seedWebinarRows(h.db, { seedTemplate: writer })).toEqual({ templates: 0 });
    const [again] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.slug, WEBINAR_FOLLOW_UP_SLUG));
    expect(again).toMatchObject({ id: row!.id, name: "Edited by BEAM" });
    expect(await h.db.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.templateId, row!.id))).toHaveLength(versions.length);
  });
});

describe("merge fields (section 4.8)", () => {
  it("resolve access_url, title and starts_at_local from context, and null without it", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const args = { tx: h.db, personId: r.personId, context: { registration_id: r.id }, locale: "nl-BE" as const };
    expect(await mergeFields.access_url(args)).toContain(`/nl/w/${r.token}`);
    expect(await mergeFields.title(args)).toBe(WEBINAR_TITLE["nl-BE"]);
    expect(await mergeFields.title({ ...args, context: { webinar_id: w.id }, locale: "en" })).toBe(WEBINAR_TITLE.en);
    expect(await mergeFields.starts_at_local(args)).toMatch(/\d{2}:\d{2}/);
    for (const f of Object.values(mergeFields)) expect(await f({ ...args, context: {} })).toBeNull();
    // A personal link never resolves for another recipient.
    expect(await mergeFields.access_url({ ...args, personId: (await makePerson(h.db)).id })).toBeNull();
  });
});

describe("discovery reads and public routes", () => {
  it("getWebinarCards leaves out draft, cancelled and archived ids and keeps the order of ids", async () => {
    const a = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const b = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "on_demand", startsAt: null }, { published: true });
    const draft = await makeWebinar(h.db, { ownerUserId: ownerId });
    const cancelled = await makeWebinar(h.db, { ownerUserId: ownerId, status: "cancelled", cancelledReason: "test" });
    const archived = await makeWebinar(h.db, { ownerUserId: ownerId, mode: "on_demand", startsAt: null, status: "archived" }, { published: true });
    const cards = await getWebinarCards(h.db, [b.id, draft.id, a.id, cancelled.id, archived.id, "00000000-0000-4000-8000-000000000000"], "fr-BE");
    expect(cards.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(cards[1]).toMatchObject({ slug: a.slug, title: WEBINAR_TITLE["fr-BE"], mode: "live", landingUrl: expect.stringMatching(new RegExp(`/fr/webinars/${a.slug}$`)) });
  });

  it("the id URL of a landing page answers 308 to the slug", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const error = await Promise.resolve(LandingPage({ params: Promise.resolve({ locale: "nl", slug: w.id }) })).then(
      () => null,
      (e: unknown) => e as { digest?: string },
    );
    expect(error?.digest).toContain(`/nl/webinars/${w.slug}`);
    expect(error?.digest).toContain("308");
  });

  it("the .ics route carries the landing URL and no personal link", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    await makeRegistration(h.db, { webinarId: w.id });
    const res = await icsRoute(new Request(`http://localhost/api/public/webinars/${w.slug}/ics?locale=en`), { params: Promise.resolve({ slug: w.slug }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.text();
    expect(body).toContain(`SUMMARY:${WEBINAR_TITLE.en}`);
    expect(body).toContain(`/en/webinars/${w.slug}`);
    expect(body).not.toMatch(/\/w\//);
    const draft = await makeWebinar(h.db, { ownerUserId: ownerId });
    expect((await icsRoute(new Request(`http://localhost/api/public/webinars/${draft.slug}/ics`), { params: Promise.resolve({ slug: draft.slug }) })).status).toBe(404);
  });
});
