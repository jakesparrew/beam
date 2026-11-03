import { describe, expect, it } from "vitest";
import { SENSITIVE_FIELD_KEYS } from "../privacy/sensitive-keys";
import { AI_ALLOWED_FIELDS, aiContextFields, aiContextJson, toAiContext, type AiProfileInput } from "./context";

/** Scenario 6: a person with every sensitive key filled and a free-text health note. */
const SENSITIVE_VALUES = {
  health_note: "Herniated disc L4-L5, avoid deep flexion",
  sleep: "Sleeps 4 hours, insomnia since spring",
  stress: "Burn-out leave since March",
  recovery: "Knee surgery recovery week 6",
  wellbeing: "Feels anxious before group classes",
  medical: "Takes beta blockers, heart rhythm disorder",
};

const profile: AiProfileInput = {
  id: "8b0c6c0e-3b9f-4c62-9a4f-2a3f8f0f5c11",
  first_name: "Lotte",
  last_name: "Peeters",
  email: "lotte.peeters@example.com",
  phone: "+32470000000",
  notes: "Called about her shoulder pain and medication",
  locale: "nl-BE",
  status: "customer",
  is_member: true,
  b2c_stage: "active",
  tags: ["yoga", { name: "early-bird" }],
  acquisition: { source: "website", medium: "portal_signup" },
  first_visit_at: new Date("2026-01-10T09:00:00Z"),
  last_visit_at: "2026-10-30T17:00:00Z",
  visits: 41,
  purchases: 3,
  revenue_cents: 45000,
  credits_remaining: 7,
  grant_expires_at: null,
  next_booking_at: "2026-11-05T08:00:00Z",
  open_tasks: 1,
  granted_purposes: ["newsletter"],
  ...SENSITIVE_VALUES,
  sensitive: SENSITIVE_VALUES,
  answers: [{ field_key: "health_note", value: SENSITIVE_VALUES.health_note }],
};

describe("toAiContext", () => {
  it("scenario 6: no sensitive value, no free text and no contact data reaches the context or its JSON", () => {
    const context = toAiContext(profile);
    const json = aiContextJson(context);
    for (const value of Object.values(SENSITIVE_VALUES)) expect(json).not.toContain(value);
    for (const key of SENSITIVE_FIELD_KEYS) expect(Object.keys(context)).not.toContain(key);
    for (const forbidden of ["lotte.peeters@example.com", "+32470000000", "Peeters", "shoulder", "medication"]) {
      expect(json).not.toContain(forbidden);
    }
    expect(JSON.stringify(context)).not.toMatch(/disc|insomnia|burn-out|surgery|anxious|beta blockers/i);
  });

  it("keeps the allow-listed fields, normalised", () => {
    const context = toAiContext(profile);
    expect(context).toEqual({
      first_name: "Lotte",
      locale: "nl-BE",
      status: "customer",
      is_member: true,
      b2c_stage: "active",
      tags: ["yoga", "early-bird"],
      "acquisition.source": "website",
      first_visit_at: "2026-01-10T09:00:00.000Z",
      last_visit_at: "2026-10-30T17:00:00.000Z",
      visits: 41,
      purchases: 3,
      revenue_cents: 45000,
      credits_remaining: 7,
      grant_expires_at: null,
      next_booking_at: "2026-11-05T08:00:00.000Z",
      open_tasks: 1,
      granted_purposes: ["newsletter"],
    });
    expect(aiContextFields(context)).not.toContain("membership_period_end_at");
  });

  it("reads camelCase rows as Drizzle returns them", () => {
    const context = toAiContext({ firstName: "Jan", isMember: false, revenueCents: 100, healthNote: "x" });
    expect(context).toEqual({ first_name: "Jan", is_member: false, revenue_cents: 100 });
  });

  it("restricts to the requested fields and rejects wrongly typed values", () => {
    expect(toAiContext(profile, ["first_name", "locale"])).toEqual({ first_name: "Lotte", locale: "nl-BE" });
    expect(toAiContext({ visits: "41", is_member: "yes", tags: "yoga" } as unknown as AiProfileInput)).toEqual({ visits: null, is_member: null, tags: null });
  });

  it("AI_ALLOWED_FIELDS holds no SENSITIVE_FIELD_KEYS member", () => {
    for (const key of SENSITIVE_FIELD_KEYS) {
      expect(AI_ALLOWED_FIELDS as readonly string[]).not.toContain(key);
      expect(AI_ALLOWED_FIELDS.some((f) => f.split(".").includes(key))).toBe(false);
    }
    for (const contact of ["email", "phone", "notes", "last_name"]) expect(AI_ALLOWED_FIELDS as readonly string[]).not.toContain(contact);
  });
});
