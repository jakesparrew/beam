/**
 * fix-w09-email-review: `email.send` fixes of the V1 review.
 *
 * - Finding 3: the link token is derived from the message id, so a retry after Resend accepted
 *   the first attempt sends a byte-identical payload under `email:<id>` and ends `sent` with the
 *   first resend id; the delivered token resolves.
 * - Finding 4: an all-scope suppression upgraded to `hard_bounce` blocks transactional mail.
 * - Finding 5: dynamic blocks with `assessmentOutcome` select on the person's latest outcome.
 * - Request email-P4: `email.send` builds its links with `unsubscribeLinksFor`, so a
 *   transactional `{{unsubscribe_url}}` resolves to null (its fallback).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { formSubmissions, forms, formVersions, suppressions } from "@beam/db/schema";
import type { BlockDocument } from "@beam/core/email";
import { emailHash } from "@beam/core/crm";
import { IntegrationError } from "@beam/integrations/_shared";
import type { SendEmailInput } from "@beam/integrations/resend";
import { and, eq, sql, type Tx } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, type FakeIntegrations } from "@/lib/testing";
import { addSuppression } from "@/modules/crm/api";
import { queueMarketingEmail, resolveLinkToken, seedTemplate, sendTransactional } from "./api";
import { sendEmailMessage } from "./jobs";
import { completeCompany, consent, messageOf, personWith, resetEmailTables } from "./email-p3.fixtures";
import { assessmentFormSlugs, linkTokenSecret } from "./server/send";

let h: DbHandle;
let fakes: FakeIntegrations;
beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await resetEmailTables(h.db);
  fakes = createFakeIntegrations();
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("INTEGRATIONS", "fake");
  vi.stubEnv("APP_URL", "https://beam.be");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const magic = { url: "https://example.com/nl/account/login/verify?token=abc", expiresMinutes: 15 };
const run = (emailMessageId: string, template = "platform.magic_link", tx?: Tx) =>
  sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes, ...(tx ? { tx } : {}) }), { emailMessageId, template });
const tokenIn = (html: string) => /\/preferences\/([A-Za-z0-9_-]{43})/.exec(html)?.[1] ?? null;
const L = ["nl-BE", "fr-BE", "en"] as const;
const each = (text: string) => Object.fromEntries(L.map((l) => [l, `${text} ${l}`]));
let blk = 0;
const id = () => `blkf09${String(++blk).padStart(4, "0")}`;

describe("finding 3: a retry after an accepted send is idempotent", () => {
  it("sends the same payload twice under email:<id>, ends sent with the first resend id, and the token resolves", async () => {
    const p = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "en", data: magic, key: "f09:retry" });
    const original = fakes.resend.sendEmail.bind(fakes.resend);
    const payloads = new Map<string, string>();
    const calls: string[] = [];
    let timeoutAfterAccept = true;
    vi.spyOn(fakes.resend, "sendEmail").mockImplementation(async (input: SendEmailInput) => {
      const body = JSON.stringify(input);
      const before = payloads.get(input.idempotencyKey);
      // Resend: the same Idempotency-Key with a different payload is a 409.
      if (before !== undefined && before !== body) {
        throw new IntegrationError({ provider: "resend", retryable: false, statusCode: 409, message: "invalid_idempotent_request" });
      }
      payloads.set(input.idempotencyKey, body);
      calls.push(body);
      const result = await original(input);
      if (timeoutAfterAccept) {
        timeoutAfterAccept = false;
        throw new IntegrationError({ provider: "resend", retryable: true, code: "timeout", message: "timed out after accepting" });
      }
      return result;
    });

    // Attempt 1: Resend accepts, the client times out, the job transaction rolls back.
    await expect(h.db.transaction((tx) => run(emailMessageId, "platform.magic_link", tx))).rejects.toThrow(/timed out/);
    expect((await messageOf(h.db, emailMessageId)).status).toBe("queued");
    const firstId = fakes.resend.sent[0]!.id;

    // Attempt 2: the same payload, so Resend replays the original send.
    expect(await h.db.transaction((tx) => run(emailMessageId, "platform.magic_link", tx))).toEqual({ status: "sent", resendId: firstId });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
    expect(fakes.resend.sent).toHaveLength(1);
    const m = await messageOf(h.db, emailMessageId);
    expect(m).toMatchObject({ status: "sent", resendId: firstId });

    const token = tokenIn(fakes.resend.sent[0]!.html ?? "");
    expect(token).not.toBeNull();
    expect(await resolveLinkToken(h.db, token!)).toMatchObject({ emailMessageId, personId: p.id });
  });

  it("the secret is EMAIL_LINK_TOKEN_SECRET, else AUTH_SECRET; production without either refuses", () => {
    expect(linkTokenSecret({ EMAIL_LINK_TOKEN_SECRET: "a", AUTH_SECRET: "b" })).toBe("a");
    expect(linkTokenSecret({ AUTH_SECRET: "b" })).toBe("b");
    expect(linkTokenSecret({ APP_ENV: "local" })).toMatch(/development/);
    expect(() => linkTokenSecret({ APP_ENV: "production" })).toThrow(/EMAIL_LINK_TOKEN_SECRET/);
  });
});

describe("finding 4: an upgraded all-scope suppression blocks transactional mail", () => {
  it("unsubscribed from everything, then hard-bounced: the next transactional message is suppressed", async () => {
    const p = await personWith(h.db);
    await addSuppression(h.db as unknown as Tx, makeCtx(h.db), { email: p.email!, scope: "all", reason: "unsubscribe", source: "test" });
    const magicBefore = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "en", data: magic, key: "f09:bounce:before" });
    // Rule 40/55: an all-scope unsubscribe never blocks transactional mail.
    expect(await run(magicBefore.emailMessageId)).toMatchObject({ status: "sent" });
    // The all-scope row now carries the stronger reason (crm's addSuppression upgrade, review finding 4).
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx
        .update(suppressions)
        .set({ reason: "hard_bounce" })
        .where(and(eq(suppressions.emailHash, emailHash(p.email!)), eq(suppressions.scope, "all")));
    });
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "en", data: magic, key: "f09:bounce" });
    expect(await run(emailMessageId)).toMatchObject({ status: "suppressed" });
    expect(fakes.resend.sent).toHaveLength(1);
  });
});

describe("finding 5: assessmentOutcome variants", () => {
  function outcomeDocument(): BlockDocument {
    const doc: BlockDocument = { schemaVersion: 1, locales: {} };
    for (const l of L) {
      (doc.locales as Record<string, unknown>)[l] = [
        { id: id(), type: "heading", level: 1, text: "Hello {{first_name|friend}}" },
        {
          id: id(),
          type: "dynamic",
          variants: [{ when: { assessmentOutcome: { formSlug: "energy-scan", outcomeKeys: ["high"] } }, blocks: [{ id: id(), type: "text", markdown: "VARIANT-HIGH" }] }],
          fallback: [{ id: id(), type: "text", markdown: "FALLBACK-TEXT" }],
        },
      ];
    }
    return doc;
  }

  it("assessmentFormSlugs lists the slugs of the document's dynamic conditions", () => {
    expect(assessmentFormSlugs(outcomeDocument(), "en")).toEqual(["energy-scan"]);
    expect(assessmentFormSlugs(null, "en")).toEqual([]);
  });

  it("an automation message renders the variant of the person's latest outcome, others get the fallback", async () => {
    await seedTemplate(h.db as unknown as Tx, {
      slug: "f09-outcome",
      name: "f09-outcome",
      kind: "marketing",
      purpose: "newsletter",
      subject: each("Subject"),
      preheader: each("Preheader"),
      document: outcomeDocument(),
    });
    const high = await personWith(h.db);
    const other = await personWith(h.db);
    await consent(h.db, high.id, "newsletter", "granted");
    await consent(h.db, other.id, "newsletter", "granted");
    // The latest completed submission counts: `high` was "low" before and is "high" now.
    const [f] = await h.db.insert(forms).values({ slug: "energy-scan", kind: "assessment", name: each("Energy scan") }).returning();
    const [fv] = await h.db.insert(formVersions).values({ formId: f!.id, version: 1, definition: { fields: [], settings: {} } as never, definitionHash: "f09", publishedAt: new Date() }).returning();
    const submit = (personId: string, outcomeKey: string, completedAt: Date) =>
      h.db.insert(formSubmissions).values({ formId: f!.id, formVersionId: fv!.id, personId, status: "completed", identifiedBy: "token", funnel: "form:energy-scan", locale: "nl-BE", outcomeKey, completedAt });
    await submit(high.id, "low", new Date(Date.now() - 86_400_000));
    await submit(high.id, "high", new Date());
    await submit(other.id, "low", new Date());

    const a = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "f09-outcome", personId: high.id, enrolmentId: crypto.randomUUID(), idempotencyKey: "f09:outcome:high", context: {} });
    const b = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "f09-outcome", personId: other.id, enrolmentId: crypto.randomUUID(), idempotencyKey: "f09:outcome:low", context: {} });
    expect(await run(a.messageId, "f09-outcome")).toMatchObject({ status: "sent" });
    expect(await run(b.messageId, "f09-outcome")).toMatchObject({ status: "sent" });

    const [first, second] = fakes.resend.sent;
    expect(first!.html).toContain("VARIANT-HIGH");
    expect(first!.html).not.toContain("FALLBACK-TEXT");
    expect(second!.html).toContain("FALLBACK-TEXT");
    expect(second!.html).not.toContain("VARIANT-HIGH");
  });
});

describe("request email-P4: links through unsubscribeLinksFor", () => {
  it("a transactional {{unsubscribe_url}} uses its fallback, {{preferences_url}} the token centre, and no List-Unsubscribe", async () => {
    const doc: BlockDocument = { schemaVersion: 1, locales: {} };
    for (const l of L) {
      (doc.locales as Record<string, unknown>)[l] = [{ id: id(), type: "text", markdown: "Stop: {{unsubscribe_url|no-link}}. Manage: {{preferences_url}}" }];
    }
    await seedTemplate(h.db as unknown as Tx, { slug: "automation.f09_links", name: "f09 links", kind: "transactional", purpose: null, subject: each("Subject"), preheader: each("Preheader"), document: doc });
    const p = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "automation.f09_links", personId: p.id, locale: "en", data: {}, key: "f09:links" });
    expect(await run(emailMessageId, "automation.f09_links")).toMatchObject({ status: "sent" });
    const sent = fakes.resend.sent[0]!;
    expect(sent.text).toContain("Stop: no-link.");
    expect(sent.text).not.toContain("confirm=unsubscribe");
    expect(sent.text).toMatch(/Manage: https:\/\/beam\.be\/en\/preferences\/[A-Za-z0-9_-]{43}/);
    expect(sent.headers["List-Unsubscribe"]).toBeUndefined();
  });

  it("a marketing message's List-Unsubscribe is crm's one-click URL of the same token", async () => {
    await seedTemplate(h.db as unknown as Tx, {
      slug: "f09-news",
      name: "f09-news",
      kind: "marketing",
      purpose: "newsletter",
      subject: each("Subject"),
      preheader: each("Preheader"),
      document: { schemaVersion: 1, locales: Object.fromEntries(L.map((l) => [l, [{ id: id(), type: "text", markdown: "Unsubscribe: {{unsubscribe_url}}" }]])) } as BlockDocument,
    });
    const p = await personWith(h.db);
    await consent(h.db, p.id, "newsletter", "granted");
    const r = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "f09-news", personId: p.id, enrolmentId: crypto.randomUUID(), idempotencyKey: "f09:news", context: {} });
    expect(await run(r.messageId, "f09-news")).toMatchObject({ status: "sent" });
    const sent = fakes.resend.sent[0]!;
    const token = tokenIn(sent.html ?? "")!;
    expect(sent.headers["List-Unsubscribe"]).toBe(`<https://beam.be/api/public/unsubscribe/${token}>`);
    expect(sent.text).toMatch(new RegExp(`Unsubscribe: https://beam\\.be/[a-z]+/preferences/${token}\\?confirm=unsubscribe`));
  });
});
