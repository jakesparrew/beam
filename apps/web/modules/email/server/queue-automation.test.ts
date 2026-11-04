/**
 * email-P3: `queueMarketingEmail` and `queueAutomationEmail` (email spec rules 39, 39a, 42;
 * cross-module D54). The registry templates that declare `loadProps` (commerce's
 * `checkout_recovery`, webinar's `reminder`) belong to later packages, so this test adds
 * stand-ins with the same keys to the registry; their copy reuses platform's magic-link slots.
 */
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { sql, ValidationError } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, type FakeIntegrations } from "@/lib/testing";
import { queueAutomationEmail, queueMarketingEmail } from "../api";
import { sendEmailMessage } from "../jobs";
import { blockTemplate, completeCompany, consent, messageOf, personWith, resetEmailTables, sendJobOf } from "../email-p3.fixtures";

const seen = vi.hoisted(() => ({ calls: [] as { context: Record<string, string>; stepKey: string | null }[] }));

vi.mock("@beam/email/templates/registry", async (orig) => {
  const real = await orig<typeof import("@beam/email/templates/registry")>();
  const { defineTemplate } = await import("@beam/email/templates/define");
  const { EmailLayout, EmailText } = await import("@beam/email/layout");
  const slots = {
    subject: "platform.email.magic_link.subject",
    preheader: "platform.email.magic_link.preheader",
    heading: "platform.email.magic_link.heading",
    body: "platform.email.magic_link.body",
    cta: "platform.email.magic_link.cta",
  };
  const body = (text: string, locale: "nl-BE" | "fr-BE" | "en") => createElement(EmailLayout, { locale, preheader: "x", children: createElement(EmailText, { children: text }) });
  const checkoutRecovery = defineTemplate({
    name: "checkout_recovery",
    props: z.object({ checkoutUrl: z.string().url(), expiresMinutes: z.number().int() }),
    slots,
    component: (p) => createElement("div", null, body(`Finish your order ${p.checkoutUrl}`, p.locale)),
    loadProps: (_tx, args) => {
      seen.calls.push({ context: args.context, stepKey: args.stepKey });
      return Promise.resolve({ checkoutUrl: `https://beam.be/nl/checkout/${args.context.checkout_id ?? "none"}`, expiresMinutes: 60 });
    },
  });
  const reminder = defineTemplate({
    name: "reminder",
    props: z.object({ variant: z.enum(["d7", "d3", "h3"]), expiresMinutes: z.number().int() }),
    slots,
    component: (p) => createElement("div", null, body(`Reminder ${p.variant}`, p.locale)),
    loadProps: (_tx, args) => {
      seen.calls.push({ context: args.context, stepKey: args.stepKey });
      return Promise.resolve({ variant: (args.stepKey ?? "d7") as "d7" | "d3" | "h3", expiresMinutes: 5 });
    },
  });
  const plain = defineTemplate({ name: "no_loader", props: z.object({ expiresMinutes: z.number().int() }), slots, component: (p) => body("plain", p.locale) });
  return {
    ...real,
    TEMPLATE_REGISTRY: { ...real.TEMPLATE_REGISTRY, "commerce.checkout_recovery": checkoutRecovery, "webinar.reminder": reminder, "commerce.no_loader": plain },
  };
});

let h: DbHandle;
let fakes: FakeIntegrations;
beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
  await blockTemplate(h.db, { slug: "p3q-newsletter", kind: "marketing", purpose: "newsletter" });
  await blockTemplate(h.db, { slug: "p3q-events-en", kind: "marketing", purpose: "events", locales: ["en"] });
  await blockTemplate(h.db, { slug: "automation.p3q_welcome", kind: "transactional" });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await resetEmailTables(h.db);
  seen.calls.length = 0;
  fakes = createFakeIntegrations();
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("INTEGRATIONS", "fake");
  vi.stubEnv("APP_URL", "https://beam.be");
});
afterEach(() => vi.unstubAllEnvs());

