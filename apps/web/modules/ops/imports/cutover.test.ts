import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { cutoverChecklistItems, jobs, tags } from "@beam/db/schema";
import { createTestDb, makeProduct, makeSession } from "@beam/db/testing";
import { CUTOVER_STEPS, type ImportKind, type ImportMapping } from "@beam/core/ops";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.10" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/automation/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), requestSuppressionExit: vi.fn().mockResolvedValue({ jobId: null }) }));

const actions = await import("./actions");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { getCutoverChecklist } = await import("./queries");
const { drain, dryRun, identityMapping, importOf, realRun, seedImport, signInStaff } = await import("./ops-p4.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await makeProduct(h.db, { kind: "package", sku: "CUT-PKG", creditKind: "day", creditUnits: 5 });
  await makeProduct(h.db, { kind: "membership", sku: "CUT-MEMB" });
  await makeSession(h.db, { startsAt: new Date(Date.UTC(2032, 2, 1, 9, 0)) });
  await h.db.insert(tags).values({ key: "cut_tag", name: { "nl-BE": "Cut", "fr-BE": "Cut", en: "Cut" } });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const stepOf = async (key: (typeof CUTOVER_STEPS)[number]) => (await getCutoverChecklist(h.db)).steps.find((s) => s.key === key)!;

const FILES: Record<ImportKind, { csv: string; mapping: ImportMapping }> = {
  suppressions: { csv: "email\ncut-supp@example.com\n", mapping: identityMapping(["email"]) },
  persons: { csv: "email\ncut-person@example.com\n", mapping: identityMapping(["email"]) },
  consents: { csv: "email,status\ncut-person@example.com,granted\n", mapping: identityMapping(["email", "status"], { consentPurpose: "events" }) },
  tags: { csv: "email,tag_key\ncut-person@example.com,cut_tag\n", mapping: identityMapping(["email", "tag_key"]) },
  companies: { csv: "name\nCut-over BV\n", mapping: identityMapping(["name"]) },
  history: { csv: "external_id,email,history_kind,occurred_at\nCUT-H1,cut-person@example.com,visit,2025-01-01T10:00:00Z\n", mapping: identityMapping(["external_id", "email", "history_kind", "occurred_at"]) },
  packages: { csv: "email,product_sku,units_remaining,expires_on\ncut-person@example.com,CUT-PKG,2,2027-01-01\n", mapping: identityMapping(["email", "product_sku", "units_remaining", "expires_on"]) },
  memberships: { csv: "email,product_sku,period_end_on\ncut-member@example.com,CUT-MEMB,2026-12-31\n", mapping: identityMapping(["email", "product_sku", "period_end_on"]) },
  bookings: { csv: "email,session_starts_at\ncut-person@example.com,2032-03-01T09:00:00Z\n", mapping: identityMapping(["email", "session_starts_at"]) },
};

describe("cut-over checklist (ops rule 53)", () => {
  it("R53 has the 17 steps in order; the gate mirrors isGoLiveGateComplete", async () => {
    const list = await getCutoverChecklist(h.db);
    expect(list.steps.map((s) => s.key)).toEqual([...CUTOVER_STEPS]);
    expect(list.total).toBe(17);
    expect((await stepOf("go_live_gate_complete")).done).toBe(true); // outside production the gate never blocks
  });

  it("R53 consents and persons cannot run before suppressions_imported unless the user confirms no suppression source exists", async () => {
    await signInStaff(h.db, jar, ["persons.write", "settings.write"]);
    const id = await seedImport(h.db, { kind: "consents", csv: FILES.consents.csv, mapping: FILES.consents.mapping });
    await dryRun(h.db, id);
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: false, error: { code: "conflict", message: "suppressions_first" } });
    expect(await actions.startImport({ importId: id, confirmNoSuppressionSource: true })).toMatchObject({ ok: true });
    const [item] = await h.db.select().from(cutoverChecklistItems).where(eq(cutoverChecklistItems.key, "suppressions_imported"));
    expect(item).toMatchObject({ note: "no_suppression_source", doneAt: null });
    await drain(h.db);
    expect((await importOf(h.db, id)).status).toBe("done");
    // The stored confirmation lets the next persons import run.
    const persons = await seedImport(h.db, { kind: "persons", csv: "email\nafter-confirm@example.com\n", mapping: identityMapping(["email"]) });
    await dryRun(h.db, persons);
    expect(await actions.startImport({ importId: persons })).toMatchObject({ ok: true });
    await drain(h.db);
  });

  it("R53 the ten import steps tick themselves when a matching import is done; packages_reconciled also needs the sign-off", async () => {
    for (const kind of Object.keys(FILES) as ImportKind[]) {
      const id = await seedImport(h.db, { kind, source: "simplybook", csv: FILES[kind].csv, mapping: FILES[kind].mapping });
      await dryRun(h.db, id);
      await realRun(h.db, id);
      expect({ kind, status: (await importOf(h.db, id)).status }).toEqual({ kind, status: "done" });
      if (kind === "packages") {
        expect((await stepOf("packages_imported")).done).toBe(true);
        expect((await stepOf("packages_reconciled")).done).toBe(false);
        await signInStaff(h.db, jar, ["settings.write"]);
        expect(await actions.signOffReconciliation({ importId: id, note: "Matches SimplyBook" })).toMatchObject({ ok: true });
        expect((await stepOf("packages_reconciled")).done).toBe(true);
      }
    }
    const steps = (await getCutoverChecklist(h.db)).steps;
    const importSteps = steps.filter((s) => s.rule.mode === "import");
    expect(importSteps.map((s) => s.key)).toEqual([
      "suppressions_imported",
      "persons_imported",
      "consents_imported",
      "tags_imported",
      "companies_imported",
      "history_imported",
      "packages_imported",
      "packages_reconciled",
      "memberships_imported",
      "future_bookings_imported",
    ]);
    expect(importSteps.every((s) => s.done && s.importId)).toBe(true);
    const stored = await h.db.select({ key: cutoverChecklistItems.key, doneAt: cutoverChecklistItems.doneAt }).from(cutoverChecklistItems);
    for (const s of importSteps) expect(stored.find((r) => r.key === s.key)?.doneAt).toBeInstanceOf(Date);
  });

  it("R53 stats_recomputed is done once a person-stats run finished after the last import", async () => {
    expect((await stepOf("stats_recomputed")).done).toBe(false);
    await h.db.insert(jobs).values({ kind: "ops.refresh_person_stats", payload: {}, idempotencyKey: "stats:test:after-import", lane: "bulk", status: "succeeded", finishedAt: new Date(Date.now() + 60_000) });
    expect((await stepOf("stats_recomputed")).done).toBe(true);
  });

  it("R53 the manual steps are ticked by hand with settings.write only; automatic steps refuse a hand tick", async () => {
    await signInStaff(h.db, jar, ["persons.write"], "reception");
    expect(await actions.setCutoverStep({ key: "invoice_issuer_settings_complete", done: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const user = await signInStaff(h.db, jar, ["settings.write"]);
    for (const key of ["invoice_issuer_settings_complete", "legal_texts_reviewed", "dpia_sensitive_processing_decided", "old_tools_frozen", "dns_switched"] as const) {
      expect(await actions.setCutoverStep({ key, done: true, note: "Checked" })).toMatchObject({ ok: true });
      expect(await stepOf(key)).toMatchObject({ done: true, note: "Checked", manual: true });
    }
    expect((await h.db.select().from(cutoverChecklistItems).where(eq(cutoverChecklistItems.key, "legal_texts_reviewed")))[0]).toMatchObject({ doneByUserId: user.id });
    for (const key of ["go_live_gate_complete", "persons_imported", "packages_reconciled", "stats_recomputed"] as const) {
      expect(await actions.setCutoverStep({ key, done: true })).toMatchObject({ ok: false, error: { code: "conflict", message: "not_manual" } });
    }
    expect(await actions.setCutoverStep({ key: "dns_switched", done: false })).toMatchObject({ ok: true });
    expect(await stepOf("dns_switched")).toMatchObject({ done: false, doneAt: null });
    expect((await getCutoverChecklist(h.db)).done).toBe(16);
  });
});
