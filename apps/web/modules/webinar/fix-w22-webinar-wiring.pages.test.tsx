/**
 * fix-w22-webinar-wiring: the webinar wiring of the admin screens (webinar spec 5.1).
 * - `/admin/webinars/[id]/registrations` has "Export CSV" (`persons.export`) that runs
 *   `exportWebinarRegistrants` and comes back with the file's download link; the row actions
 *   Mute/Unmute, Block and Unblock run `moderate` with the matching moderation action.
 * - `/admin/webinars/[id]` links the host console `/admin/webinars/[id]/host` (webinar-P5 request).
 * The pages run against a PGlite database with the webinar factories; auth, locale and the
 * actions are mocked, and the server actions are taken from the returned element tree.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@beam/core/i18n";
import type { DbHandle } from "@beam/db";
import { createTestDb } from "@beam/db/testing";
import type * as I18nLib from "@/lib/i18n";
import { makeRegistration, makeWebinar } from "./test/factories";

const fx = vi.hoisted(() => ({
  perms: new Set<string>(["webinars.host", "persons.read", "persons.export"]),
  calls: [] as Array<{ name: string; input: unknown }>,
  results: new Map<string, unknown>(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));
vi.mock("@/lib/auth", () => ({
  requireStaff: () => Promise.resolve({ kind: "staff", userId: "00000000-0000-4000-8000-000000000001", roleKey: "marketing", permissions: [...fx.perms] }),
  hasPermission: (_actor: unknown, permission: string) => fx.perms.has(permission),
  getSession: () => Promise.resolve(null),
}));
vi.mock("@/lib/i18n", async (orig) => ({ ...(await orig<typeof I18nLib>()), adminLocale: () => Promise.resolve("en") }));
vi.mock("@/modules/webinar/actions", () => {
  const record = (name: string) => (input: unknown) => {
    fx.calls.push({ name, input });
    return Promise.resolve(fx.results.get(name) ?? { ok: true, data: { changed: true } });
  };
  const names = ["cancelRegistrationByStaff", "exportWebinarRegistrants", "moderate", "registerPersonByStaff", "resendAccessLink", "revokeAccessLink"];
  return Object.fromEntries(names.map((n) => [n, record(n)]));
});

const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { default: RegistrationsPage } = await import("../../app/(admin)/admin/webinars/[id]/registrations/page");
const { default: DetailPage } = await import("../../app/(admin)/admin/webinars/[id]/page");
const { RegistrationsTable } = await import("./ui/registrations-table");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
}, 120_000);
afterAll(async () => {
  setAppDb(undefined);
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  fx.perms = new Set(["webinars.host", "persons.read", "persons.export"]);
  fx.calls = [];
  fx.results = new Map();
});

type Props = Record<string, unknown> & { children?: ReactNode };

/** Every element of a returned tree, without calling function components. */
function elements(node: ReactNode): Array<ReactElement<Props>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

const en = (key: string, params?: Record<string, string | number>) => t("en", key, params);
const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(textOf).join("") : isValidElement<Props>(node) ? textOf(node.props.children) : "";

