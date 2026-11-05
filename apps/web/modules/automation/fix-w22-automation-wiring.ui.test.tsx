/**
 * fix-w22-automation-wiring, the screen wiring of the open automation requests: the list links
 * the rules and conflict screens for `automations.publish`, `AutomationHeader` has a Builder
 * tab, the enrolments table has a per-row Exit (`exitEnrolment`) for active rows when the viewer
 * may move persons, the person panel's labels come from the catalogue alone (every key in all
 * three languages), and the builder side panel renders the single-step `StepForm` with every
 * step key of the flow plus the "Add step" picker and Remove.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { roles, users } from "@beam/db/schema";
import type { BuilderNode } from "@beam/core/automation";
import { LOCALES } from "@beam/core/i18n";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.62" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { automationLabels } = await import("./queries");
const { AutomationHeader } = await import("./ui/automation-table");
const { EnrolmentTable } = await import("./ui/run-log");
const { panelLabels } = await import("./ui/person-automations-panel");
const { NodePanel } = await import("./ui/builder/side-panel");
const { default: AutomationsPage } = await import("@/app/(admin)/admin/automations/page");

let handle: DbHandle;
let userId: string;

async function signInWith(permissions: string[]) {
  await handle.db.update(roles).set({ permissions }).where(eq(roles.key, "marketing"));
  jar.clear();
  const { token } = await createAuthSession(handle.db, { userId, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  const user = await makeUser(handle.db, { roleKey: "marketing" });
  userId = user.id;
  await handle.db.update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, userId));
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => jar.clear());

describe("the automations list", () => {
  it("links the rules and the conflict report for automations.publish", async () => {
    await signInWith(["reports.read", "automations.write", "automations.publish"]);
    const html = renderToStaticMarkup(await AutomationsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('href="/admin/automations/rules"');
    expect(html).toContain('href="/admin/automations/conflicts"');
    expect(html).toContain('href="/admin/automations/groups"');
  });

  it("hides both links without automations.publish", async () => {
    await signInWith(["reports.read"]);
    const html = renderToStaticMarkup(await AutomationsPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain("/admin/automations/rules");
    expect(html).not.toContain("/admin/automations/conflicts");
  });
});

describe("AutomationHeader", () => {
  it("has a Builder tab after the editor, marked current on the builder page", () => {
    const l = automationLabels("en", ["detail", "status", "common"]);
    const id = "00000000-0000-4000-8000-000000000022";
    const html = renderToStaticMarkup(createElement(AutomationHeader, { id, name: "X", slug: "x", status: "draft", current: "builder", l }));
    expect(html).toContain(`href="/admin/automations/${id}/builder"`);
    expect(html).toMatch(new RegExp(`<a aria-current="page"[^>]*href="/admin/automations/${id}/builder">${l["detail.tab_builder"]}</a>`));
    expect(html.indexOf(`/${id}/edit"`)).toBeLessThan(html.indexOf(`/${id}/builder"`));
  });
});

describe("EnrolmentTable", () => {
  const l = automationLabels("en", ["enrolments", "enrolment_status", "source", "end_reason", "status", "common", "panel", "errors"]);
  const row = (id: string, status: "active" | "completed" | "exited") => ({
    id,
    personId: "00000000-0000-4000-8000-0000000000f1",
    firstName: "Ann",
    lastName: "Peeters",
    status,
    source: "trigger",
    versionNumber: 1,
    enteredAt: new Date("2026-11-05T10:00:00Z"),
    nextStepKey: status === "active" ? "mail" : null,
    nextStepAt: status === "active" ? new Date("2026-11-06T10:00:00Z") : null,
    endReason: status === "exited" ? "manual" : null,
  });
  const rows = [row("00000000-0000-4000-8000-0000000000a1", "active"), row("00000000-0000-4000-8000-0000000000a2", "exited")];

  it("has a per-row Exit for active enrolments when exit is given", () => {
    const html = renderToStaticMarkup(createElement(EnrolmentTable, { rows, l, locale: "en", exit: { automationName: "X" } }));
    expect(html).toContain('data-exit-for="00000000-0000-4000-8000-0000000000a1"');
    expect(html).not.toContain('data-exit-for="00000000-0000-4000-8000-0000000000a2"');
    expect(html).toContain(l["enrolments.col_actions"]!);
  });

  it("has no Exit column without exit", () => {
    const html = renderToStaticMarkup(createElement(EnrolmentTable, { rows, l, locale: "en" }));
    expect(html).not.toContain("data-exit-for");
    expect(html).not.toContain(l["enrolments.col_actions"]!);
  });
});

describe("panelLabels", () => {
  const KEYS = [
    "panel.empty",
    "panel.exit",
    "panel.exit_title",
    "panel.exit_body",
    "panel.exit_submit",
    "panel.note",
    "preview.failed",
    "errors.enrolment_not_active",
    "errors.enrolment_not_found",
    "errors.person_not_found",
    "errors.anchor_required",
    "errors.move_same_automation",
    "errors.move_refused",
  ];
  it("every panel key comes from the catalogue in all three languages", () => {
    for (const locale of LOCALES) {
      const l = panelLabels(locale);
      for (const k of KEYS) expect(l[k], `${locale} ${k}`).toBeTruthy();
      expect(Object.keys(l).some((k) => k.startsWith("panel.warning."))).toBe(true);
    }
  });
});

describe("NodePanel (builder side panel)", () => {
  const l = automationLabels("en", ["builder", "editor", "issue", "errors", "common"]);
  const options = { tags: ["engaged"], segments: [], eventKinds: ["booking.confirmed"], templates: [], automations: [], roles: ["marketing"] };
  const node = { id: "n1", kind: "step", step: { key: "tag_it", type: "tag", tag: "engaged", unless: { step_ran: "welcome" } } } as unknown as BuilderNode;
  const render = (readOnly: boolean) =>
    renderToStaticMarkup(
      createElement(NodePanel, {
        node,
        onChange: () => undefined,
        onInsertAfter: () => undefined,
        onRemove: () => undefined,
        laterKeys: [],
        allKeys: ["welcome", "tag_it", "follow_up"],
        l,
        options,
        readOnly,
        issues: [],
      }),
    );

  it("renders the single-step form with the add picker and Remove, not the step list", () => {
    const html = render(false);
    expect(html).toContain('data-testid="builder-panel-step"');
    expect(html).not.toContain('data-testid="step-forms"');
    expect(html).toContain('data-testid="add-step-type"');
    expect(html).toContain('data-testid="builder-panel-remove"');
    expect(html).toContain('name="steps.0.key"');
  });

  it("read-only shows neither the picker nor Remove", () => {
    const html = render(true);
    expect(html).not.toContain('data-testid="add-step-type"');
    expect(html).not.toContain('data-testid="builder-panel-remove"');
  });
});
