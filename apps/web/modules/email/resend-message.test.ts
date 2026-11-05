/**
 * email-P7: `resendMessage` (email spec section 4). A transactional message is queued again as a
 * new message with key `<original>:manual:<n>`, the same template version and data, to the
 * person's current address; refused for marketing (campaign, automation) and test messages and
 * while the address is suppressed. Allowed for the default `reception` role (`persons.write`),
 * refused for `marketing` (no `persons.write`). `cancelScheduledMessage` cancels a future single
 * message (`email.send`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { DEFAULT_ROLE_GRANTS } from "@beam/db/seed/platform";
import { auditLog, emailMessages, jobs, persons, roles, suppressions, type RoleKey } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.57" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb, sql } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { personWith } = await import("./email-p3.fixtures");
const { insertMessages, templateVersion } = await import("./email-p7.fixtures");

let h: DbHandle;
let versionId: string;
let slug: string;

async function signInAs(roleKey: RoleKey, permissions?: readonly string[]) {
  const user = await makeUser(h.db, { roleKey });
  await h.db.update(roles).set({ permissions: [...(permissions ?? (DEFAULT_ROLE_GRANTS as Partial<Record<RoleKey, readonly string[]>>)[roleKey] ?? [])] }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  ({ versionId, slug } = await templateVersion(h.db, "transactional"));
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

let n = 0;
/** A sent transactional message to a person whose address then changed. */
async function sentTransactional(overrides: Omit<Partial<typeof emailMessages.$inferInsert>, "templateVersionId"> = {}) {
  const person = await personWith(h.db, { email: `p7-resend-${++n}@example.com` });
  const key = `booking:p7-${n}:confirmed`;
  const [id] = await insertMessages(h.db, 1, {
    templateVersionId: versionId,
    kind: "transactional",
    purpose: null,
    fromDomain: "mail.beam.be",
    status: "delivered",
    personId: person.id,
    toEmail: person.email,
    props: { bookingId: "b-1" },
    context: { booking_id: "b-1" },
    idempotencyKey: key,
    sentAt: new Date(),
    ...overrides,
  });
  await h.db.insert(jobs).values({ kind: "email.send", payload: { emailMessageId: id, template: slug }, idempotencyKey: `email:${id}`, status: "succeeded" });
  return { id: id!, key, personId: person.id };
}

const messageOfKey = async (key: string) => (await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, key)))[0];

describe("resendMessage", () => {
  it("queues a new message with the :manual:1 key, the same data and the current address", async () => {
    await signInAs("reception");
    const m = await sentTransactional();
    await h.db.update(persons).set({ email: `p7-resend-new-${n}@example.com`, emailHash: emailHash(`p7-resend-new-${n}@example.com`) }).where(eq(persons.id, m.personId));
    const result = await actions.resendMessage({ messageId: m.id });
    expect(result).toMatchObject({ ok: true });
    const copy = await messageOfKey(`${m.key}:manual:1`);
    expect(copy).toMatchObject({
      kind: "transactional",
      status: "queued",
      personId: m.personId,
      toEmail: `p7-resend-new-${n}@example.com`,
      templateVersionId: versionId,
      props: { bookingId: "b-1" },
      context: { booking_id: "b-1" },
    });
    expect(result.ok && result.data.messageId).toBe(copy!.id);
    const [job] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `email:${copy!.id}`));
    expect(job).toMatchObject({ kind: "email.send", payload: { emailMessageId: copy!.id, template: slug }, priority: 1 });
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "email.message_resend"), eq(auditLog.entityId, copy!.id)));
    expect(audit).toBeDefined();

    // A second resend (also of the copy) counts on from the original key.
    expect(await actions.resendMessage({ messageId: m.id })).toMatchObject({ ok: true });
    expect(await messageOfKey(`${m.key}:manual:2`)).toBeDefined();
    await h.db.update(emailMessages).set({ status: "sent" }).where(eq(emailMessages.id, copy!.id));
    expect(await actions.resendMessage({ messageId: copy!.id })).toMatchObject({ ok: true });
    expect(await messageOfKey(`${m.key}:manual:3`)).toBeDefined();
  });

  it("is refused for campaign, automation and test messages", async () => {
    await signInAs("customer_service");
    for (const kind of ["campaign", "automation", "test"] as const) {
      const m = await sentTransactional({ kind, purpose: kind === "test" ? null : "newsletter", fromDomain: kind === "test" ? "mail.beam.be" : "news.beam.be" });
      expect(await actions.resendMessage({ messageId: m.id })).toMatchObject({ ok: false, error: { code: "validation", message: "not_transactional" } });
      expect(await messageOfKey(`${m.key}:manual:1`)).toBeUndefined();
    }
  });

  it("is refused while the address is suppressed, and for a queued message", async () => {
    await signInAs("reception");
    const m = await sentTransactional({ status: "bounced", bounceType: "hard" });
    const [p] = await h.db.select().from(persons).where(eq(persons.id, m.personId));
    await h.db.insert(suppressions).values({ emailHash: emailHash(p!.email!), scope: "all", reason: "hard_bounce", source: "resend:p7", personId: m.personId, actor: { kind: "system", id: null } });
    expect(await actions.resendMessage({ messageId: m.id })).toMatchObject({ ok: false, error: { code: "validation", message: "address_suppressed" } });
    const queued = await sentTransactional({ status: "queued", sentAt: null });
    expect(await actions.resendMessage({ messageId: queued.id })).toMatchObject({ ok: false, error: { code: "validation", message: "not_resendable" } });
    expect(await h.db.select().from(emailMessages).where(sql`${emailMessages.idempotencyKey} like '%:manual:%' and ${emailMessages.personId} in (${m.personId}::uuid, ${queued.personId}::uuid)`)).toHaveLength(0);
  });

  it("is refused for the marketing role without persons.write", async () => {
    await signInAs("marketing");
    const m = await sentTransactional();
    expect(await actions.resendMessage({ messageId: m.id })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await messageOfKey(`${m.key}:manual:1`)).toBeUndefined();
  });
});

describe("cancelScheduledMessage", () => {
  it("cancels a future single message with email.send and refuses one that is already due", async () => {
    await signInAs("marketing");
    const future = await sentTransactional({ status: "queued", sentAt: null, sendAt: new Date(Date.now() + 86_400_000) });
    expect(await actions.cancelScheduledMessage({ messageId: future.id })).toMatchObject({ ok: true, data: { ok: true } });
    expect(await messageOfKey(future.key)).toMatchObject({ status: "failed", error: "cancelled" });
    const due = await sentTransactional({ status: "queued", sentAt: null });
    expect(await actions.cancelScheduledMessage({ messageId: due.id })).toMatchObject({ ok: false, error: { code: "validation" } });
    await signInAs("reception");
    expect(await actions.cancelScheduledMessage({ messageId: due.id })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