const enrolment = () => crypto.randomUUID();
const send = (id: string, template: string) => sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId: id, template });

describe("queueMarketingEmail", () => {
  it("returns skipped_unreachable with a suppressed row, and skipped_translation with a blocked_translation row", async () => {
    const p = await personWith(h.db);
    const unreachable = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "p3q-newsletter", personId: p.id, enrolmentId: enrolment(), idempotencyKey: "p3q:unreach", context: {} });
    expect(unreachable).toMatchObject({ status: "skipped_unreachable", created: true });
    expect((await messageOf(h.db, unreachable.messageId)).status).toBe("suppressed");
    expect(await sendJobOf(h.db, unreachable.messageId)).toBeUndefined();

    await consent(h.db, p.id, "events", "granted");
    const translation = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "p3q-events-en", personId: p.id, enrolmentId: enrolment(), idempotencyKey: "p3q:translation", context: {} });
    expect(translation.status).toBe("skipped_translation");
    expect((await messageOf(h.db, translation.messageId)).status).toBe("blocked_translation");
  });

  it("refuses a block-backed transactional template and a registry template without loadProps; queueAutomationEmail refuses a marketing one", async () => {
    const p = await personWith(h.db);
    const base = { personId: p.id, enrolmentId: enrolment(), context: {} };
    await expect(queueMarketingEmail(makeCtx(h.db), { ...base, templateSlug: "automation.p3q_welcome", idempotencyKey: "p3q:r1" })).rejects.toBeInstanceOf(ValidationError);
    await expect(queueMarketingEmail(makeCtx(h.db), { ...base, templateSlug: "commerce.no_loader", idempotencyKey: "p3q:r2" })).rejects.toBeInstanceOf(ValidationError);
    await expect(queueAutomationEmail(makeCtx(h.db), { ...base, templateSlug: "p3q-newsletter", idempotencyKey: "p3q:r3" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("commerce.checkout_recovery is a commercial message: newsletter, news.beam.be, marketing footer, List-Unsubscribe and tracking (D54)", async () => {
    const p = await personWith(h.db);
    await consent(h.db, p.id, "newsletter", "granted");
    const r = await queueMarketingEmail(makeCtx(h.db), {
      templateSlug: "commerce.checkout_recovery",
      personId: p.id,
      enrolmentId: enrolment(),
      idempotencyKey: "p3q:recovery",
      context: { checkout_id: "chk-1" },
      stepKey: "recover_1",
    });
    expect(r.status).toBe("queued");
    const m = await messageOf(h.db, r.messageId);
    expect(m).toMatchObject({ kind: "automation", purpose: "newsletter", fromDomain: "news.beam.be" });
    expect(await send(r.messageId, "commerce.checkout_recovery")).toMatchObject({ status: "sent" });
    const sent = fakes.resend.sent[0]!;
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent.html).toContain("/api/public/track/open?t=");
    expect(sent.html).toContain("commerciële boodschap");
    expect(sent.html).toContain("Uitschrijven voor de nieuwsbrief");

    const other = await personWith(h.db);
    const skipped = await queueMarketingEmail(makeCtx(h.db), {
      templateSlug: "commerce.checkout_recovery",
      personId: other.id,
      enrolmentId: enrolment(),
      idempotencyKey: "p3q:recovery:unreachable",
      context: { checkout_id: "chk-2" },
    });
    expect(skipped.status).toBe("skipped_unreachable");
  });

  it("the same key twice is one message and created: false", async () => {
    const p = await personWith(h.db);
    await consent(h.db, p.id, "newsletter", "granted");
    const input = { templateSlug: "p3q-newsletter", personId: p.id, enrolmentId: enrolment(), idempotencyKey: "p3q:twice", context: {} };
    const a = await queueMarketingEmail(makeCtx(h.db), input);
    const b = await queueMarketingEmail(makeCtx(h.db), input);
    expect(a.created).toBe(true);
    expect(b).toEqual({ ...a, created: false });
  });
});

describe("queueAutomationEmail", () => {
  it("writes kind automation, purpose null and mail.beam.be", async () => {
    const p = await personWith(h.db, { locale: "fr-BE" });
    const r = await queueAutomationEmail(makeCtx(h.db), { templateSlug: "automation.p3q_welcome", personId: p.id, enrolmentId: enrolment(), idempotencyKey: "p3q:welcome", context: {} });
    expect(r.status).toBe("queued");
    expect(await messageOf(h.db, r.messageId)).toMatchObject({ kind: "automation", purpose: null, fromDomain: "mail.beam.be", locale: "fr-BE" });
    expect((await sendJobOf(h.db, r.messageId))?.priority).toBe(5);
    expect(await send(r.messageId, "automation.p3q_welcome")).toMatchObject({ status: "sent" });
    expect(fakes.resend.sent[0]!.headers["List-Unsubscribe"]).toBeUndefined();
  });

  it("builds props with loadProps from context and stepKey; a template without loadProps fails with invalid_template_data", async () => {
    const p = await personWith(h.db);
    const r = await queueAutomationEmail(makeCtx(h.db), {
      templateSlug: "webinar.reminder",
      personId: p.id,
      enrolmentId: enrolment(),
      idempotencyKey: "p3q:reminder",
      context: { registration_id: "reg-1" },
      stepKey: "d3",
    });
    expect(seen.calls).toEqual([{ context: { registration_id: "reg-1" }, stepKey: "d3" }]);
    expect((await messageOf(h.db, r.messageId)).props).toEqual({ variant: "d3", expiresMinutes: 5 });
    expect(await send(r.messageId, "webinar.reminder")).toMatchObject({ status: "sent" });
    expect(fakes.resend.sent[0]!.html).toContain("Reminder d3");

    const plain = await queueAutomationEmail(makeCtx(h.db), { templateSlug: "commerce.no_loader", personId: p.id, enrolmentId: enrolment(), idempotencyKey: "p3q:plain", context: {} });
    await expect(send(plain.messageId, "commerce.no_loader")).rejects.toThrow(/invalid_template_data/);
    expect(await messageOf(h.db, plain.messageId)).toMatchObject({ status: "failed", error: "invalid_template_data" });
  });

  it("reads the context from the enrolment when none is given", async () => {
    const p = await personWith(h.db);
    const id = crypto.randomUUID();
    const db = h.db;
    await db.execute(sql`insert into automation_groups (id, key, name) values (${id}::uuid, ${`p3q_${id.slice(0, 8)}`}, 'P3 group')`);
    await db.execute(sql`insert into automations (id, slug, name, group_id, is_marketing) values (${id}::uuid, ${`p3q-${id.slice(0, 8)}`}, 'P3', ${id}::uuid, false)`);
    await db.execute(sql`insert into automation_versions (id, automation_id, version, definition, definition_hash) values (${id}::uuid, ${id}::uuid, 1, '{}'::jsonb, 'x')`);
    await db.execute(sql`
      insert into automation_enrolments (id, automation_id, automation_version_id, person_id, group_id, source, context)
      values (${id}::uuid, ${id}::uuid, ${id}::uuid, ${p.id}::uuid, ${id}::uuid, 'trigger', ${JSON.stringify({ registration_id: "reg-9", count: 3 })}::jsonb)`);
    const r = await queueAutomationEmail(makeCtx(h.db), { templateSlug: "webinar.reminder", personId: p.id, enrolmentId: id, idempotencyKey: "p3q:enrolment-context", stepKey: "h3" });
    expect(seen.calls).toEqual([{ context: { registration_id: "reg-9" }, stepKey: "h3" }]);
    expect((await messageOf(h.db, r.messageId)).context).toEqual({ registration_id: "reg-9" });
  });
});

