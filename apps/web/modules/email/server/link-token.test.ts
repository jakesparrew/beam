/**
 * email-P3: `resolveLinkToken` (email spec rule 53), crm's way back from a link to its message.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailMessages } from "@beam/db/schema";
import { newLinkToken } from "@beam/core/email";
import { eq, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { getTemplateInfo, resolveLinkToken } from "../api";
import { blockTemplate, personWith } from "../email-p3.fixtures";

let h: DbHandle;
let versionId: string;
beforeAll(async () => {
  h = await createTestDb();
  await blockTemplate(h.db, { slug: "p3l-news", kind: "marketing", purpose: "events" });
  versionId = (await getTemplateInfo(h.db, "p3l-news"))!.templateVersionId;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function message(values: Partial<typeof emailMessages.$inferInsert> & { personId: string | null }) {
  const link = newLinkToken();
  const [row] = await h.db
    .insert(emailMessages)
    .values({
      kind: "transactional",
      locale: "fr-BE",
      toEmail: "someone@example.com",
      idempotencyKey: `p3l:${link.hash.slice(0, 12)}`,
      status: "sent",
      sentAt: new Date("2026-10-01T08:00:00Z"),
      linkTokenHash: link.hash,
      ...values,
    })
    .returning();
  return { row: row!, token: link.token };
}

describe("resolveLinkToken", () => {
  it("returns message id, person, purpose, locale and sentAt of a campaign or marketing automation message", async () => {
    const p = await personWith(h.db);
    const { row, token } = await message({ personId: p.id, kind: "automation", purpose: "events", templateVersionId: versionId, fromDomain: "news.beam.be" });
    expect(await resolveLinkToken(h.db, token)).toEqual({ emailMessageId: row.id, personId: p.id, purpose: "events", locale: "fr-BE", sentAt: new Date("2026-10-01T08:00:00Z") });
  });

  it("purpose is null for a transactional message", async () => {
    const p = await personWith(h.db);
    const { token } = await message({ personId: p.id });
    expect((await resolveLinkToken(h.db, token))?.purpose).toBeNull();
  });

  it("null for a test send, an unknown token, a malformed token and an erased row", async () => {
    const { token: testToken } = await message({ personId: null, kind: "test", purpose: "events", templateVersionId: versionId });
    expect(await resolveLinkToken(h.db, testToken)).toBeNull();
    expect(await resolveLinkToken(h.db, newLinkToken().token)).toBeNull();
    expect(await resolveLinkToken(h.db, "not-a-token")).toBeNull();

    const p = await personWith(h.db);
    const { row, token } = await message({ personId: p.id });
    expect(await resolveLinkToken(h.db, token)).not.toBeNull();
    await h.db.execute(sql`set beam.allow_rewrite = 'on'`);
    await h.db.delete(emailMessages).where(eq(emailMessages.id, row.id));
    await h.db.execute(sql`set beam.allow_rewrite = 'off'`);
    expect(await resolveLinkToken(h.db, token)).toBeNull();
  });
});
