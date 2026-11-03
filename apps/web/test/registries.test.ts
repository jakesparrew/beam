/**
 * Registry invariants (architecture section 11 test strategy item 4, platform-P7). Reads every
 * module facade directly, so a key declared twice is caught even where the generated record
 * would silently keep one of them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { MODULE_IDS } from "@beam/config";
import { AI_ALLOWED_FIELDS } from "@beam/core/ai";
import { SEGMENT_ALLOWED_FIELDS } from "@beam/core/crm";
import { SENSITIVE_FIELD_KEYS } from "@beam/core/privacy";
import { FLAGS } from "@/registry/flags.generated";
import { JOB_BY_KIND } from "@/registry/jobs.generated";
import { NAV } from "@/registry/nav.generated";
import { PERMISSIONS } from "@/registry/permissions.generated";
import { SCHEDULES } from "@/registry/schedules.generated";
import { SETTINGS } from "@/registry/settings.generated";

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../modules");

type Facades = Record<string, Record<string, unknown>>;
const facades: Record<string, Facades> = {};

/** `export name` of every module's `<file>.ts`, keyed by module. */
async function load(file: string): Promise<Facades> {
  const out: Facades = {};
  for (const m of MODULE_IDS) {
    if (!fs.existsSync(path.join(modulesDir, m, `${file}.ts`))) continue;
    out[m] = (await import(`../modules/${m}/${file}.ts`)) as Record<string, unknown>;
  }
  return out;
}

const listOf = (file: string, exportName: string): unknown[] =>
  Object.values(facades[file] ?? {}).flatMap((mod) => (Array.isArray(mod[exportName]) ? (mod[exportName] as unknown[]) : []));
const keysOf = (file: string, exportName: string, prop: string): string[] =>
  listOf(file, exportName).map((e) => String((e as Record<string, unknown>)[prop]));
