/**
 * ops-P1: the module skeleton. Every api function keeps its final name (the area packages
 * replace the stubs), every job kind is registered once with an input schema, the facades point at
 * catalogue keys that exist in all three locales, and the demo seed inserts every module's
 * declared retention rows once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { retentionPolicies } from "@beam/db/schema";
import { ERASE_ORDER as CORE_ERASE_ORDER, RETENTION_DEFAULTS, RetentionDefaults } from "@beam/core/ops";
import en from "@beam/core/i18n/messages/en/ops.json";
import fr from "@beam/core/i18n/messages/fr-BE/ops.json";
import nl from "@beam/core/i18n/messages/nl-BE/ops.json";
import { OPS_RETENTION_POLICIES } from "@beam/db/seed/ops";
import { eq } from "@/lib/ctx";
import * as api from "./api";
import { flags, settings } from "./config";
import { events } from "./events";
import { jobs } from "./jobs";
import { nav } from "./nav";
import { permissions } from "./permissions";
import { PLANNED_SCHEDULES, schedules } from "./schedules";
import { declaredRetentionSeeds, runOpsDemoSeed, seed } from "./seed";

type Tree = { [k: string]: string | Tree };
function has(tree: Tree, key: string): boolean {
  let node: string | Tree | undefined = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = node[part];
  }
  return typeof node === "string" && node.length > 0;
}
const catalogues: [string, Tree][] = [
  ["en", en],
  ["nl-BE", nl],
  ["fr-BE", fr],
];

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

describe("api.ts (ops spec 4.7)", () => {
  it("exports every V1 function", () => {
    for (const fn of [
      "getPersonStats",
      "refreshPersonStats",
      "requestStatsRefresh",
      "isProcessingRestricted",
      "listRetentionReasons",
      "createPrivacyRequest",
      "getOpenPrivacyRequests",
      "isDpiaApproved",
    ] as const) {
      expect(typeof api[fn], fn).toBe("function");
    }
  });

  it("re-exports ERASE_ORDER from @beam/core/ops", () => {
    expect(api.ERASE_ORDER).toBe(CORE_ERASE_ORDER);
  });
});

describe("jobs.ts and schedules.ts", () => {
  it("registers every job kind of spec 4.4 once", () => {
    const kinds = jobs.map((j) => j.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect([...kinds].sort()).toEqual(
      [
        "ops.refresh_person_stats",
        "ops.refresh_recent_stats",
        "ops.refresh_person",
        "ops.daily_digest",
        "ops.build_weekly_retention_list",
        "import.parse",
        "import.process_chunk",
        "import.finalise",
        "ops.export_chunk",
        "ops.export_finalise",
        "privacy.export",
        "privacy.erase",
        "privacy.erase_external",
        "privacy.erase_step",
        "privacy.finalise",
        "privacy.retention_sweep",
        "ads.pull_yesterday",
        "ads.backfill",
        "ops.compute_attribution",
        "ai.weekly_summary",
        "ai.weekly_summary_collect",
        "ai.answer_question",
      ].sort(),
    );
    expect(jobs.find((j) => j.kind === "ai.answer_question")!.inline).toBe(true);
    expect(jobs.filter((j) => j.kind.startsWith("privacy.erase")).every((j) => j.lane === "fast" && j.priority === 1)).toBe(true);
  });

  it("gives every job an input schema that parses its sample payload", () => {
    const samples: Record<string, unknown> = {
      "ops.refresh_person": { personId: "00000000-0000-4000-8000-000000000001" },
      "import.parse": { importId: "00000000-0000-4000-8000-000000000001", runSeq: 1 },
      "import.process_chunk": { importId: "00000000-0000-4000-8000-000000000001", runSeq: 1, mode: "dry", offset: 0 },
      "import.finalise": { importId: "00000000-0000-4000-8000-000000000001", runSeq: 1, mode: "run" },
      "ops.export_chunk": { exportId: "00000000-0000-4000-8000-000000000001", entity: "persons", offset: 0 },
      "ops.export_finalise": { exportId: "00000000-0000-4000-8000-000000000001" },
      "privacy.export": { requestId: "00000000-0000-4000-8000-000000000001" },
      "privacy.erase": { requestId: "00000000-0000-4000-8000-000000000001" },
      "privacy.erase_external": { requestId: "00000000-0000-4000-8000-000000000001", provider: "resend" },
      "privacy.erase_step": { requestId: "00000000-0000-4000-8000-000000000001", module: "webinar" },
      "privacy.finalise": { requestId: "00000000-0000-4000-8000-000000000001" },
      "ads.backfill": { platform: "meta", accountId: "act_1", from: "2026-10-01", to: "2026-10-31" },
      "ai.weekly_summary_collect": { weekStartOn: "2026-11-02", batchId: "batch_1", n: 0 },
      "ai.answer_question": { questionId: "00000000-0000-4000-8000-000000000001" },
    };
    for (const j of jobs) {
      expect(j.input.safeParse(samples[j.kind] ?? {}).success, j.kind).toBe(true);
      expect(typeof j.run, j.kind).toBe("function");
    }
  });

  it("registers the eight schedules of spec 4.5; every scheduled kind has a job", () => {
    expect(PLANNED_SCHEDULES).toBe(schedules);
    expect(schedules.map((s) => `${s.kind} ${s.cron}`).sort()).toEqual(
      [
        "privacy.retention_sweep 0 1 * * *",
        "ops.refresh_person_stats 0 4 * * *",
        "ops.refresh_recent_stats */5 * * * *",
        "ops.daily_digest 0 8 * * *",
        "ops.build_weekly_retention_list 10 6 * * 1",
        "ads.pull_yesterday 30 5 * * *",
        "ops.compute_attribution 50 5 * * *",
        "ai.weekly_summary 30 6 * * 1",
      ].sort(),
    );
    const kinds = new Set<string>(jobs.map((j) => j.kind));
    for (const s of schedules) expect(kinds.has(s.kind), s.kind).toBe(true);
    expect(schedules.find((s) => s.kind === "ops.refresh_recent_stats")!.catchUp).toBe(false);
  });
});

