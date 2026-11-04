/**
 * The seeded journeys of spec 3.6 (automation-P4): every seed parses and validates against its
 * templates (A-1, A-3, A-4), slugs are unique, V1 seeds are active and R2 seeds draft, the webinar
 * set is the eleven journeys of cross-module D52, `abandoned-checkout` follows D54, and every
 * template key has the right form (D1). Event data paths are checked against the event registry.
 * The database half writes the seed twice on a fresh database: the second run creates nothing and
 * never overwrites an edited journey or template.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationGroups, automations, automationVersions, emailTemplates, emailTemplateVersions, ROLE_KEYS, tags } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { definitionHash } from "@beam/db/seed/automation";
import { enrolTargets, parseDefinition, triggerKinds, validateDefinition, type DefinitionIssue, type TemplateRef, type ValidationRefs } from "@beam/core/automation";
import {
  EXTERNAL_SEED_TEMPLATES,
  SEED_AUTOMATIONS,
  SEED_GROUPS,
  SEED_TAGS,
  seedTemplates,
  type SeedAutomation,
} from "@beam/core/automation/seeds";
import { MARKETING_SLUG_PATTERN, TRANSACTIONAL_SLUG_PATTERN, validateDocument } from "@beam/core/email";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { EVENTS } from "@/registry/events.generated";
import { seedAutomation } from "../engine/seed-automations";

const bySlug = new Map(SEED_AUTOMATIONS.map((s) => [s.slug, s]));
const seed = (slug: string): SeedAutomation => {
  const s = bySlug.get(slug);
  if (!s) throw new Error(`no seed ${slug}`);
  return s;
};
const groups = new Map(SEED_GROUPS.map((g) => [g.key, g]));

/** Known `data` keys per registered event kind (edge case 22). */
function eventDataPaths(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [kind, def] of Object.entries(EVENTS as Record<string, { data?: { shape?: Record<string, unknown> } }>)) {
    if (def.data?.shape) out[kind] = Object.keys(def.data.shape);
  }
  return out;
}

const TEMPLATE_REFS: Record<string, TemplateRef> = Object.fromEntries(
  seedTemplates().map((t) => [t.slug, { kind: t.kind, purpose: t.purpose, locales: ["nl-BE", "fr-BE", "en"] }]),
);

function refsFor(s: SeedAutomation): ValidationRefs {
  return {
    automation: { slug: s.slug, isMarketing: s.isMarketing, purpose: s.purpose, isExclusiveGroup: groups.get(s.groupKey)?.isExclusive ?? false },
    templates: TEMPLATE_REFS,
    automations: Object.fromEntries(SEED_AUTOMATIONS.map((a) => [a.slug, { reEntry: a.definition.re_entry, enrolTargets: enrolTargets(a.definition) }])),
    tags: SEED_TAGS.map((t) => t.key),
    roles: [...ROLE_KEYS],
    webhookHosts: [],
    eventDataPaths: eventDataPaths(),
  };
}

/** Errors, except a missing template another module seeds (accepted for the R2 drafts, automation-P4). */
function blockingIssues(s: SeedAutomation): DefinitionIssue[] {
  return validateDefinition(s.definition, refsFor(s)).filter(
    (i) => i.severity === "error" && !(i.code === "template_unavailable" && (EXTERNAL_SEED_TEMPLATES as readonly string[]).includes(String(i.params?.template))),
  );
}

const stepsOf = (slug: string) => seed(slug).definition.steps;
const emailTemplatesOf = (slug: string) => stepsOf(slug).flatMap((st) => (st.type === "email" ? [st.template] : []));

