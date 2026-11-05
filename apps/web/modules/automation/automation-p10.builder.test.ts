/**
 * automation-P10 (R4): `saveBuilderGraph` converts the builder's flow with `graphToDefinition`
 * and takes the path of `saveDraft` (saved even with field issues, one `automation.update_draft`
 * audit row); a flow with structural issues leaves the draft as it was and returns its issues
 * with `saved: false`; the permission is `automations.write`. The builder canvas renders every
 * seeded journey as blocks and lanes without React context (CONVENTIONS 12). Email's `getPublishedTemplateInfo`
 * is mocked to the shape its contract promises (CONVENTIONS 11).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, automations, roles } from "@beam/db/schema";
import type { Definition } from "@beam/core/automation";
import type * as EmailApi from "@/modules/email/api";
import { definitionToGraph, type BuilderGraph, type BuilderNode } from "../../../../packages/core/src/automation/builder";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.61" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getPublishedTemplateInfo: (_db: unknown, slugs: string[]) =>
    Promise.resolve(new Map(slugs.filter((s) => s === "welcome-mail").map((s) => [s, { templateVersionId: crypto.randomUUID(), kind: "marketing" as const, purpose: "newsletter", locales: ["nl-BE", "fr-BE", "en"] }]))),
}));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { makeAutomation } = await import("./engine/automation-p2.fixtures");
const { BuilderCanvas } = await import("./ui/builder/canvas");
const { automationLabels } = await import("./queries");
const { SEED_AUTOMATIONS } = await import("@beam/core/automation/seeds");

let handle: DbHandle;
let userId: string;

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
function ok<T>(r: Result): T {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as { ok: true; data: T }).data;
}

const flow: Definition = {
  schema_version: 1,
  trigger: { event: "booking.confirmed" },
  anchor: "enrolment",
  re_entry: "never",
  exit_on: [],
  steps: [
    { key: "delay", type: "wait", minutes: 60 },
    { key: "branch", type: "condition", if: { has_active_membership: true }, then: "welcome", else: "follow_up" },
    { key: "welcome", type: "email", template: "welcome-mail" },
    { key: "follow_up", type: "task", title: "Call", kind: "call", owner_role: "marketing", due_in_minutes: 1440, priority: "normal" },
  ],
};

async function audits(action: string, entityId: string) {
  return handle.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
}
async function draftOf(id: string) {
  const [a] = await handle.db.select({ draft: automations.draftDefinition }).from(automations).where(eq(automations.id, id));
  return a!.draft;
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  const user = await makeUser(handle.db, { roleKey: "marketing" });
  userId = user.id;
  await handle.db.update(roles).set({ permissions: ["automations.write"] }).where(eq(roles.key, "marketing"));
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  jar.clear();
  const { token } = await createAuthSession(handle.db, { userId, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
});

describe("saveBuilderGraph", () => {
  it("saves the flow as the draft, returns its issues and audits automation.update_draft once", async () => {
    const a = await makeAutomation(handle.db, { definition: { ...flow, steps: [flow.steps[2]!] } });
    const graph = JSON.parse(JSON.stringify(definitionToGraph(flow))) as BuilderGraph;
    const r = ok<{ issues: { code: string }[]; saved: boolean }>(await actions.saveBuilderGraph({ automationId: a.id, graph }));
    expect(r).toEqual({ issues: [], saved: true });
    expect(await draftOf(a.id)).toEqual(flow);
    expect(await audits("automation.update_draft", a.id)).toHaveLength(1);
  });

  it("saves a flow with field issues and returns them", async () => {
    const a = await makeAutomation(handle.db, { definition: flow });
    const withMissing: Definition = { ...flow, steps: flow.steps.map((s) => (s.type === "email" ? { ...s, template: "missing-mail" } : s)) };
    const r = ok<{ issues: { code: string; path: string }[]; saved: boolean }>(await actions.saveBuilderGraph({ automationId: a.id, graph: definitionToGraph(withMissing) }));
    expect(r.saved).toBe(true);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: "template_unavailable", path: "steps.2.template" }));
    expect(await draftOf(a.id)).toEqual(withMissing);
  });

  it("a flow with structural issues keeps the draft and writes no audit row", async () => {
    const a = await makeAutomation(handle.db, { definition: flow });
    const before = await draftOf(a.id);
    const g = definitionToGraph(flow);
    const dup: BuilderNode = { id: "dup", kind: "step", step: { key: "delay", type: "wait", minutes: 5 } };
    const r = ok<{ issues: { code: string }[]; saved: boolean }>(await actions.saveBuilderGraph({ automationId: a.id, graph: { ...g, blocks: [...g.blocks, dup] } }));
    expect(r.saved).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(["duplicate_step_key"]);
    expect(await draftOf(a.id)).toEqual(before);
    expect(await audits("automation.update_draft", a.id)).toHaveLength(0);
    const empty = ok<{ issues: { code: string }[]; saved: boolean }>(await actions.saveBuilderGraph({ automationId: a.id, graph: { ...g, blocks: [] } }));
    expect(empty).toMatchObject({ saved: false, issues: [expect.objectContaining({ code: "builder_empty" })] });
  });

  it("refuses a malformed graph (validation) and a staff member without automations.write (forbidden)", async () => {
    const a = await makeAutomation(handle.db, { definition: flow });
    const bad = await actions.saveBuilderGraph({ automationId: a.id, graph: { version: 2, blocks: [] } as unknown as BuilderGraph });
    expect(bad).toMatchObject({ ok: false, error: { code: "validation" } });
    await handle.db.update(roles).set({ permissions: ["reports.read"] }).where(eq(roles.key, "marketing"));
    try {
      const r = await actions.saveBuilderGraph({ automationId: a.id, graph: definitionToGraph(flow) });
      expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    } finally {
      await handle.db.update(roles).set({ permissions: ["automations.write"] }).where(eq(roles.key, "marketing"));
    }
  });
});

describe("BuilderCanvas", () => {
  const labels = automationLabels("en", ["builder", "editor", "publish", "issue", "errors", "purpose", "status", "detail", "list", "common"]);
  const options = { tags: ["engaged"], segments: [], eventKinds: ["booking.confirmed"], templates: [], automations: [], roles: ["marketing"] };
  const render = (d: Definition, canEdit = true) =>
    renderToStaticMarkup(
      createElement(BuilderCanvas, {
        automation: { id: "00000000-0000-4000-8000-000000000001", slug: "x", name: "X" },
        initialGraph: definitionToGraph(d),
        savedIssues: [],
        options,
        migratableCount: 0,
        canEdit,
        canPublish: canEdit,
        labels,
      }),
    );

  it("renders the trigger, the blocks and both lanes of a branch with their palette", () => {
    const html = render(flow);
    expect(html).toContain('data-testid="builder-block-trigger"');
    for (const s of flow.steps) expect(html).toContain(`data-testid="builder-block-${s.key}"`);
    expect(html).toContain('data-testid="builder-lane-branch-then"');
    expect(html).toContain('data-testid="builder-lane-branch-else"');
    expect(html).toContain('data-testid="builder-palette-webhook"');
    expect(html).toContain(labels["builder.block.branch"]!);
    expect(html).not.toContain("{count}");
  });

  it("renders every seeded journey, and read-only without palette or move controls", () => {
    for (const seed of SEED_AUTOMATIONS) expect(() => render(seed.definition)).not.toThrow();
    const ro = render(flow, false);
    expect(ro).not.toContain('data-testid="builder-save"');
    expect(ro).not.toContain('data-testid="builder-remove-delay"');
    expect(ro).toContain(labels["builder.readonly"]!);
  });
});