describe("events, nav, permissions, config", () => {
  it("declares the ten event kinds of spec 4.6 with subject person", () => {
    expect(events.map((e) => e.kind).sort()).toEqual(
      [
        "person.inactive_days",
        "ops.stage_changed",
        "ops.history_imported",
        "privacy.requested",
        "privacy.verified",
        "privacy.cancelled",
        "privacy.restricted",
        "privacy.restriction_lifted",
        "privacy.objected",
        "privacy.exported",
      ].sort(),
    );
    expect(events.every((e) => e.subject === "person")).toBe(true);
    const inactive = events.find((e) => e.kind === "person.inactive_days")!;
    expect(inactive.data.safeParse({ days: 60, anchor_at: new Date("2026-01-01T10:00:00Z"), has_future_booking: false }).success).toBe(true);
    expect(inactive.data.safeParse({ days: 45, anchor_at: new Date(), has_future_booking: false }).success).toBe(false);
  });

  it("declares the ops permissions with a description in every locale", () => {
    expect([...permissions].sort()).toEqual(["dashboards.manage", "privacy.run", "reports.finance", "reports.read"]);
    for (const [loc, cat] of catalogues) for (const p of permissions) expect(has(cat, `ops.permissions.${p.replace(".", "_")}`), `${loc} ${p}`).toBe(true);
  });

  it("gives every nav entry a label in every locale, a release flag of ops where it has one, and unique keys", () => {
    const keys = nav.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
    const flagKeys = new Set<string>(flags.map((f) => f.key));
    for (const n of nav) {
      for (const [loc, cat] of catalogues) expect(has(cat, n.labelKey), `${loc} ${n.labelKey}`).toBe(true);
      if ("flag" in n) expect(flagKeys.has(n.flag), n.key).toBe(true);
    }
    expect(nav.filter((n) => n.area === "admin").map((n) => n.href)).toContain("/admin/dashboard");
  });

  it("declares retention_defaults with the spec 2.4 thresholds and the ads accounts", () => {
    const rd = settings.find((s) => s.key === "retention_defaults")!;
    expect(rd.default).toEqual(RETENTION_DEFAULTS);
    expect(RetentionDefaults.safeParse(rd.default).success).toBe(true);
    expect(rd.schema.safeParse({ ...RETENTION_DEFAULTS, weekly_list_size: 0 }).success).toBe(false);
    const ads = settings.find((s) => s.key === "ads")!;
    expect(ads.schema.safeParse(ads.default).success).toBe(true);
  });

  it("has a catalogue label for every retention policy ops seeds and every card, stage and reason", () => {
    for (const [loc, cat] of catalogues) {
      for (const p of OPS_RETENTION_POLICIES) expect(has(cat, `ops.retention_policy.${p.key.replace(".", "_")}`), `${loc} ${p.key}`).toBe(true);
      for (const s of ["lead", "engaged_lead", "experienced", "first_visit", "first_purchase", "active", "repeat", "member", "retention", "lost"]) {
        expect(has(cat, `ops.stage.${s}`), `${loc} stage ${s}`).toBe(true);
      }
      expect(has(cat, "ops.privacy.portal.erase_confirm_word")).toBe(true);
    }
    const word = (cat: Tree) => ((cat.ops as Tree).privacy as Tree).portal as Tree;
    expect([word(en as Tree).erase_confirm_word, word(nl as Tree).erase_confirm_word, word(fr as Tree).erase_confirm_word]).toEqual(["DELETE", "VERWIJDER", "SUPPRIMER"]);
  });
});

describe("seed.ts (demo)", () => {
  it("runs after automation", () => {
    expect(seed.after).toEqual(["automation"]);
  });

  it("collects every module's declared retention rows", () => {
    const rows = declaredRetentionSeeds({
      zeta: { tables: [], export: () => Promise.resolve({}), erase: () => Promise.resolve([]), retention: [{ key: "zeta.b", tableName: "b", days: 30, action: "delete", description: "b" }] },
      alpha: { tables: [], export: () => Promise.resolve({}), erase: () => Promise.resolve([]), retention: [{ key: "alpha.a", tableName: "a", days: null, action: "keep", description: "a" }] },
      none: { tables: [], export: () => Promise.resolve({}), erase: () => Promise.resolve([]) },
    });
    expect(rows.map((r) => r.key)).toEqual(["alpha.a", "zeta.b"]);
  });

  it("inserts the declared rows once and keeps a staff edit", async () => {
    const declared = declaredRetentionSeeds();
    const first = await runOpsDemoSeed({ db: h.db });
    expect(first.policies).toBe(declared.length);
    for (const d of declared) {
      const [row] = await h.db.select().from(retentionPolicies).where(eq(retentionPolicies.key, d.key));
      expect(row, d.key).toBeDefined();
    }
    if (declared[0]) {
      await h.db.update(retentionPolicies).set({ isActive: false }).where(eq(retentionPolicies.key, declared[0].key));
      await runOpsDemoSeed({ db: h.db });
      const [row] = await h.db.select().from(retentionPolicies).where(eq(retentionPolicies.key, declared[0].key));
      expect(row!.isActive).toBe(false);
    }
    const all = await h.db.select().from(retentionPolicies);
    expect(all).toHaveLength(declared.length);
  });
});