describe("seed definitions (A-1)", () => {
  it("every seed parses with the strict schema", () => {
    for (const s of SEED_AUTOMATIONS) expect(parseDefinition(s.definition), s.slug).toMatchObject({ ok: true });
  });

  it("every seed validates against its templates, tags, roles and groups", () => {
    for (const s of SEED_AUTOMATIONS) expect(blockingIssues(s), s.slug).toEqual([]);
  });

  it("templates of other modules are referenced only by R2 drafts", () => {
    for (const s of SEED_AUTOMATIONS) {
      const external = emailTemplatesOf(s.slug).filter((t) => (EXTERNAL_SEED_TEMPLATES as readonly string[]).includes(t));
      if (external.length) expect({ slug: s.slug, release: s.release }).toEqual({ slug: s.slug, release: "R2" });
    }
  });

  it("event data paths of registered kinds exist (no unknown_event_path warning)", () => {
    for (const s of SEED_AUTOMATIONS) {
      const warnings = validateDefinition(s.definition, refsFor(s)).filter((i) => i.code === "unknown_event_path");
      expect(warnings, s.slug).toEqual([]);
    }
  });

  it("slugs are unique, groups exist and step keys are unique per seed", () => {
    expect(new Set(SEED_AUTOMATIONS.map((s) => s.slug)).size).toBe(SEED_AUTOMATIONS.length);
    for (const s of SEED_AUTOMATIONS) {
      expect(groups.has(s.groupKey), s.slug).toBe(true);
      const keys = s.definition.steps.map((st) => st.key);
      expect(new Set(keys).size, s.slug).toBe(keys.length);
    }
  });

  it("V1 seeds are active, R2 seeds are draft", () => {
    for (const s of SEED_AUTOMATIONS) expect(s.status, s.slug).toBe(s.release === "V1" ? "active" : "draft");
    const v1 = SEED_AUTOMATIONS.filter((s) => s.release === "V1").map((s) => s.slug).sort();
    expect(v1).toEqual(
      [
        "welcome-lead",
        "lead-sales-follow-up",
        "assessment-follow-up",
        "event-registration",
        "after-first-booking",
        "after-first-visit",
        "package-usage",
        "package-expiry",
        "package-finished",
        "inactivity",
        "member-welcome",
        "membership-renewal",
        "review-request",
        "waitlist-offer",
      ].sort(),
    );
    for (const slug of ["abandoned-checkout", "waitlist-follow-up", "event-follow-up"]) expect(seed(slug)).toMatchObject({ release: "R2", status: "draft" });
  });

  it("a marketing seed has a purpose, a transactional seed none", () => {
    for (const s of SEED_AUTOMATIONS) expect(s.isMarketing ? s.purpose !== null : s.purpose === null, s.slug).toBe(true);
  });

  it("no seed in an exclusive group sets a subject, and no seed triggers on automation or imported events", () => {
    for (const s of SEED_AUTOMATIONS) {
      if (groups.get(s.groupKey)!.isExclusive) expect(s.definition.subject, s.slug).toBeUndefined();
      for (const k of triggerKinds(s.definition.trigger)) {
        expect(k.startsWith("automation."), s.slug).toBe(false);
        expect(k, s.slug).not.toBe("ops.history_imported");
      }
    }
  });

  it("the seeded groups are the eleven of spec 2.2", () => {
    expect(SEED_GROUPS.map((g) => [g.key, g.isExclusive, g.lane, g.priority])).toEqual([
      ["customer_journey", true, "sales_journey", 10],
      ["webinar", true, "sales_journey", 20],
      ["waitlist", true, "sales_journey", 25],
      ["lead_nurture", true, "sales_journey", 30],
      ["package", false, null, 100],
      ["inactivity", false, null, 100],
      ["membership", false, null, 100],
      ["transactional", false, null, 100],
      ["review", false, null, 100],
      ["sales", false, null, 100],
      ["checkout", false, null, 100],
    ]);
  });
});

describe("booking R59, R60 and journey shapes", () => {
  it("no seeded definition has a confirm step and after-first-booking has no reminder step", () => {
    for (const s of SEED_AUTOMATIONS) for (const st of s.definition.steps) expect(st.key, s.slug).not.toMatch(/confirm/);
    expect(stepsOf("after-first-booking").map((st) => st.key)).toEqual(["preparation", "intake_reminder"]);
    expect(stepsOf("after-first-booking").some((st) => /reminder_|^reminder$/.test(st.key))).toBe(false);
  });

  it("event-registration reminds 7 days, 3 days and 3 hours before the anchor (decision 15)", () => {
    const steps = stepsOf("event-registration");
    expect(steps.map((st) => [st.key, st.at])).toEqual([
      ["reminder_7d", { from: "anchor", minutes: -10_080 }],
      ["reminder_3d", { from: "anchor", minutes: -4_320 }],
      ["reminder_day_of", { from: "anchor", minutes: -180 }],
    ]);
    expect(seed("event-registration").definition).toMatchObject({ anchor: "data.starts_at", subject: "ref", trigger: { event: "booking.confirmed", where: { "data.session_kind": "event" } } });
  });

  it("assessment-follow-up outranks welcome-lead in lead_nurture", () => {
    expect(seed("assessment-follow-up")).toMatchObject({ groupKey: "lead_nurture", priority: 50, isMarketing: true, purpose: "newsletter" });
    expect(seed("welcome-lead").priority).toBeGreaterThan(50);
  });

  it("abandoned-checkout is marketing (newsletter, group checkout) with both reminders on commerce.checkout_recovery", () => {
    const s = seed("abandoned-checkout");
    expect(s).toMatchObject({ isMarketing: true, purpose: "newsletter", groupKey: "checkout", requiresFlag: "ff_commerce_checkout_recovery", status: "draft" });
    const emails = s.definition.steps.filter((st) => st.type === "email");
    expect(emails.map((st) => [st.key, st.type === "email" && st.template, st.type === "email" && st.send_as])).toEqual([
      ["remind_1h", "commerce.checkout_recovery", "marketing"],
      ["remind_24h", "commerce.checkout_recovery", "marketing"],
    ]);
  });
});

