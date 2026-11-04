import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { retentionPolicies } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { insertRetentionPolicies } from "@beam/db/seed/ops";
import { createTestDb } from "@beam/db/testing";
import { asc } from "@/lib/ctx";
import { GDPR_REGISTRY } from "@/registry/privacy.generated";
import { declaredRetentionSeeds } from "../seed";
import { GENERIC_SWEEP_TABLES } from "./generic-sweep";
import { ACCOUNTING_KEYS, resolveSweepHandler } from "./jobs";

let h: DbHandle;
let policies: (typeof retentionPolicies.$inferSelect)[];
beforeAll(async () => {
  h = await createTestDb();
  // every module's defaults seed, then the retention rows modules declare in privacy.ts (ops seed path a)
  await seedDefaults(h.db);
  await insertRetentionPolicies(h.db, declaredRetentionSeeds());
  policies = await h.db.select().from(retentionPolicies).orderBy(asc(retentionPolicies.runOrder), asc(retentionPolicies.key));
}, 120_000);
afterAll(() => h.close());

const byKey = (key: string) => policies.find((p) => p.key === key);

/**
 * Keys seeded today whose owner's `sweep[key]` handler arrives with a later package (the sweep
 * records `no_handler` for them until then, edge case 17). The ownership rule still applies to
 * them: the prefix names a registered module. Once a handler exists the key leaves this list
 * by itself (the assertion only accepts a listed key while its handler is missing).
 */
const HANDLER_PENDING: Readonly<Record<string, string>> = {
  "forms.form_sensitive_answers": "forms (privacy sweep handlers)",
  "forms.form_submissions": "forms",
  "forms.form_submissions_anonymous_abandoned": "forms",
  "forms.form_sensitive_answers_unlinked": "forms",
  "forms.form_submissions_ip_hash": "forms",
  "forms.form_import_events": "forms",
  "forms.form_views_daily": "forms",
  "finance.invoices": "finance (privacy sweep handlers)",
  "finance.invoice_requests": "finance",
  "finance.billit_reconcile_runs": "finance",
  "finance.finance_exports": "finance",
  "webinar.watch_segments": "webinar (R2)",
  "webinar.webinar_interactions": "webinar (R2)",
  "webinar.webinar_registrations": "webinar (R2)",
  "booking.waitlist_entries": "booking (privacy sweep handlers)",
  "booking.bookings_free_text": "booking",
  "crm.inbox_resolved": "crm (R3 inbox)",
};

describe("retention coverage (ops spec 9, blueprint 63)", () => {
  it("every blueprint 63 key exists after all seeds ran", () => {
    for (const key of [
      "ops.marketing_profile",
      "ops.marketing_contact",
      "crm.suppressions",
      "booking.bookings_free_text",
      "finance.invoices",
      "webinar.webinar_registrations",
      "webinar.webinar_interactions",
      "webinar.watch_segments",
      "forms.form_sensitive_answers",
      "forms.form_submissions",
      "booking.waitlist_entries",
      "platform.ai_requests",
      "platform.audit_log",
    ]) {
      expect(byKey(key), key).toBeDefined();
    }
  });

  it("ownership (cross-module decision 37): every key is <m>.<name> of a registered module with a sweep handler, a keep policy or a generic table", () => {
    const modules = Object.keys(GDPR_REGISTRY);
    const unowned: string[] = [];
    for (const p of policies) {
      expect(p.key, p.key).toMatch(/^[a-z]+\.[a-z][a-z0-9_]*$/);
      expect(modules, p.key).toContain(p.key.split(".")[0]);
      if (p.action === "keep") continue;
      if (Object.prototype.hasOwnProperty.call(GENERIC_SWEEP_TABLES, p.tableName)) continue;
      if (resolveSweepHandler(p).kind === "module") continue;
      if (HANDLER_PENDING[p.key]) continue;
      unowned.push(p.key);
    }
    expect(unowned).toEqual([]);
    for (const key of ["marketing_profile", "invoices", "audit_log", "crm.inactive_profile"]) expect(byKey(key), key).toBeUndefined();
  });

  it("ops' own keys run through ops' handlers", () => {
    for (const p of policies.filter((x) => x.key.startsWith("ops."))) expect(resolveSweepHandler(p).kind, p.key).toBe("module");
  });

  it("seeds the webinar, finance, crm, forms and site keys with their days and order", () => {
    for (const key of ["webinar.watch_segments", "webinar.webinar_interactions", "webinar.webinar_registrations"]) expect(byKey(key), key).toBeDefined();
    for (const key of ["finance.invoices", "finance.invoice_requests", "finance.billit_reconcile_runs", "finance.finance_exports"]) expect(byKey(key), key).toBeDefined();
    expect(byKey("crm.declarations_superseded")).toBeDefined();
    const forms = policies.filter((p) => p.key.startsWith("forms.") && p.runOrder >= 31 && p.runOrder <= 35);
    expect(forms).toHaveLength(5);
    for (const key of ["site.cookie_consents", "site.terms_acceptances", "site.page_edit_requests"]) expect(byKey(key), key).toBeDefined();
    expect(byKey("crm.inactive_profile")).toBeUndefined();
    expect(byKey("finance.invoices")).toMatchObject({ days: 3653, action: "anonymise" });
  });

  it("accounting-linked keys (cross-module decision 34) are 3653 days", () => {
    for (const key of ["finance.invoices", "commerce.orders", "credits.ledger", "credits.memberships", "site.terms_acceptances"]) {
      expect(byKey(key), key).toBeDefined();
    }
    for (const key of ACCOUNTING_KEYS) {
      const p = byKey(key);
      if (p) expect(p.days, key).toBe(3653);
    }
  });
});
