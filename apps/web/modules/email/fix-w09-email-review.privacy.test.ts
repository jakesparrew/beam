/**
 * fix-w09-email-review (V1 review findings 1 and 2): email's erase step and the
 * `email.email_messages` sweep clear the links other modules keep to a message
 * (`form_submissions.result_email_message_id`, `checkouts.recovery_message_id`,
 * `vouchers.email_message_id`, all `on delete no action`) before deleting it, and the sweep skips
 * a message an append-only `automation_runs` row still references (`on delete restrict`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import { makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { checkouts, emailMessages, formSubmissions, forms, formVersions, vouchers } from "@beam/db/schema";
import { eq, type Tx } from "@/lib/ctx";
import { completeCompany, personWith } from "./email-p3.fixtures";
import { privacy } from "./privacy";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
});
afterAll(async () => {
  await h.close();
});

const inTx = <T>(fn: (tx: Tx) => Promise<T>) => h.db.transaction((tx) => fn(tx));
let n = 0;

async function message(personId: string, toEmail: string, createdAt?: Date): Promise<string> {
  const [m] = await h.db
    .insert(emailMessages)
    .values({
      personId,
      toEmail,
      kind: "transactional",
      locale: "nl-BE",
      idempotencyKey: `fix-w09:${++n}:${crypto.randomUUID()}`,
      status: "sent",
      sentAt: createdAt ?? new Date(),
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: emailMessages.id });
  return m!.id;
}

/** A completed submission of a fresh form whose result email is `messageId` (forms.result). */
async function submissionWithResultEmail(personId: string, messageId: string): Promise<string> {
  const slug = `fix-w09-${++n}-${Date.now().toString(36)}`;
  const [f] = await h.db.insert(forms).values({ slug, kind: "assessment", name: { "nl-BE": "Test", "fr-BE": "Test", en: "Test" } }).returning();
  const [v] = await h.db
    .insert(formVersions)
    .values({ formId: f!.id, version: 1, definition: { fields: [], settings: {} } as never, definitionHash: slug, publishedAt: new Date() })
    .returning();
  const [s] = await h.db
    .insert(formSubmissions)
    .values({ formId: f!.id, formVersionId: v!.id, personId, status: "completed", identifiedBy: "token", funnel: `form:${slug}`, locale: "nl-BE", completedAt: new Date(), resultEmailMessageId: messageId })
    .returning({ id: formSubmissions.id });
  return s!.id;
}

async function voucherWithEmail(personId: string, messageId: string): Promise<string> {
  const line = await makeOrderLine(h.db);
  const [v] = await h.db
    .insert(vouchers)
    .values({ orderLineId: line.id, amountCents: 5000, purchaserPersonId: personId, recipientEmail: "gift@example.com", emailMessageId: messageId })
    .returning({ id: vouchers.id });
  return v!.id;
}

async function checkoutWithRecovery(personId: string, messageId: string): Promise<string> {
  const [c] = await h.db
    .insert(checkouts)
    .values({ personId, email: "buyer@example.com", channel: "site", items: [], status: "abandoned", abandonedAt: new Date(), recoveryMessageId: messageId })
    .returning({ id: checkouts.id });
  return c!.id;
}

describe("fix-w09-email-review: erase", () => {
  it("erases a person who received a form result, voucher and checkout-recovery email; the links become null", async () => {
    const p = await personWith(h.db);
    const result = await message(p.id, p.email!);
    const gift = await message(p.id, p.email!);
    const recovery = await message(p.id, p.email!);
    const submissionId = await submissionWithResultEmail(p.id, result);
    const voucherId = await voucherWithEmail(p.id, gift);
    const checkoutId = await checkoutWithRecovery(p.id, recovery);

    const report = await inTx((tx) => privacy.erase(tx, p.id));

    expect(report.find((r) => r.table === "email_messages")!.rows).toBe(3);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.personId, p.id))).toHaveLength(0);
    const [s] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, submissionId));
    expect(s).toMatchObject({ status: "completed", resultEmailMessageId: null });
    const [v] = await h.db.select().from(vouchers).where(eq(vouchers.id, voucherId));
    expect(v?.emailMessageId).toBeNull();
    const [c] = await h.db.select().from(checkouts).where(eq(checkouts.id, checkoutId));
    expect(c?.recoveryMessageId).toBeNull();
  });
});

describe("fix-w09-email-review: email.email_messages sweep", () => {
  it("deletes a message older than 730 days whose form submission (kept 1095 days) still exists", async () => {
    const old = new Date(Date.now() - 800 * 86_400_000);
    const cutoff = new Date(Date.now() - 730 * 86_400_000);
    const p = await personWith(h.db);
    const result = await message(p.id, p.email!, old);
    const gift = await message(p.id, p.email!, old);
    const recovery = await message(p.id, p.email!, old);
    const submissionId = await submissionWithResultEmail(p.id, result);
    const voucherId = await voucherWithEmail(p.id, gift);
    const checkoutId = await checkoutWithRecovery(p.id, recovery);

    const deleted = await inTx((tx) => privacy.sweep!["email.email_messages"]!(tx, cutoff));

    expect(deleted).toBeGreaterThanOrEqual(3);
    for (const id of [result, gift, recovery]) expect(await h.db.select().from(emailMessages).where(eq(emailMessages.id, id))).toHaveLength(0);
    const [s] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, submissionId));
    expect(s).toMatchObject({ status: "completed", resultEmailMessageId: null });
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, voucherId)))[0]?.emailMessageId).toBeNull();
    expect((await h.db.select().from(checkouts).where(eq(checkouts.id, checkoutId)))[0]?.recoveryMessageId).toBeNull();
  });
});