describe("webinar journeys (cross-module D52)", () => {
  const webinar = SEED_AUTOMATIONS.filter((s) => s.slug.startsWith("webinar-"));
  const DPIA = ["webinar-attended", "webinar-watched-15", "webinar-watched-30", "webinar-watched-end", "webinar-replay", "webinar-on-demand", "webinar-cta-click", "webinar-cta-sales-task"];

  it("are exactly the eleven journeys, all R2 drafts", () => {
    expect(webinar.map((s) => s.slug).sort()).toEqual([...DPIA, "webinar-registration", "webinar-no-show", "webinar-poll-answer"].sort());
    for (const s of webinar) expect(s).toMatchObject({ release: "R2", status: "draft" });
  });

  it("the eight behaviour journeys require the watch_time_profiling DPIA, the other three none", () => {
    for (const s of webinar) expect(s.requiresDpia, s.slug).toBe(DPIA.includes(s.slug) ? "watch_time_profiling" : null);
  });

  it("group priorities follow D52 (deepest engagement wins)", () => {
    const pr = Object.fromEntries(webinar.filter((s) => s.groupKey === "webinar").map((s) => [s.slug, s.priority]));
    expect(pr).toEqual({
      "webinar-watched-end": 10,
      "webinar-cta-click": 15,
      "webinar-watched-30": 20,
      "webinar-watched-15": 40,
      "webinar-replay": 50,
      "webinar-on-demand": 55,
      "webinar-attended": 60,
      "webinar-no-show": 70,
    });
  });

  it("webinar-cta-click has no task step; webinar-cta-sales-task is a sales-group task journey per registration", () => {
    expect(stepsOf("webinar-cta-click").map((st) => st.type)).toEqual(["email"]);
    const s = seed("webinar-cta-sales-task");
    expect(s).toMatchObject({ groupKey: "sales", requiresDpia: "watch_time_profiling", isMarketing: false });
    expect(s.definition).toMatchObject({ subject: "ref", re_entry: "never", trigger: { event: "webinar.cta_clicked" } });
    expect("where" in s.definition.trigger).toBe(false);
    expect(s.definition.steps).toMatchObject([{ type: "task", owner_role: "sales", title: "Webinar CTA clicked: {{trigger.data.cta_key}}", unless: { has_future_booking: true } }]);
  });

  it("live journeys filter mode = live; registration reminders use webinar.reminder; no-show sends the replay", () => {
    for (const slug of ["webinar-attended", "webinar-watched-15", "webinar-watched-30", "webinar-watched-end", "webinar-cta-click", "webinar-registration"]) {
      expect(seed(slug).definition.trigger, slug).toMatchObject({ where: { mode: "live" } });
    }
    expect(emailTemplatesOf("webinar-registration")).toEqual(["webinar.reminder", "webinar.reminder", "webinar.reminder"]);
    expect(stepsOf("webinar-registration").map((st) => st.key)).toEqual(["d7", "d3", "h3"]);
    expect(emailTemplatesOf("webinar-no-show")).toEqual(["webinar.replay_available"]);
  });
});

describe("templates (cross-module D1, spec 8)", () => {
  it("every transactional key matches the dotted form, every marketing slug is kebab-case, no seed names a slash key", () => {
    for (const s of SEED_AUTOMATIONS) {
      for (const st of s.definition.steps) if (st.type === "email") expect(st.template, s.slug).not.toContain("/");
      for (const t of s.templates) {
        if (t.kind === "transactional") expect(t.slug).toMatch(TRANSACTIONAL_SLUG_PATTERN);
        else expect(t.slug).toMatch(MARKETING_SLUG_PATTERN);
        expect(t.slug).not.toContain("/");
      }
    }
    for (const t of seedTemplates()) if (t.kind === "transactional") expect(t.slug).toMatch(/^[a-z]+\.[a-z][a-z0-9_]{1,60}$/);
  });

  it("every seeded template has a valid block document and copy in the three locales", () => {
    for (const t of seedTemplates()) {
      expect(validateDocument(t.document), t.slug).toEqual({ ok: true });
      for (const l of ["nl-BE", "fr-BE", "en"] as const) {
        expect(t.subject[l]?.trim(), `${t.slug} ${l}`).toBeTruthy();
        expect(t.preheader[l]?.trim(), `${t.slug} ${l}`).toBeTruthy();
        expect(t.document.locales[l]?.length, `${t.slug} ${l}`).toBeGreaterThan(0);
      }
      expect(t.subject["nl-BE"]).not.toBe(t.subject.en);
      expect(t.subject["fr-BE"]).not.toBe(t.subject.en);
    }
  });

  it("every email step of a seed names a seeded or an owner's template", () => {
    const own = new Set(seedTemplates().map((t) => t.slug));
    for (const s of SEED_AUTOMATIONS) for (const tpl of emailTemplatesOf(s.slug)) expect(own.has(tpl) || (EXTERNAL_SEED_TEMPLATES as readonly string[]).includes(tpl), `${s.slug} ${tpl}`).toBe(true);
  });
});