const isFlagKey = (k: string) => /^ff_[a-z]+_[a-z0-9_]+$/.test(k);
const duplicates = (xs: readonly string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

beforeAll(async () => {
  for (const file of ["jobs", "schedules", "events", "permissions", "nav", "config", "privacy", "seed"]) facades[file] = await load(file);
}, 60_000);

/** Architecture section 4 (02-data-model 5.3): exactly these permissions exist. */
const ARCHITECTURE_PERMISSIONS = [
  "persons.read", "persons.write", "persons.merge", "persons.sensitive_read", "persons.export", "persons.erase",
  "bookings.read", "bookings.write", "bookings.override", "waitlist.manage",
  "commerce.sell", "commerce.refund", "pricing.write",
  "credits.read", "credits.adjust", "memberships.write", "referrals.manage",
  "invoices.read", "invoices.issue",
  "forms.write", "forms.publish",
  "email.write", "email.send", "campaigns.send",
  "automations.write", "automations.publish", "automations.move_person",
  "crm.b2b", "tasks.all",
  "reports.read", "reports.finance", "dashboards.manage",
  "site.edit", "site.publish", "webinars.host",
  "settings.write", "users.manage", "flags.manage", "system.jobs", "privacy.run", "ai.use", "partner.own",
];

/** 02-data-model 5.4: every settings key and its owner. */
const SETTINGS_REGISTER: Record<string, string> = {
  ai: "platform", last_tick_at: "platform", company: "platform", go_live_gate: "platform", security: "platform", support: "platform",
  booking_rules: "booking", business_hours: "booking",
  commerce: "commerce", payment_provider_by_channel: "commerce",
  credits: "credits", referrals: "credits",
  finance: "finance",
  email_footer: "email", warmup_schedule: "email", email_config: "email", email_brand: "email",
  automation_cursor: "automation", automation_rules: "automation",
  retention_defaults: "ops", ads: "ops",
  site: "site",
  inbox: "crm",
};

/** 02-data-model 5.5: every flag and its owner; no other flag exists. */
const FLAG_REGISTER: Record<string, string> = {
  ff_booking_lead_priority: "booking", ff_booking_ticket_types: "booking",
  ff_commerce_checkout_recovery: "commerce",
  ff_crm_pipeline: "crm", ff_crm_inbox: "crm", ff_crm_inbox_meta: "crm",
  ff_forms_portal_results: "forms",
  ff_ops_retention: "ops", ff_ops_marketing: "ops", ff_ops_ai: "ops",
  ff_webinar_portal: "webinar",
};

describe("registries", () => {
  it("every module folder exists with every facade file", () => {
    const files = ["actions", "queries", "api", "jobs", "schedules", "events", "permissions", "nav", "privacy", "config", "seed"];
    for (const m of MODULE_IDS) {
      for (const f of files) {
        if (m === "platform" && (f === "actions" || f === "queries" || f === "seed")) continue; // platform-P6's files
        expect(fs.existsSync(path.join(modulesDir, m, `${f}.ts`)), `${m}/${f}.ts`).toBe(true);
      }
    }
  });

  it("job kinds are unique and match the naming rule", () => {
    const kinds = keysOf("jobs", "jobs", "kind");
    expect(duplicates(kinds)).toEqual([]);
    for (const k of kinds) expect(k).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(Object.keys(JOB_BY_KIND).sort()).toEqual([...kinds].sort());
    expect(kinds).toContain("email.send");
  });

  it("event kinds are unique", () => {
    const kinds = keysOf("events", "events", "kind");
    expect(duplicates(kinds)).toEqual([]);
    for (const k of kinds) expect(k).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it("permissions are unique and exactly the architecture list", () => {
    const declared = listOf("permissions", "permissions").map(String);
    expect(duplicates(declared)).toEqual([]);
    expect([...declared].sort()).toEqual([...ARCHITECTURE_PERMISSIONS].sort());
    expect([...PERMISSIONS].sort()).toEqual([...ARCHITECTURE_PERMISSIONS].sort());
  });

  it("schedule kinds are unique and every schedule kind has a job", () => {
    const kinds = keysOf("schedules", "schedules", "kind");
    expect(duplicates(kinds)).toEqual([]);
    for (const s of SCHEDULES) expect(JOB_BY_KIND, `job for schedule ${s.kind}`).toHaveProperty([s.kind]);
  });

  it("flag keys are unique, well formed and exactly the flag catalogue", () => {
    const keys = keysOf("config", "flags", "key");
    expect(duplicates(keys)).toEqual([]);
    for (const k of keys) expect(isFlagKey(k), k).toBe(true);
    expect(Object.fromEntries(Object.entries(FLAGS).map(([k, v]) => [k, v.owner]))).toEqual(FLAG_REGISTER);
  });

  it("settings keys are unique, snake_case and exactly the settings register", () => {
    const keys = keysOf("config", "settings", "key");
    expect(duplicates(keys)).toEqual([]);
    for (const k of keys) expect(k).toMatch(/^[a-z_]+$/);
    expect(Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.owner]))).toEqual(SETTINGS_REGISTER);
  });

  it("every settings default passes its own schema; finance carries no enterprise_number or website", () => {
    for (const [key, def] of Object.entries(SETTINGS)) {
      const parsed = def.schema.safeParse(def.default);
      expect(parsed.success, `default of ${key}`).toBe(true);
    }
    const finance = SETTINGS.finance.default as Record<string, unknown> & { issuer: Record<string, unknown> };
    for (const field of ["enterprise_number", "website"]) {
      expect(finance).not.toHaveProperty(field);
      expect(finance.issuer).not.toHaveProperty(field);
    }
  });

  it("every nav entry's permission exists", () => {
    const all = [...NAV.admin, ...NAV.portal, ...listOf("nav", "nav")] as { key: string; permission?: string }[];
    for (const item of all) if (item.permission) expect(PERMISSIONS as readonly string[], item.key).toContain(item.permission);
  });

  it("every module registers privacy and a demo seed", () => {
    for (const m of MODULE_IDS) {
      if (m === "platform") continue;
      const p = facades.privacy?.[m]?.privacy as { tables?: unknown; export?: unknown; erase?: unknown } | undefined;
      expect(Array.isArray(p?.tables), `${m} privacy.tables`).toBe(true);
      expect(typeof p?.export).toBe("function");
      expect(typeof p?.erase).toBe("function");
      const s = facades.seed?.[m]?.seed as { run?: unknown } | undefined;
      expect(typeof s?.run, `${m} seed.run`).toBe("function");
    }
  });

  it("no sensitive field key is in AI_ALLOWED_FIELDS or SEGMENT_ALLOWED_FIELDS", () => {
    const sensitive = new Set<string>(SENSITIVE_FIELD_KEYS);
    const last = (f: string) => f.split(".").pop() ?? f;
    for (const f of AI_ALLOWED_FIELDS) expect(sensitive.has(f) || sensitive.has(last(f)), `AI field ${f}`).toBe(false);
    for (const f of SEGMENT_ALLOWED_FIELDS) expect(sensitive.has(f) || sensitive.has(last(f)), `segment field ${f}`).toBe(false);
    expect(SEGMENT_ALLOWED_FIELDS.length).toBeGreaterThan(0);
  });
});
