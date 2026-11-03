import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { aiRequests, auditLog, authSessions, authVerificationTokens, featureFlags, files, users, webhookEvents } from "@beam/db/schema";
import { isValidRetentionSeed } from "@beam/core/privacy";
import { auditDigest } from "@/lib/audit";
import { eq, sql } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import { noPiiTables, privacy } from "./privacy";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

async function subject() {
  const person = await makePerson(handle.db);
  const user = await makeUser(handle.db, { audience: "customer", personId: person.id, email: person.email!, passwordHash: "$argon2id$v=19$x" });
  const later = new Date(Date.now() + 86_400_000);
  await handle.db.insert(authSessions).values({ sessionToken: randomUUID(), userId: user.id, audience: "customer", expires: later, absoluteExpiresAt: later });
  await handle.db.insert(authVerificationTokens).values({ identifier: person.email!, token: "hashed", expires: later });
  await handle.db.insert(aiRequests).values({ feature: "ai.draft_reply", model: "claude-opus-5-5", actor: { kind: "system", id: null }, personId: person.id, prompt: "Hi Test", status: "ok" });
  const file = (kind: (typeof files.$inferInsert)["kind"], name: string) =>
    handle.db.insert(files).values({ kind, name, mime: "application/pdf", sizeBytes: 1, bytes: new Uint8Array([1]), sha256: "a".repeat(64), personId: person.id }).returning({ id: files.id });
  const [invoice] = await file("invoice_pdf", "invoice.pdf");
  const [receipt] = await file("receipt", "receipt.pdf");
  const [exported] = await file("export", "export.zip");
  const [rendered] = await file("rendered_email", "mail.html");
  await makeCtx(handle.db).audit({ action: "person.update", entityType: "person", entityId: person.id, personId: person.id, oldValue: { first_name: "Old" }, newValue: { first_name: "New" } });
  await handle.db.insert(featureFlags).values({ key: `ff_platform_t${randomUUID().slice(0, 8)}`, state: "testers", personIds: [person.id], userIds: [user.id] });
  await handle.db.insert(webhookEvents).values({ provider: "resend", externalEventId: randomUUID(), payload: { to: [person.email] }, jobId: randomUUID() });
  return { person, user, invoice: invoice!.id, receipt: receipt!.id, exported: exported!.id, rendered: rendered!.id };
}

describe("platform privacy registration", () => {
  it("export lists the account, audit actions, files (invoice bytes included) and AI requests", async () => {
    const s = await subject();
    const data = (await handle.db.transaction((tx) => privacy.export(tx, s.person.id))) as Record<string, { [k: string]: unknown }[]>;
    expect(data.users).toEqual([expect.objectContaining({ email: s.person.email, has_password: true })]);
    expect(data.audit_log).toEqual([expect.objectContaining({ action: "person.update", entity_type: "person" })]);
    expect(data.audit_log![0]).not.toHaveProperty("new_value");
    const byKind = Object.fromEntries(data.files!.map((f) => [f.kind, f.bytes]));
    expect(byKind.invoice_pdf).toBe("AQ==");
    expect(byKind.export).toBeNull();
    expect(data.ai_requests).toEqual([expect.objectContaining({ feature: "ai.draft_reply", prompt: "Hi Test" })]);
  });

  it("erase deletes the customer user, sessions, tokens, AI requests and person files except invoices; audit values become digests", async () => {
    const s = await subject();
    const other = await subject();
    const report = await handle.db.transaction((tx) => privacy.erase(tx, s.person.id));
    expect(report.find((r) => r.table === "users")).toEqual({ table: "users", rows: 1, action: "deleted" });

    expect(await handle.db.select().from(users).where(eq(users.id, s.user.id))).toHaveLength(0);
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.userId, s.user.id))).toHaveLength(0);
    expect(await handle.db.select().from(authVerificationTokens).where(eq(authVerificationTokens.identifier, s.person.email!))).toHaveLength(0);
    expect(await handle.db.select().from(aiRequests).where(eq(aiRequests.personId, s.person.id))).toHaveLength(0);

    const left = await handle.db.select({ id: files.id, personId: files.personId }).from(files);
    const ids = left.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining([s.invoice, s.receipt]));
    expect(ids).not.toContain(s.exported);
    expect(ids).not.toContain(s.rendered);
    expect(left.find((f) => f.id === s.invoice)!.personId).toBeNull();

    const [audit] = await handle.db.select().from(auditLog).where(eq(auditLog.personId, s.person.id));
    expect(audit).toMatchObject({ isRedacted: true, ip: null, personId: s.person.id, oldValue: auditDigest({ first_name: "Old" }), newValue: auditDigest({ first_name: "New" }) });

    const flags = await handle.db.select().from(featureFlags);
    expect(flags.some((f) => f.personIds.includes(s.person.id) || f.userIds.includes(s.user.id))).toBe(false);
    const hooks = await handle.db.execute(sql`select count(*)::int as n from webhook_events where payload::text like ${`%${s.person.email}%`}`);
    expect((hooks as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);

    // The other subject is untouched.
    expect(await handle.db.select().from(users).where(eq(users.id, other.user.id))).toHaveLength(1);
    expect(await handle.db.select().from(aiRequests).where(eq(aiRequests.personId, other.person.id))).toHaveLength(1);
  });

  it("declares valid retention policies with a sweep for each", async () => {
    for (const seed of privacy.retention ?? []) {
      expect(isValidRetentionSeed(seed)).toBe(true);
      expect(privacy.sweep?.[seed.key]).toBeTypeOf("function");
    }
    const old = new Date(Date.now() - 40 * 86_400_000);
    await handle.db.insert(aiRequests).values({ feature: "ai.classify", model: "claude-haiku-5-5", actor: { kind: "system", id: null }, prompt: "x", status: "ok", createdAt: old });
    const removed = await handle.db.transaction((tx) => privacy.sweep!["platform.ai_requests"]!(tx, new Date(Date.now() - 30 * 86_400_000)));
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it("lists the platform tables without personal data", () => {
    expect(noPiiTables).toEqual(expect.arrayContaining(["roles", "jobs", "settings", "rate_limits", "webhook_events", "integration_calls", "monthly_reports"]));
    expect(noPiiTables).not.toContain("users");
  });
});
