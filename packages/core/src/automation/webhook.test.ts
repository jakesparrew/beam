import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWebhookPayload, checkWebhookUrl, pickWebhookPerson, WEBHOOK_ALLOWED_FIELDS, webhookIdempotencyKey } from "./webhook";

/**
 * `SENSITIVE_COLUMNS` is filled by `sensitive(<column with an explicit SQL name>, ...)` in the
 * schema files of `@beam/db`, which `@beam/core` may not import at runtime. The test reads those
 * declarations from the schema sources instead (the db package test checks the live list too).
 */
function sensitiveColumnNames(): string[] {
  const dir = path.resolve(import.meta.dirname, "../../../db/src/schema");
  const names = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
    const src = readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/sensitive\(\s*[a-zA-Z]+\(\s*"([a-z0-9_]+)"/g)) names.add(m[1]!);
  }
  return [...names];
}

describe("WEBHOOK_ALLOWED_FIELDS (section 6)", () => {
  it("contains no SENSITIVE_COLUMNS member", () => {
    const sensitive = sensitiveColumnNames();
    expect(sensitive.length).toBeGreaterThan(0);
    for (const f of WEBHOOK_ALLOWED_FIELDS) expect(sensitive).not.toContain(f);
  });

  it("contains no email and no phone", () => {
    expect(WEBHOOK_ALLOWED_FIELDS).toEqual(["id", "first_name", "locale", "status", "tags"]);
    for (const f of WEBHOOK_ALLOWED_FIELDS) expect(f).not.toMatch(/mail|phone|address|birth|last_name/);
  });

  it("the payload drops every other person field", () => {
    const payload = buildWebhookPayload({
      automationSlug: "welcome-lead",
      stepKey: "hook",
      enrolmentId: "en-1",
      person: { id: "p1", first_name: "An", locale: "nl-BE", status: "lead", tags: ["engaged"], email: "an@example.com", phone: "+32470000000" },
      occurredAt: new Date("2026-11-04T12:00:00Z"),
    });
    expect(payload).toEqual({
      event: "automation.step",
      automation: "welcome-lead",
      step_key: "hook",
      enrolment_id: "en-1",
      person: { id: "p1", first_name: "An", locale: "nl-BE", status: "lead", tags: ["engaged"] },
      occurred_at: "2026-11-04T12:00:00.000Z",
    });
    expect(JSON.stringify(payload)).not.toMatch(/example\.com|\+32/);
    expect(pickWebhookPerson({ id: "p2", locale: "en", status: "member" })).toEqual({ id: "p2", first_name: null, locale: "en", status: "member", tags: [] });
  });

  it("keys and URL checks", () => {
    expect(webhookIdempotencyKey("en-1", "hook")).toBe("automation_webhook:en-1:hook");
    expect(checkWebhookUrl("https://hooks.example.com/x", ["hooks.example.com"])).toEqual({ https: true, allowed: true });
    expect(checkWebhookUrl("https://hooks.example.com/x", [])).toEqual({ https: true, allowed: false });
    expect(checkWebhookUrl("ftp://hooks.example.com/x", ["hooks.example.com"])).toEqual({ https: false, allowed: false });
  });
});
