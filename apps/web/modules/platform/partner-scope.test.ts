/**
 * Partner scope (platform-P9, R3): external partners are staff-audience users with role
 * `external_partner`, linked to a person whose `partner_company_id` sets what they may see
 * (platform spec decision 45, `users_partner_person_ck`, 4.8 `partnerScope`).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb, ensureRole, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { companies, integrationCalls, roles, users, webhookEvents, type RoleKey } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "partner-scope-test-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.40", "x-pathname": "/admin" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
class RedirectSignal extends Error {
  constructor(readonly href: string) {
    super(`redirect:${href}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new RedirectSignal(href);
  },
  notFound: () => {
    throw new Error("not_found");
  },
}));

const auth = await import("@/lib/auth");
const { action } = await import("@/lib/action");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime, makeCtx } = await import("@/lib/testing");
const { PERMISSIONS } = await import("@/registry/permissions.generated");
const { partnerScope, requirePartnerOrPermission } = await import("./api");
const { getTokenIntegrationStatus } = await import("./queries");
const actions = await import("./actions");

let handle: DbHandle;
let companyA: string;
let companyB: string;

async function makeCompany(name: string): Promise<string> {
  const [row] = await handle.db.insert(companies).values({ name, isPartner: true }).returning({ id: companies.id });
  return row!.id;
}

async function makePartner(companyId: string | null) {
  const person = await makePerson(handle.db, { partnerCompanyId: companyId });
  return makeUser(handle.db, { roleKey: "external_partner", personId: person.id });
}

/** Signs `user` in with a staff session that passed MFA and returns its actor, as requests see it. */
async function signIn(user: { id: string; roleKey: RoleKey | null }) {
  const { token } = await auth.createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: user.roleKey!, now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return auth.requireStaff();
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  for (const key of ["owner", "reception", "external_partner"] as const) await ensureRole(handle.db, key);
  await handle.db.update(roles).set({ permissions: ["partner.own"] }).where(eq(roles.key, "external_partner"));
  await handle.db.update(roles).set({ permissions: ["persons.read", "bookings.read"] }).where(eq(roles.key, "reception"));
  companyA = await makeCompany("Partner A BV");
  companyB = await makeCompany("Partner B BV");
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => jar.clear());

