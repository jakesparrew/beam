import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, ensureRole, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { like } from "drizzle-orm";
import { auditLog, authSessions, jobs, monthlyReports, roles, securityIncidents, settings, supportRequests, users, webhookEvents, type RoleKey } from "@beam/db/schema";
import { GO_LIVE_ITEMS, slaDueAt, DEFAULT_SUPPORT_CALENDAR } from "@beam/core/platform";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "admin-actions-test-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.30" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const sent: { template: string; to?: string; key: string; data: Record<string, unknown> }[] = [];
vi.mock("@/modules/email/api", () => ({
  sendTransactional: (_ctx: unknown, input: { template: string; to?: string; key: string; data: Record<string, unknown> }) => {
    sent.push(input);
    return Promise.resolve({ emailMessageId: "m", jobId: "j" });
  },
}));
const dpia = vi.hoisted(() => ({ approved: false }));
vi.mock("@/modules/ops/api", () => ({ isDpiaApproved: () => Promise.resolve(dpia.approved) }));

const actions = await import("./actions");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime, makeCtx, runJobTwice, makeJobCtx } = await import("@/lib/testing");
const { runCheckAlerts, GB } = await import("@/lib/alerts");
const { loadJobs } = await import("@/lib/job-runner");
const { getGoLiveGate } = await import("./queries");
const { createFakeIntegrations } = await import("@/lib/integrations");
const { PERMISSIONS } = await import("@/registry/permissions.generated");

let handle: DbHandle;

async function signIn(roleKey: RoleKey = "owner") {
  const user = await makeUser(handle.db, { roleKey });
  const { token } = await auth.createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return user;
}

const auditRows = (action: string, entityId?: string) =>
  handle.db.select().from(auditLog).where(entityId ? and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)) : eq(auditLog.action, action));

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  for (const key of ["owner", "technical_admin", "reception", "management"] as const) await ensureRole(handle.db, key);
  await handle.db
    .update(roles)
    .set({ permissions: PERMISSIONS.filter((p) => p !== "persons.sensitive_read") })
    .where(eq(roles.key, "technical_admin"));
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => {
  jar.clear();
  sent.length = 0;
  dpia.approved = false;
});

