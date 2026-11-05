/**
 * email-P8: `findLatestMessage(db, { personId, templateSlug, after })` (email spec section 4, R2):
 * commerce's checkout recovery attribution reads the newest message one person got from one
 * template after a cutoff, across every version of that template, on the
 * `(person_id, template_version_id, created_at desc)` index.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailTemplates, emailTemplateVersions } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { findLatestMessage } from "../api";
import { personWith } from "../email-p3.fixtures";
import { insertMessages, templateVersion } from "../email-p7.fixtures";
import { latestMessageQuery } from "./latest-message";

let h: DbHandle;
let personId: string;
let otherPersonId: string;
let slug: string;
let v1: string;
let v2: string;
let otherTemplateVersion: string;

const MIN = 60_000;
// Fixed instants: the test never depends on the wall clock.
const cutoff = new Date("2026-10-15T10:00:00Z");
const at = (minutes: number) => new Date(cutoff.getTime() + minutes * MIN);

const ids: Record<string, string> = {};
async function message(name: string, values: { versionId: string; personId: string; createdAt: Date; kind?: "automation" | "test" | "transactional"; status?: "delivered" | "sent" | "suppressed"; clickedAt?: Date | null }) {
  const [id] = await insertMessages(h.db, 1, {
    templateVersionId: values.versionId,
    personId: values.personId,
    kind: values.kind ?? "automation",
    createdAt: values.createdAt,
    sentAt: values.status === "suppressed" ? null : values.createdAt,
    status: values.status ?? "delivered",
    clickedAt: values.clickedAt ?? null,
  });
  ids[name] = id!;
}

beforeAll(async () => {
  h = await createTestDb();
  personId = (await personWith(h.db, { email: "p8-latest@example.com" })).id;
  otherPersonId = (await personWith(h.db, { email: "p8-latest-other@example.com" })).id;
  const tpl = await templateVersion(h.db, "marketing");
  slug = tpl.slug;
  v1 = tpl.versionId;
  // Version 2 of the same template (republished after an edit).
  const [first] = await h.db.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.id, v1));
  const [second] = await h.db
    .insert(emailTemplateVersions)
    .values({ templateId: tpl.templateId, version: 2, subject: first!.subject, preheader: first!.preheader, document: first!.document, locales: first!.locales, publishedAt: at(-30) })
    .returning();
  v2 = second!.id;
  await h.db.update(emailTemplates).set({ currentVersionId: v2 }).where(eq(emailTemplates.id, tpl.templateId));
  otherTemplateVersion = (await templateVersion(h.db, "marketing")).versionId;

  await message("before", { versionId: v1, personId, createdAt: at(-60), clickedAt: at(-50) });
  await message("atCutoff", { versionId: v1, personId, createdAt: cutoff });
  await message("v1After", { versionId: v1, personId, createdAt: at(10), clickedAt: at(12) });
  await message("v2After", { versionId: v2, personId, createdAt: at(40), status: "sent" });
  await message("otherTemplate", { versionId: otherTemplateVersion, personId, createdAt: at(90) });
  await message("otherPerson", { versionId: v2, personId: otherPersonId, createdAt: at(120) });
  await message("testSend", { versionId: v2, personId, createdAt: at(150), kind: "test" });
});

afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("findLatestMessage", () => {
  it("returns the newest message after the cutoff for that person and template, across versions", async () => {
    const latest = await findLatestMessage(h.db, { personId, templateSlug: slug, after: cutoff });
    expect(latest).toEqual({ emailMessageId: ids.v2After, status: "sent", sentAt: at(40), clickedAt: null });
  });

  it("the answer does not depend on how far back the cutoff lies, only on what is newest after it", async () => {
    for (const after of [at(-61), at(-1), at(5), at(39)]) {
      expect((await findLatestMessage(h.db, { personId, templateSlug: slug, after }))?.emailMessageId).toBe(ids.v2After);
    }
    // A cutoff at version 2's message (strictly after) leaves nothing newer.
    expect(await findLatestMessage(h.db, { personId, templateSlug: slug, after: at(40) })).toBeNull();
  });

  it("returns version 1's message with its click when only that one is after the cutoff", async () => {
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`update email_messages set created_at = ${at(-90).toISOString()}::timestamptz where id = ${ids.v2After}`);
      const latest = await findLatestMessage(tx, { personId, templateSlug: slug, after: cutoff });
      expect(latest).toEqual({ emailMessageId: ids.v1After, status: "delivered", sentAt: at(10), clickedAt: at(12) });
      tx.rollback();
    }).catch((e: unknown) => {
      if (!(e instanceof Error) || !/rollback/i.test(e.message)) throw e;
    });
  });

  it("finds none when every message is before (or exactly at) the cutoff", async () => {
    expect(await findLatestMessage(h.db, { personId, templateSlug: slug, after: at(200) })).toBeNull();
    // The other person's only message is created exactly at this cutoff: it is not "after" it.
    expect(await findLatestMessage(h.db, { personId: otherPersonId, templateSlug: slug, after: at(120) })).toBeNull();
    expect((await findLatestMessage(h.db, { personId: otherPersonId, templateSlug: slug, after: at(119) }))?.emailMessageId).toBe(ids.otherPerson);
  });

  it("ignores other people, other templates and test sends", async () => {
    const other = await findLatestMessage(h.db, { personId: otherPersonId, templateSlug: slug, after: cutoff });
    expect(other?.emailMessageId).toBe(ids.otherPerson);
    const latest = await findLatestMessage(h.db, { personId, templateSlug: slug, after: at(41) });
    expect(latest).toBeNull(); // testSend (at 150) and otherTemplate (at 90) do not count
  });

  it("returns null for an unknown template slug", async () => {
    expect(await findLatestMessage(h.db, { personId, templateSlug: "no-such-template", after: cutoff })).toBeNull();
  });

  it("looks the messages up on the (person_id, template_version_id, created_at) index", async () => {
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const res = (await tx.execute(sql`explain ${latestMessageQuery(tx, { personId, versionIds: [v1, v2], after: cutoff })}`)) as unknown as { rows: Record<string, string>[] };
      const plan = res.rows.map((r) => Object.values(r)[0]).join("\n");
      expect(plan).toContain("email_messages_person_template_idx");
    });
  });
});
