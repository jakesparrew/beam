/**
 * forms-P3 test fixtures (imported by the forms-P3 test files only): published test forms
 * inserted directly (no DPIA call), public contexts, and a start -> submit helper.
 */
import type { Db } from "@beam/db";
import { forms, formVersions } from "@beam/db/schema";
import { recoveryCheckSeed, seedDefinitions, type Field, type FormDefinition, type FormKind, type FormScoring } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { eq, type Actor, type Ctx } from "@/lib/ctx";
import { makeCtx } from "@/lib/testing";
import { versionValues } from "./service/versions";

export const KEY1 = Buffer.alloc(32, 7).toString("base64");

/** Secrets the token and encryption code needs (fixed test values, no real keys). */
export function setupEnv(): void {
  process.env.AUTH_SECRET = "forms-p3-test-secret";
  process.env.SENSITIVE_DATA_KEY_V1 = KEY1;
  process.env.APP_URL = "https://app.example.com";
}

export const T = (en: string) => ({ "nl-BE": `${en} (nl)`, "fr-BE": `${en} (fr)`, en });

let n = 0;
export const uniqueSlug = (base: string): string => `${base}-${Date.now().toString(36)}-${++n}`;

const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x)) as X;

/** The demo assessment with an optional birth date field in the first section (C5 cases). */
export function assessment(): { definition: FormDefinition; scoring: FormScoring; kind: FormKind; locales: Locale[] } {
  const s = recoveryCheckSeed({ baseUrl: "https://www.example.com" });
  const def = clone(s.definition);
  const birth: Field = { key: "birth_on", type: "date", label: T("Birth date"), required: false, sensitive: false, mapsTo: "person.birth_on" };
  def.fields.birth_on = birth;
  def.sections[0]!.fieldKeys.splice(2, 0, "birth_on");
  return { definition: def, scoring: clone(s.scoring), kind: "assessment", locales: s.locales };
}

/** A lead form: email, names, phone, birth date, optional newsletter; thank-you ending. */
export function lead(over: Partial<FormDefinition["settings"]> = {}): { definition: FormDefinition; scoring: FormScoring; kind: FormKind; locales: Locale[] } {
  const c = clone(seedDefinitions().contact);
  const def = c.definition;
  def.fields.last_name = { key: "last_name", type: "short_text", label: T("Last name"), required: false, sensitive: false, mapsTo: "person.last_name" };
  def.fields.phone = { key: "phone", type: "phone", label: T("Phone"), required: false, sensitive: false, mapsTo: "person.phone" };
  def.fields.birth_on = { key: "birth_on", type: "date", label: T("Birth date"), required: false, sensitive: false, mapsTo: "person.birth_on" };
  def.fields.message = { ...def.fields.message!, required: false };
  def.sections[0]!.fieldKeys = ["email", "first_name", "last_name", "phone", "birth_on", "message", "newsletter"];
  def.settings = { ...def.settings, ...over };
  return { definition: def, scoring: c.scoring, kind: "lead", locales: c.locales };
}

/** An intake form with staff entry allowed and a 365-day validity (the health declaration). */
export function intake(): { definition: FormDefinition; scoring: FormScoring; kind: FormKind; locales: Locale[] } {
  const h = clone(seedDefinitions()["health-declaration"]);
  return { definition: h.definition, scoring: h.scoring, kind: h.kind, locales: h.locales };
}

/** Inserts a form with a published version 1 (directly, without the publish checks). */
export async function createForm(
  db: Db,
  i: { slug?: string; kind: FormKind; definition: FormDefinition; scoring: FormScoring; locales: Locale[]; status?: "published" | "archived" | "draft" },
): Promise<{ formId: string; versionId: string; slug: string }> {
  const slug = i.slug ?? uniqueSlug(i.kind);
  const [f] = await db.insert(forms).values({ slug, kind: i.kind, name: T(`Form ${slug}`) }).returning();
  const draft = i.status === "draft";
  const [v] = await db
    .insert(formVersions)
    .values({ formId: f!.id, version: 1, ...versionValues(i), publishedAt: draft ? null : new Date() })
    .returning();
  if (!draft) {
    await db
      .update(forms)
      .set({ status: i.status ?? "published", currentVersionId: v!.id, archivedAt: i.status === "archived" ? new Date() : null })
      .where(eq(forms.id, f!.id));
  }
  return { formId: f!.id, versionId: v!.id, slug };
}

/** A public request context at `now` (default: now). */
export function publicCtx(db: Db, now: Date = new Date(), actor: Actor = { kind: "public" }): Ctx {
  return makeCtx(db, { actor, now, ip: "203.0.113.5" });
}

export const later = (d: Date, seconds: number): Date => new Date(d.getTime() + seconds * 1000);

export const ASSESSMENT_ANSWERS = {
  email: "",
  first_name: "Lotte",
  sensitive_consent: true,
  newsletter: false,
  sleep_hours: "5_6",
  sleep_quality: 2,
  stress_level: 8,
  stress_physical: true,
  movement: "rarely",
  screen_time: "gt5",
  recovery_practices: [],
  cold_exposure: false,
};
