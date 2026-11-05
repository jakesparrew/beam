/**
 * forms-P8 (serving crm-P9's request, cross-module D62): a completed submission of a version with
 * `FormSettings.createInboxThread` opens one thread in crm's unified inbox; the message holds the
 * non-sensitive answers only. Also forms-P7's request: the admin "Form imports" nav entry.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { inboxMessages, inboxThreads } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { eq, type Actor } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { assessment, ASSESSMENT_ANSWERS, createForm, later, lead, publicCtx, setupEnv } from "./forms-p3.fixtures";
import { nav } from "./nav";
import { completeSubmission, inboxBody, startSubmission } from "./service/submissions";

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const T0 = new Date("2026-11-04T09:00:00Z");
const email = () => `inbox-${randomUUID().slice(0, 8)}@example.com`;

async function run(slug: string, answers: Record<string, unknown>, actor: Actor = { kind: "public" }) {
  const s0 = publicCtx(h.db, T0, actor);
  const s = await startSubmission(s0.tx, s0, { slug, locale: "nl-BE", url: "https://app.example.com/nl/f/x", ip: "203.0.113.7" });
  const c = publicCtx(h.db, later(T0, 30), actor);
  const proof = s.resumeToken ? { resumeToken: s.resumeToken } : {};
  await completeSubmission(c.tx, c, { submissionId: s.submissionId, proof, answers: answers as never, ip: "203.0.113.7", userAgent: "vitest" });
  return s.submissionId;
}
const threadOf = (submissionId: string) => h.db.select().from(inboxThreads).where(eq(inboxThreads.externalThreadId, `form:${submissionId}`));

describe("crm inbox thread from a form (createInboxThread)", () => {
  it("the contact form opens one thread with the answers, once per submission", async () => {
    const f = await createForm(h.db, lead());
    const p = await makePerson(h.db, { email: email() });
    const actor: Actor = { kind: "customer", userId: randomUUID(), personId: p.id };
    const id = await run(f.slug, { email: p.email, first_name: "Lotte", message: "Kan ik een dagje boeken?", newsletter: false }, actor);
    const threads = await threadOf(id);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ channel: "form", personId: p.id, status: "open" });
    const msgs = await h.db.select().from(inboxMessages).where(eq(inboxMessages.threadId, threads[0]!.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("Kan ik een dagje boeken?");
    expect(msgs[0]!.body).toContain("Lotte");
    // Submitting again (U7) changes nothing.
    const again = publicCtx(h.db, later(T0, 60), actor);
    await completeSubmission(again.tx, again, { submissionId: id, proof: {}, answers: {}, ip: "203.0.113.7", userAgent: "vitest" });
    expect(await threadOf(id)).toHaveLength(1);
  });

  it("a version without the switch opens no thread", async () => {
    const f = await createForm(h.db, assessment());
    const id = await run(f.slug, { ...ASSESSMENT_ANSWERS, email: email() });
    expect(await threadOf(id)).toHaveLength(0);
  });

  it("the message never holds a sensitive answer, a consent or a hidden value", () => {
    const a = assessment();
    const body = inboxBody(a.definition, { first_name: "Lotte", newsletter: false, movement: "rarely" }, a.definition.sections.map((s) => s.key), "nl-BE");
    expect(body).toContain("Lotte");
    expect(body).not.toMatch(/newsletter/i);
    expect(body).not.toContain("rarely");
    const option = (a.definition.fields.movement as { options: { key: string; label: Record<string, string> }[] }).options.find((o) => o.key === "rarely")!;
    expect(body).toContain(option.label["nl-BE"]);
  });

  it("a sensitive assessment with the switch on sends only its non-sensitive answers", async () => {
    const a = assessment();
    a.definition.settings.createInboxThread = true;
    const f = await createForm(h.db, a);
    const p = await makePerson(h.db, { email: email() });
    const id = await run(f.slug, { ...ASSESSMENT_ANSWERS, email: p.email }, { kind: "customer", userId: randomUUID(), personId: p.id });
    const [thread] = await threadOf(id);
    const [msg] = await h.db.select().from(inboxMessages).where(eq(inboxMessages.threadId, thread!.id));
    expect(msg!.body).toContain("Lotte");
    const sensitive = Object.values(a.definition.fields).filter((x) => x.sensitive);
    expect(sensitive.length).toBeGreaterThan(0);
    for (const x of sensitive) expect(msg!.body).not.toContain(`${x.label["nl-BE"]}:`);
  });
});

describe("admin nav (forms-P7 request)", () => {
  it("lists Form imports under Marketing with the import pages' permission", () => {
    expect(nav.find((n) => n.href === "/admin/forms/imports")).toMatchObject({ area: "admin", section: "marketing", permission: "forms.publish", labelKey: "forms.nav.imports" });
  });
});