/** Runs a server action and returns the URL it redirects to. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Error && e.message === "NEXT_REDIRECT") return (e as Error & { url: string }).url;
    throw e;
  }
  throw new Error("the action did not redirect");
}

async function registrationsTree(webinarId: string, searchParams: Record<string, string> = {}) {
  return RegistrationsPage({ params: Promise.resolve({ id: webinarId }), searchParams: Promise.resolve(searchParams) });
}

const exportForm = (tree: ReactNode) => elements(tree).find((e) => e.type === "form" && e.props["data-testid"] === "webinar-registrants-export");

describe("registrations page: Export CSV (webinar spec 5.1, rule 41)", () => {
  it("shows Export CSV for persons.export and runs exportWebinarRegistrants, then links the file", async () => {
    const w = await makeWebinar(h.db, {}, { published: true });
    await makeRegistration(h.db, { webinarId: w.id });
    const form = exportForm(await registrationsTree(w.id));
    expect(form).toBeDefined();
    expect(textOf(form!.props.children)).toBe(en("webinar.admin.registrations.export"));

    const fileId = "0d6b3c1e-6a43-4c39-9a2d-5b8f0e1f2a3b";
    fx.results.set("exportWebinarRegistrants", { ok: true, data: { fileId } });
    const url = await redirectOf(() => (form!.props.action as () => Promise<void>)());
    expect(fx.calls).toEqual([{ name: "exportWebinarRegistrants", input: { webinarId: w.id } }]);
    expect(url).toBe(`/admin/webinars/${w.id}/registrations?file=${fileId}`);

    const back = await registrationsTree(w.id, { file: fileId });
    const link = elements(back).find((e) => e.type === "a" && e.props.href === `/api/public/files/${fileId}`);
    expect(link).toBeDefined();
    expect(textOf(link!.props.children)).toBe(en("webinar.admin.registrations.export_download"));
  });

  it("reports a refused export as an error and hides the button without persons.export", async () => {
    const w = await makeWebinar(h.db, {}, { published: true });
    await makeRegistration(h.db, { webinarId: w.id });
    fx.results.set("exportWebinarRegistrants", { ok: false, error: { code: "forbidden", message: "forbidden" } });
    const tree = await registrationsTree(w.id);
    const url = await redirectOf(() => (exportForm(tree)!.props.action as () => Promise<void>)());
    expect(url).toBe(`/admin/webinars/${w.id}/registrations?error=forbidden`);

    fx.perms.delete("persons.export");
    expect(exportForm(await registrationsTree(w.id))).toBeUndefined();
  });
});

describe("registrations page: Mute, Unmute, Block and Unblock run moderate", () => {
  it.each([
    ["mute", "mute_viewer"],
    ["unmute", "unmute_viewer"],
    ["block", "block_viewer"],
    ["unblock", "unblock_viewer"],
  ] as const)("op %s runs moderate with %s", async (op, action) => {
    const w = await makeWebinar(h.db, {}, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const table = elements(await registrationsTree(w.id)).find((e) => e.type === RegistrationsTable);
    expect(table).toBeDefined();
    const fd = new FormData();
    fd.set("op", op);
    fd.set("registrationId", r.id);
    const url = await redirectOf(() => (table!.props.action as (f: FormData) => Promise<void>)(fd));
    expect(fx.calls).toEqual([{ name: "moderate", input: { webinarId: w.id, action, registrationId: r.id } }]);
    expect(url).toBe(`/admin/webinars/${w.id}/registrations?done=1`);
  });

  it("refuses an unknown op without calling an action", async () => {
    const w = await makeWebinar(h.db, {}, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const table = elements(await registrationsTree(w.id)).find((e) => e.type === RegistrationsTable);
    const fd = new FormData();
    fd.set("op", "erase");
    fd.set("registrationId", r.id);
    expect(await redirectOf(() => (table!.props.action as (f: FormData) => Promise<void>)(fd))).toBe(`/admin/webinars/${w.id}/registrations?error=internal`);
    expect(fx.calls).toEqual([]);
  });

  it("the table offers Mute or Unmute and Block for registered rows and Unblock for blocked rows", async () => {
    const w = await makeWebinar(h.db, {}, { published: true });
    const plain = await makeRegistration(h.db, { webinarId: w.id });
    const muted = await makeRegistration(h.db, { webinarId: w.id, mutedAt: new Date() });
    const blocked = await makeRegistration(h.db, { webinarId: w.id, status: "blocked" });
    const table = elements(await registrationsTree(w.id)).find((e) => e.type === RegistrationsTable)!;
    const html = renderToStaticMarkup(<RegistrationsTable {...(table.props as Parameters<typeof RegistrationsTable>[0])} />);
    const opsFor = (id: string) => [...html.matchAll(new RegExp(`name="op" value="([a-z]+)"/><input type="hidden" name="registrationId" value="${id}"`, "g"))].map((m) => m[1]);
    expect(opsFor(plain.id)).toEqual(["resend", "revoke", "mute", "block", "cancel"]);
    expect(opsFor(muted.id)).toEqual(["resend", "revoke", "unmute", "block", "cancel"]);
    expect(opsFor(blocked.id)).toEqual(["unblock"]);
  });
});

describe("webinar detail page: host console link (webinar-P5 request)", () => {
  it("links /admin/webinars/[id]/host", async () => {
    const w = await makeWebinar(h.db, {}, { published: true });
    const tree = await DetailPage({ params: Promise.resolve({ id: w.id }) });
    const link = elements(tree).find((e) => e.props.href === `/admin/webinars/${w.id}/host`);
    expect(link).toBeDefined();
    expect(textOf(link!.props.children)).toBe(en("webinar.admin.detail.host_link"));
  });
});