describe("staff users (PL-9, PL-16)", () => {
  it("never disables or demotes the last active owner", async () => {
    await handle.db.update(users).set({ status: "disabled" }).where(eq(users.roleKey, "owner"));
    const owner = await signIn("owner");
    expect(await actions.setUserStatus({ userId: owner.id, status: "disabled" })).toMatchObject({ ok: false, error: { code: "conflict", message: "last_owner" } });
    expect(await actions.updateStaffUser({ userId: owner.id, roleKey: "technical_admin" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const second = await makeUser(handle.db, { roleKey: "owner" });
    expect(await actions.updateStaffUser({ userId: owner.id, roleKey: "management" })).toEqual({ ok: true, data: {} });
    // `second` is now the last active owner; the demoted user cannot touch owners any more.
    expect(await actions.setUserStatus({ userId: second.id, status: "disabled" })).toMatchObject({ ok: false });
  });

  it("only an owner changes a user to or from owner", async () => {
    await signIn("technical_admin");
    const target = await makeUser(handle.db, { roleKey: "reception" });
    expect(await actions.updateStaffUser({ userId: target.id, roleKey: "owner" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await actions.inviteStaffUser({ email: `owner-${randomUUID()}@example.com`, name: "New", roleKey: "owner", locale: "en" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("a role change deletes the user's sessions and audits users.role_change (PL-9)", async () => {
    await signIn("owner");
    const target = await makeUser(handle.db, { roleKey: "reception" });
    for (let i = 0; i < 2; i++) await auth.createAuthSession(handle.db, { userId: target.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
    expect(await actions.updateStaffUser({ userId: target.id, roleKey: "management" })).toEqual({ ok: true, data: {} });
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.userId, target.id))).toHaveLength(0);
    const [row] = await auditRows("users.role_change", target.id);
    expect(row).toMatchObject({ oldValue: { role_key: "reception" }, newValue: { role_key: "management" } });
  });

  it("invites a staff user with a 72-hour link and refuses a taken address", async () => {
    await signIn("owner");
    const email = `invitee-${randomUUID()}@example.com`;
    const result = await actions.inviteStaffUser({ email, name: "Invitee", roleKey: "reception", locale: "fr-BE" });
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ template: "platform.staff_invite", to: email });
    expect(String(sent[0]!.data.url)).toContain("/admin/invite/");
    expect(await actions.inviteStaffUser({ email, name: "Again", roleKey: "reception", locale: "en" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("resetUserMfa clears MFA, deletes sessions and emails the user (PL-9)", async () => {
    await signIn("owner");
    const target = await makeUser(handle.db, { roleKey: "reception" });
    await auth.createAuthSession(handle.db, { userId: target.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
    expect(await actions.resetUserMfa({ userId: target.id, reason: "lost phone" })).toEqual({ ok: true, data: {} });
    const [row] = await handle.db.select().from(users).where(eq(users.id, target.id));
    expect(row!.mfaEnrolledAt).toBeNull();
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.userId, target.id))).toHaveLength(0);
    expect(sent.map((s) => s.template)).toEqual(["platform.mfa_changed"]);
    expect(sent[0]!.key).toMatch(new RegExp(`^security_notice:${target.id}:`));
  });

  it("disabling a user deletes all its sessions", async () => {
    await signIn("owner");
    const target = await makeUser(handle.db, { roleKey: "reception" });
    await auth.createAuthSession(handle.db, { userId: target.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
    expect(await actions.setUserStatus({ userId: target.id, status: "disabled" })).toEqual({ ok: true, data: {} });
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.userId, target.id))).toHaveLength(0);
    expect(await auditRows("users.disable", target.id)).toHaveLength(1);
  });
});

describe("roles (PL-16, PL-18)", () => {
  it("a non-owner cannot grant persons.sensitive_read; an owner can", async () => {
    await signIn("technical_admin");
    expect(await actions.updateRolePermissions({ roleKey: "management", permissions: ["persons.read", "persons.sensitive_read"] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await actions.updateRolePermissions({ roleKey: "management", permissions: ["persons.read"] })).toEqual({ ok: true, data: {} });
    await signIn("owner");
    expect(await actions.updateRolePermissions({ roleKey: "management", permissions: ["persons.read", "persons.sensitive_read"] })).toEqual({ ok: true, data: {} });
    const [role] = await handle.db.select().from(roles).where(eq(roles.key, "management"));
    expect(role!.permissions).toEqual(["persons.read", "persons.sensitive_read"]);
    expect((await auditRows("roles.update_permissions", "management")).length).toBeGreaterThanOrEqual(2);
  });

  it("rejects an unknown permission and the owner role", async () => {
    await signIn("owner");
    expect(await actions.updateRolePermissions({ roleKey: "reception", permissions: ["persons.read", "made.up"] })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.updateRolePermissions({ roleKey: "owner", permissions: [] })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("settings and AI switch (PL-41, PL-55)", () => {
  it("updateSetting refuses a stale version and bumps the version otherwise", async () => {
    await signIn("owner");
    await handle.db.delete(settings).where(eq(settings.key, "company"));
    const value = { legal_name: "Vibrant Lifestyle Collective BV", trade_name: "BEAM", vat_number: "BE0123456789", enterprise_number: "0123.456.789", address: { street: "Main 1", postal_code: "9000", city: "Gent", country: "BE" }, support_email: "support@demo.beam.be", phone: "", website: "" };
    expect(await actions.updateSetting({ key: "company", value, expectedVersion: 0 })).toEqual({ ok: true, data: { version: 1 } });
    expect(await actions.updateSetting({ key: "company", value, expectedVersion: 0 })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.updateSetting({ key: "company", value: { ...value, vat_number: "nope" }, expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.updateSetting({ key: "go_live_gate", value: { items: {} }, expectedVersion: 0 })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("sensitive AI on needs the owner, a purpose, a DPIA reference and an approved DPIA", async () => {
    const input = { enabled: true, purpose: "Summaries of intake answers for coaches", dpiaReference: "DPIA-2026-04" };
    await signIn("technical_admin");
    expect(await actions.setAiSensitiveProcessing(input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await signIn("owner");
    expect(await actions.setAiSensitiveProcessing({ enabled: true, purpose: "too short", dpiaReference: "D-1" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.setAiSensitiveProcessing({ enabled: true, purpose: input.purpose })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.setAiSensitiveProcessing(input)).toMatchObject({ ok: false, error: { code: "conflict", message: "dpia_not_approved" } });
    dpia.approved = true;
    expect(await actions.setAiSensitiveProcessing(input)).toEqual({ ok: true, data: {} });
    expect(await auditRows("ai.sensitive_enabled")).toHaveLength(1);
    await signIn("technical_admin");
    expect(await actions.setAiSensitiveProcessing({ enabled: false })).toEqual({ ok: true, data: {} });
    expect(await auditRows("ai.sensitive_disabled")).toHaveLength(1);
  });
});

describe("go-live gate (PL-77, PL-85)", () => {
  it("is complete only with all 13 items, and security_confirmed needs a fresh pentest without open high incidents", async () => {
    await signIn("reception");
    expect(await actions.confirmGoLiveItem({ item: "dpa_signed", confirmed: true, note: "signed" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await signIn("owner");
    await handle.db.delete(settings).where(eq(settings.key, "security"));
    expect(await actions.confirmGoLiveItem({ item: "security_confirmed", confirmed: true, note: "checked" })).toMatchObject({ ok: false, error: { code: "conflict", message: "no_pentest" } });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    expect(await actions.recordPentest({ testedOn: old, summary: "Quarterly ASVS level 2 test", criticalOrHighFindings: 0 })).toEqual({ ok: true, data: { incidentId: null } });
    expect(await actions.confirmGoLiveItem({ item: "security_confirmed", confirmed: true, note: "checked" })).toMatchObject({ ok: false, error: { message: "pentest_too_old" } });
    const today = new Date().toISOString().slice(0, 10);
    const withFinding = await actions.recordPentest({ testedOn: today, summary: "One high finding in sessions", criticalOrHighFindings: 1 });
    expect(withFinding.ok && withFinding.data.incidentId).toBeTruthy();
    expect(await actions.confirmGoLiveItem({ item: "security_confirmed", confirmed: true, note: "checked" })).toMatchObject({ ok: false, error: { message: "open_incidents" } });
    await handle.db.update(securityIncidents).set({ status: "resolved", resolvedAt: new Date() });

    for (const item of GO_LIVE_ITEMS.slice(0, 12)) expect(await actions.confirmGoLiveItem({ item, confirmed: true, note: `ok ${item}` })).toEqual({ ok: true, data: {} });
    expect((await getGoLiveGate(handle.db)).complete).toBe(false);
    expect(await actions.confirmGoLiveItem({ item: GO_LIVE_ITEMS[12]!, confirmed: true, note: "done" })).toEqual({ ok: true, data: {} });
    expect(await getGoLiveGate(handle.db)).toMatchObject({ complete: true, confirmed: 13 });
    expect(await auditRows("go_live.confirm")).toHaveLength(13);
  });

  it("recordPentest sets the next due date 92 days later", async () => {
    await signIn("technical_admin");
    expect(await actions.recordPentest({ testedOn: "2026-10-01", summary: "Quarterly ASVS level 2 test", criticalOrHighFindings: 0 })).toMatchObject({ ok: true });
    const [row] = await handle.db.select().from(settings).where(eq(settings.key, "security"));
    expect(row!.value).toMatchObject({ last_pentest_on: "2026-10-01", next_pentest_due_on: "2027-01-01" });
  });
});

describe("jobs and webhooks (PL-29a, PL-40)", () => {
  it("retries and discards dead jobs", async () => {
    await signIn("technical_admin");
    const insert = async () =>
      (await handle.db.insert(jobs).values({ kind: "jobs.prune", payload: {}, idempotencyKey: `admin:${randomUUID()}`, status: "dead", attempts: 6, maxAttempts: 6, finishedAt: new Date() }).returning())[0]!;
    const a = await insert();
    expect(await actions.retryJob({ jobId: a.id })).toEqual({ ok: true, data: {} });
    const b = await insert();
    expect(await actions.discardJob({ jobId: b.id, reason: "duplicate run" })).toEqual({ ok: true, data: {} });
    expect(await handle.db.select().from(jobs).where(eq(jobs.id, b.id))).toHaveLength(0);
  });

  it("each replay enqueues webhook.process with key :replay:<n> and audits webhooks.replay", async () => {
    await signIn("technical_admin");
    const ext = `tr_${randomUUID()}`;
    const [event] = await handle.db.insert(webhookEvents).values({ provider: "mollie", externalEventId: ext, payload: { id: ext }, jobId: randomUUID() }).returning();
    expect((await actions.replayWebhookEvent({ webhookEventId: event!.id })).ok).toBe(true);
    expect((await actions.replayWebhookEvent({ webhookEventId: event!.id })).ok).toBe(true);
    const keys = (await handle.db.select({ key: jobs.idempotencyKey }).from(jobs).where(like(jobs.idempotencyKey, `webhook:mollie:${ext}:%`))).map((r) => r.key).sort();
    expect(keys).toEqual([`webhook:mollie:${ext}:replay:1`, `webhook:mollie:${ext}:replay:2`]);
    expect(await auditRows("webhooks.replay", event!.id)).toHaveLength(2);
  });
});

describe("security incidents (PL-73, PL-73a)", () => {
  it("a critical incident alerts Slack; 20 hours without BEAM notified posts a reminder", async () => {
    await signIn("technical_admin");
    const created = await actions.createIncident({ title: "Leaked API key", severity: "critical", discoveredAt: new Date(Date.now() - 21 * 3_600_000) });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.data.incidentId : "";
    expect(await handle.db.select().from(jobs).where(like(jobs.idempotencyKey, `slack:incident:${id}:%`))).toHaveLength(1);
    const fresh = await actions.createIncident({ title: "Odd login pattern", severity: "normal", discoveredAt: new Date(Date.now() - 19 * 3_600_000) });
    const freshId = fresh.ok ? fresh.data.incidentId : "";
    const raised = (
      await runCheckAlerts(makeCtx(handle.db), { databaseSizeBytes: () => Promise.resolve(GB), filesSizeBytes: () => Promise.resolve(GB), bookingHealth: () => Promise.resolve({ level: "ok", materialisedThroughOn: "2027-01-01", overdueOffers: 0, overdueReservations: 0, unsentConfirmations24h: 0 }), appEnv: "local" })
    ).map((r) => r.fingerprint);
    expect(raised).toContain(`incident-notify-${id}`);
    expect(raised).not.toContain(`incident-notify-${freshId}`);
  });

  it("follows the transitions: contained -> open refused, resolved -> open clears resolved_at", async () => {
    await signIn("technical_admin");
    const created = await actions.createIncident({ title: "Phishing mail", severity: "normal", discoveredAt: new Date() });
    const id = created.ok ? created.data.incidentId : "";
    expect(await actions.updateIncident({ id, status: "contained" })).toMatchObject({ ok: true });
    expect(await actions.updateIncident({ id, status: "open" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.updateIncident({ id, status: "resolved", resolution: "Mailbox cleaned" })).toMatchObject({ ok: true });
    expect((await handle.db.select().from(securityIncidents).where(eq(securityIncidents.id, id)))[0]!.resolvedAt).not.toBeNull();
    expect(await actions.updateIncident({ id, status: "open" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.updateIncident({ id, status: "open", note: "Second wave seen" })).toMatchObject({ ok: true });
    const [row] = await handle.db.select().from(securityIncidents).where(eq(securityIncidents.id, id));
    expect(row).toMatchObject({ status: "open", resolvedAt: null });
    expect(row!.actions).toContain("Second wave seen");
    const notified = new Date();
    expect(await actions.updateIncident({ id, beamNotifiedAt: notified })).toMatchObject({ ok: true });
    expect(await actions.updateIncident({ id, beamNotifiedAt: null })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("support register (PL-86 to PL-88)", () => {
  it("reportProblem stores channel in_app, the page URL and request id, and enqueues one Slack job", async () => {
    const reporter = await signIn("reception");
    const result = await actions.reportProblem({ title: "Check-in screen frozen", description: "Since 10:00", severity: "high", pageUrl: "/admin/checkin" });
    expect(result.ok).toBe(true);
    const reference = result.ok ? result.data.reference : "";
    expect(reference).toMatch(/^SUP-\d{4}-\d{4}$/);
    const [row] = await handle.db.select().from(supportRequests).where(eq(supportRequests.reference, reference));
    expect(row).toMatchObject({ channel: "in_app", pageUrl: "/admin/checkin", reportedByUserId: reporter.id, status: "open" });
    expect(row!.requestId).toMatch(/^req_/);
    expect(await handle.db.select().from(jobs).where(like(jobs.idempotencyKey, `slack:support:${reference}:%`))).toHaveLength(1);
    expect(await auditRows("support.report", row!.id)).toHaveLength(1);
    const next = await actions.reportProblem({ title: "Second problem", description: "", severity: "improvement", pageUrl: "/admin" });
    expect(next.ok && Number(next.data.reference.slice(-4))).toBe(Number(reference.slice(-4)) + 1);
  });

  it("response_due_at equals slaDueAt for the received time", async () => {
    await signIn("technical_admin");
    const receivedAt = new Date("2026-10-02T15:30:00Z");
    const result = await actions.logSupportRequest({ title: "Invoice PDF missing", severity: "normal", channel: "email", receivedAt });
    const reference = result.ok ? result.data.reference : "";
    const [row] = await handle.db.select().from(supportRequests).where(eq(supportRequests.reference, reference));
    expect(row!.responseDueAt.toISOString()).toBe(slaDueAt("normal", receivedAt, DEFAULT_SUPPORT_CALENDAR).toISOString());
    expect(row!.receivedAt.toISOString()).toBe(receivedAt.toISOString());
  });

  it("open -> responded sets first_response_at; closed -> responded is refused", async () => {
    await signIn("technical_admin");
    const created = await actions.logSupportRequest({ title: "Slow agenda", severity: "high", channel: "slack", receivedAt: new Date(Date.now() - 3_600_000) });
    const [row] = await handle.db.select().from(supportRequests).where(eq(supportRequests.reference, created.ok ? created.data.reference : ""));
    expect(await actions.updateSupportRequest({ id: row!.id, status: "responded" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.updateSupportRequest({ id: row!.id, status: "responded", note: "Looking into it" })).toMatchObject({ ok: true });
    const [responded] = await handle.db.select().from(supportRequests).where(eq(supportRequests.id, row!.id));
    expect(responded!.firstResponseAt).not.toBeNull();
    expect(responded!.description).toContain("Looking into it");
    expect(await actions.updateSupportRequest({ id: row!.id, status: "resolved" })).toMatchObject({ ok: true });
    expect(await actions.updateSupportRequest({ id: row!.id, status: "closed" })).toMatchObject({ ok: true });
    expect(await actions.updateSupportRequest({ id: row!.id, status: "responded", note: "again" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await auditRows("support.update", row!.id)).length).toBe(3);
  });
});

describe("platform.build_monthly_report (PL-89)", () => {
  const monthOn = "2026-09-01";
  const at = (iso: string) => new Date(iso);

  it("writes the expected data, upserts on rerun, skips a sent month and retries a failing SLA call", async () => {
    const reporter = await makeUser(handle.db, { roleKey: "reception" });
    const base = { severity: "high" as const, channel: "email" as const, title: "Breach", reportedByUserId: reporter.id };
    await handle.db.insert(supportRequests).values([
      { ...base, reference: "SUP-2026-9001", receivedAt: at("2026-09-08T08:00:00Z"), responseDueAt: at("2026-09-08T10:00:00Z"), firstResponseAt: at("2026-09-08T12:00:00Z") },
      { ...base, reference: "SUP-2026-9002", receivedAt: at("2026-09-09T08:00:00Z"), responseDueAt: at("2026-09-09T10:00:00Z"), firstResponseAt: at("2026-09-09T11:00:00Z") },
      { ...base, reference: "SUP-2026-9003", severity: "normal", receivedAt: at("2026-09-10T08:00:00Z"), responseDueAt: at("2026-09-10T15:00:00Z"), firstResponseAt: at("2026-09-10T08:30:00Z") },
    ]);
    await handle.db.insert(jobs).values({ kind: "jobs.prune", payload: {}, idempotencyKey: `report:${randomUUID()}`, status: "dead", attempts: 6, finishedAt: at("2026-09-15T10:00:00Z") });
    const integrations = createFakeIntegrations();
    integrations.betterstack.setSla({ availabilityPct: 99.62, downtimeSeconds: 9_850 });

    await runJobTwice(handle.db, "platform.build_monthly_report", { monthOn }, { integrations });
    const rows = await handle.db.select().from(monthlyReports).where(eq(monthlyReports.monthOn, monthOn));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({
      uptime_pct: 99.62,
      downtime_minutes: 164,
      uptime_source: "betterstack",
      dead_jobs: 1,
      support: { per_severity: { high: { received: 2, breaches: 2, median_first_response_minutes: 210 }, normal: { received: 1, breaches: 0 } } },
    });

    await handle.db.update(monthlyReports).set({ status: "sent" }).where(eq(monthlyReports.monthOn, monthOn));
    integrations.betterstack.setSla({ availabilityPct: 10 });
    const def = (await loadJobs())["platform.build_monthly_report"]!;
    expect(await def.run(makeJobCtx(handle.db, "platform.build_monthly_report", { integrations }), { monthOn })).toEqual({ monthOn, skipped: true });
    expect((await handle.db.select().from(monthlyReports).where(eq(monthlyReports.monthOn, monthOn)))[0]!.data.uptime_pct).toBe(99.62);

    integrations.betterstack.failNext(503);
    await expect(def.run(makeJobCtx(handle.db, "platform.build_monthly_report", { integrations }), { monthOn: "2026-08-01" })).rejects.toMatchObject({ retryable: true });
  });

  it("sendMonthlyReport emails the recipients once; a second send is conflict", async () => {
    await signIn("owner");
    await handle.db.delete(settings).where(eq(settings.key, "support"));
    const support = {
      business_hours: { weekday: ["09:00", "18:00"], weekend_critical: ["10:00", "18:00"] },
      response_minutes: { critical_business: 120, critical_weekend: 240, high: 240, normal: 540, improvement: 1080 },
      emergency_phone: "+32 9 000 00 00",
      support_email: "support@demo.beam.be",
      report_recipients: ["management@demo.beam.be"],
    };
    expect(await actions.updateSetting({ key: "support", value: support, expectedVersion: 0 })).toMatchObject({ ok: true });
    const [report] = await handle.db
      .insert(monthlyReports)
      .values({ monthOn: "2026-07-01", data: { uptime_pct: 99.9, downtime_minutes: 43, uptime_source: "betterstack", incidents: { critical: 0, high: 0, normal: 0 }, support: { per_severity: {} as never }, dead_jobs: 0, alerts_sent: 0, backups_ok: 31, backups_failed: 0, restore_drill: null, ai_spend_cents: 0, db_size_bytes: 0, files_size_bytes: 0 } })
      .returning();
    expect(await actions.updateMonthlyReport({ id: report!.id, notes: "Quiet month", uptimePct: 99.8 })).toMatchObject({ ok: true });
    expect(await actions.sendMonthlyReport({ id: report!.id })).toEqual({ ok: true, data: { recipients: 1 } });
    expect(sent.filter((s) => s.template === "platform.monthly_report")).toHaveLength(1);
    expect(await actions.sendMonthlyReport({ id: report!.id })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.updateMonthlyReport({ id: report!.id, notes: "late edit" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const [row] = await handle.db.select().from(monthlyReports).where(eq(monthlyReports.id, report!.id));
    expect(row).toMatchObject({ status: "sent", notes: "Quiet month" });
    expect(row!.data).toMatchObject({ uptime_pct: 99.8, uptime_source: "manual" });
  });
});
