/**
 * email-P5 action permissions (email spec section 7): template edits, duplicates, test sends and
 * previews need `email.write`; publishing and archiving need `email.send`. Without the
 * permission each action answers `forbidden` before anything is written; a customer session is
 * `unauthorized`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailTemplates, roles } from "@beam/db/schema";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.55" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { blockTemplate, completeCompany } = await import("./email-p3.fixtures");

let handle: DbHandle;
let templateId: string;
let staffEmail: string;

async function asStaff(perms: string[]) {
  const user = await makeUser(handle.db, { roleKey: "sales" });
  await handle.db.update(roles).set({ permissions: perms }).where(eq(roles.key, "sales"));
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "sales", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  staffEmail = user.email;
  return user;
}

async function asCustomer() {
  const user = await makeUser(handle.db, { audience: "customer" });
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  await completeCompany(handle.db);
  templateId = await blockTemplate(handle.db, { slug: "p5-permissions", kind: "marketing" });
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => jar.clear());

const now = () => new Date();
type Call = [label: string, permission: "email.write" | "email.send", run: () => Promise<{ ok: boolean; error?: { code: string } }>];

const calls = (): Call[] => [
  ["createTemplate", "email.write", () => actions.createTemplate({ name: "P5 perm", kind: "marketing", purpose: "newsletter" })],
  ["saveTemplateDraft", "email.write", () => actions.saveTemplateDraft({ templateId, draftUpdatedAt: now(), subject: {}, preheader: {} })],
  ["duplicateTemplate", "email.write", () => actions.duplicateTemplate({ templateId, name: "P5 perm copy" })],
  ["sendTestEmail", "email.write", () => actions.sendTestEmail({ templateId, use: "current", locales: ["en"], to: [staffEmail], as: { sample: "lead" } })],
  ["previewTemplate", "email.write", () => actions.previewTemplate({ templateId, use: "current", locale: "en" })],
  ["publishTemplateVersion", "email.send", () => actions.publishTemplateVersion({ templateId, draftUpdatedAt: now() })],
  ["archiveTemplate", "email.send", () => actions.archiveTemplate({ templateId })],
];

describe("email-P5 actions", () => {
  it("refuse staff without the action's permission and write nothing", async () => {
    const before = await handle.db.select().from(emailTemplates);
    for (const [label, permission, run] of calls()) {
      await asStaff(permission === "email.send" ? ["email.write"] : ["persons.read"]);
      expect({ label, result: await run() }).toMatchObject({ label, result: { ok: false, error: { code: "forbidden" } } });
    }
    expect(await handle.db.select().from(emailTemplates)).toHaveLength(before.length);
  });

  it("answer unauthorized for a customer session", async () => {
    await asCustomer();
    for (const [label, , run] of calls()) expect({ label, result: await run() }).toMatchObject({ label, result: { ok: false, error: { code: "unauthorized" } } });
  });

  it("run with the permission", async () => {
    await asStaff(["email.write", "email.send"]);
    const created = await actions.createTemplate({ name: "P5 allowed", kind: "marketing", purpose: "events" });
    expect(created.ok).toBe(true);
    const preview = await actions.previewTemplate({ templateId, use: "current", locale: "nl-BE", as: { sample: "member" } });
    expect(preview).toMatchObject({ ok: true });
    const test = await actions.sendTestEmail({ templateId, use: "current", locales: ["en"], to: [staffEmail], as: { sample: "lead" } });
    expect(test).toMatchObject({ ok: true });
  });
});