describe("partner accounts", () => {
  it("a partner user without a person cannot exist (users_partner_person_ck)", async () => {
    await ensureRole(handle.db, "external_partner");
    await expect(
      handle.db.insert(users).values({ audience: "staff", email: "partner-no-person@example.com", name: "No Person", locale: "en", roleKey: "external_partner", mfaEnrolledAt: new Date() }),
    ).rejects.toThrow();
    const rows = await handle.db.select({ id: users.id }).from(users).where(eq(users.email, "partner-no-person@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("the role change to external_partner is refused for a user without a person", async () => {
    await signIn(await makeUser(handle.db, { roleKey: "owner" }));
    const staff = await makeUser(handle.db, { roleKey: "reception" });
    const result = await actions.updateStaffUser({ userId: staff.id, roleKey: "external_partner" });
    expect(result.ok).toBe(false);
    const [row] = await handle.db.select({ roleKey: users.roleKey }).from(users).where(eq(users.id, staff.id));
    expect(row!.roleKey).toBe("reception");
  });
});

describe("partnerScope and requirePartnerOrPermission", () => {
  it("a partner sees only the company of its own person", async () => {
    const a = await signIn(await makePartner(companyA));
    expect(await partnerScope(makeCtx(handle.db, a))).toEqual({ companyId: companyA });
    expect(await requirePartnerOrPermission(makeCtx(handle.db, a), "partner.own")).toEqual({ companyId: companyA });

    const b = await signIn(await makePartner(companyB));
    expect(await partnerScope(makeCtx(handle.db, b))).toEqual({ companyId: companyB });
    expect(await requirePartnerOrPermission(makeCtx(handle.db, b), "persons.read")).toEqual({ companyId: companyB });
  });

  it("a partner stays scoped even when its role was granted the view's permission", async () => {
    await handle.db.update(roles).set({ permissions: ["partner.own", "persons.read"] }).where(eq(roles.key, "external_partner"));
    try {
      const a = await signIn(await makePartner(companyA));
      expect(await requirePartnerOrPermission(makeCtx(handle.db, a), "persons.read")).toEqual({ companyId: companyA });
    } finally {
      await handle.db.update(roles).set({ permissions: ["partner.own"] }).where(eq(roles.key, "external_partner"));
    }
  });

  it("a partner whose person has no partner company is forbidden", async () => {
    const lone = await signIn(await makePartner(null));
    await expect(partnerScope(makeCtx(handle.db, lone))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requirePartnerOrPermission(makeCtx(handle.db, lone), "persons.read")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("staff with the view's permission are unrestricted; without it and without partner.own they are forbidden", async () => {
    const owner = await signIn(await makeUser(handle.db, { roleKey: "owner" }));
    expect(await requirePartnerOrPermission(makeCtx(handle.db, owner), "persons.read")).toEqual({ companyId: null });
    const reception = await signIn(await makeUser(handle.db, { roleKey: "reception" }));
    expect(await requirePartnerOrPermission(makeCtx(handle.db, reception), "persons.read")).toEqual({ companyId: null });
    await expect(requirePartnerOrPermission(makeCtx(handle.db, reception), "reports.read")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(partnerScope(makeCtx(handle.db, reception))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("customers and the system actor have no partner scope", async () => {
    const person = await makePerson(handle.db, { partnerCompanyId: companyA });
    const customer = makeCtx(handle.db, { kind: "customer", userId: "00000000-0000-4000-8000-000000000001", personId: person.id });
    await expect(partnerScope(customer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requirePartnerOrPermission(customer, "persons.read")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(partnerScope(makeCtx(handle.db))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("staff actions", () => {
  it("a partner calling an action that needs any other permission gets forbidden, before the handler runs", async () => {
    await signIn(await makePartner(companyA));
    const handler = vi.fn(() => Promise.resolve("ran"));
    for (const permission of PERMISSIONS.filter((p) => p !== "partner.own")) {
      const run = action({ name: "platform.partner_probe", audience: "staff", permission, input: z.object({}), audit: false }, handler);
      const result = await run({});
      expect(result.ok, permission).toBe(false);
      if (!result.ok) expect(result.error.code, permission).toBe("forbidden");
    }
    expect(handler).not.toHaveBeenCalled();
    const own = await action({ name: "platform.partner_probe", audience: "staff", permission: "partner.own", input: z.object({}), audit: false }, handler)({});
    expect(own).toEqual({ ok: true, data: "ran" });
  });

  it("platform's own staff actions refuse a partner", async () => {
    await signIn(await makePartner(companyA));
    const setting = await actions.updateSetting({ key: "security", value: {}, expectedVersion: 1 });
    expect(setting.ok ? null : setting.error.code).toBe("forbidden");
    const invite = await actions.inviteStaffUser({ email: "invitee@example.com", name: "Invitee", roleKey: "reception", locale: "en" });
    expect(invite.ok ? null : invite.error.code).toBe("forbidden");
  });
});

describe("partner landing", () => {
  it("/admin redirects a partner to /admin/partner", async () => {
    await signIn(await makePartner(companyA));
    const { default: AdminHome } = await import("@/app/(admin)/admin/page");
    await expect(AdminHome()).rejects.toMatchObject({ href: "/admin/partner" });
  });

  it("/admin keeps other roles on their own first page", async () => {
    await signIn(await makeUser(handle.db, { roleKey: "owner" }));
    const { default: AdminHome } = await import("@/app/(admin)/admin/page");
    const signal = await AdminHome().then(
      () => null,
      (e: unknown) => e,
    );
    expect(signal).toBeInstanceOf(RedirectSignal);
    expect((signal as RedirectSignal).href).not.toBe("/admin/partner");
  });
});

describe("token integrations (System integrations screen)", () => {
  it("reports token presence by env name and the last successful pull or webhook as data date", async () => {
    const old = new Date(Date.now() - 3 * 86_400_000);
    const recent = new Date(Date.now() - 3_600_000);
    await handle.db.insert(integrationCalls).values([
      { provider: "meta_ads", operation: "insights.get", requestDigest: "a".repeat(64), ok: true, durationMs: 10, createdAt: old },
      { provider: "meta_ads", operation: "insights.get", requestDigest: "b".repeat(64), ok: false, durationMs: 10, createdAt: recent },
    ]);
    await handle.db.insert(webhookEvents).values({ provider: "meta", externalEventId: "partner-scope-1", payload: {}, jobId: "00000000-0000-4000-8000-000000000002", receivedAt: recent });

    const status = await getTokenIntegrationStatus(handle.db, { META_ADS_TOKEN: "set", GOOGLE_ADS_TOKEN: " ", META_APP_SECRET: "set" });
    const by = Object.fromEntries(status.map((s) => [s.provider, s]));
    expect(by.meta_ads).toMatchObject({ configured: true, dataAsOf: old, lastErrorAt: recent });
    expect(by.google_ads).toMatchObject({ configured: false, dataAsOf: null, tokens: [{ name: "GOOGLE_ADS_TOKEN", configured: false }] });
    expect(by.meta!.configured).toBe(false);
    expect(by.meta!.tokens).toEqual([
      { name: "META_APP_SECRET", configured: true },
      { name: "META_VERIFY_TOKEN", configured: false },
    ]);
    expect(by.meta!.dataAsOf).toEqual(recent);
  });
});