describe("seedAutomation on a database", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
  });
  afterAll(async () => {
    resetRuntime();
    await h.close();
  });
  const tx = () => h.db as unknown as Tx;

  it("creates groups, tags, templates and journeys with a published version 1", async () => {
    const first = await seedAutomation(tx());
    expect(first).toEqual({ groups: SEED_GROUPS.length, automations: SEED_AUTOMATIONS.length, templates: seedTemplates().length });
    const rows = await h.db.select().from(automations);
    expect(rows).toHaveLength(SEED_AUTOMATIONS.length);
    for (const s of SEED_AUTOMATIONS) {
      const row = rows.find((r) => r.slug === s.slug)!;
      expect(row, s.slug).toMatchObject({ status: s.status, isMarketing: s.isMarketing, purpose: s.purpose, priority: s.priority, requiresDpia: s.requiresDpia, requiresFlag: s.requiresFlag, createdByUserId: null });
      expect(row.currentVersionId, s.slug).not.toBeNull();
      const [v] = await h.db.select().from(automationVersions).where(eq(automationVersions.id, row.currentVersionId!));
      expect(v, s.slug).toMatchObject({ version: 1, definitionHash: definitionHash(s.definition) });
      expect(v!.definition).toEqual(s.definition);
      expect(row.draftDefinition).toEqual(s.definition);
      expect(row.activatedAt === null, s.slug).toBe(s.status === "draft");
    }
    const tagKeys = (await h.db.select({ key: tags.key }).from(tags)).map((t) => t.key);
    for (const t of SEED_TAGS) expect(tagKeys).toContain(t.key);
    const tpl = await h.db
      .select({ slug: emailTemplates.slug, kind: emailTemplates.kind, purpose: emailTemplates.purpose, status: emailTemplates.status, locales: emailTemplateVersions.locales })
      .from(emailTemplates)
      .innerJoin(emailTemplateVersions, eq(emailTemplateVersions.id, emailTemplates.currentVersionId));
    for (const t of seedTemplates()) {
      const row = tpl.find((r) => r.slug === t.slug);
      expect(row, t.slug).toMatchObject({ kind: t.kind, purpose: t.purpose, status: "published" });
      expect([...(row!.locales as string[])].sort(), t.slug).toEqual(["en", "fr-BE", "nl-BE"]);
    }
  });

  it("reseed changes nothing and never overwrites an edited journey, group or template", async () => {
    await h.db.update(automations).set({ name: "Edited by marketing", status: "paused", pausedAt: new Date() }).where(eq(automations.slug, "welcome-lead"));
    await h.db.update(automationGroups).set({ priority: 31 }).where(eq(automationGroups.key, "lead_nurture"));
    await h.db.update(emailTemplates).set({ name: "Edited template" }).where(eq(emailTemplates.slug, "welcome-lead-welcome"));
    const versionsBefore = (await h.db.select().from(automationVersions)).length;
    expect(await seedAutomation(tx())).toEqual({ groups: 0, automations: 0, templates: 0 });
    expect((await h.db.select().from(automationVersions)).length).toBe(versionsBefore);
    const [a] = await h.db.select().from(automations).where(eq(automations.slug, "welcome-lead"));
    expect(a).toMatchObject({ name: "Edited by marketing", status: "paused" });
    const [g] = await h.db.select().from(automationGroups).where(eq(automationGroups.key, "lead_nurture"));
    expect(g!.priority).toBe(31);
    const [t] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.slug, "welcome-lead-welcome"));
    expect(t!.name).toBe("Edited template");
  });

  it("a third run keeps every journey row (same ids)", async () => {
    const before = await h.db.select({ id: automations.id, slug: automations.slug }).from(automations);
    expect(before.length).toBe(SEED_AUTOMATIONS.length);
    expect(await seedAutomation(tx())).toEqual({ groups: 0, automations: 0, templates: 0 });
    const after = await h.db.select({ id: automations.id, slug: automations.slug }).from(automations);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });
});
