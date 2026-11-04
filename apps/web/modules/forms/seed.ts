/**
 * forms's demo seed (runbook 6.3, forms-P2). Facade read by `pnpm gen:indexes`; runs after site
 * (and therefore after platform and crm, whose demo persons it links).
 *
 * - publishes the `health-declaration` draft of the `defaults` seed and creates and publishes the
 *   demo assessment `recovery-check` (3 sections, 12 fields, sensitive `sleep` and `stress`
 *   dimensions, 4 outcomes), both through `service/versions.ts` with
 *   `{ skipDpiaCheck: 'demo_seed' }`: the demo profile runs only on `beam_dev`, never on
 *   `neondb`, and its submissions belong to fake persons;
 * - 30 demo submissions across statuses (`completed`, `partial`, `abandoned`, `started`) and
 *   sources on `recovery-check`, `contact` and `newsletter`, computed with the core engine
 *   (path, validation, score, outcome, sensitive split). Sensitive answers and sensitive
 *   dimensions are stored encrypted in `form_sensitive_answers` when the sensitive data key is
 *   configured, never in `answers` or `score`.
 *
 * Idempotent: the submissions are created only in the run that creates `recovery-check`, so a
 * second run creates nothing. No events, emails or consents are written (preview data only).
 */
import type { DbOrTx } from "@beam/db";
import { forms, formSensitiveAnswers, formSubmissions, persons, sessions, sessionTemplates, type FormSubmissionSource } from "@beam/db/schema";
import {
  computePath,
  computeScore,
  recoveryCheckSeed,
  selectOutcome,
  splitScore,
  splitSensitive,
  validateAnswers,
  type Answers,
  type RecoveryCheckRefs,
  type SeedForm,
} from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { and, asc, eq, gt, sql } from "@/lib/ctx";
import { currentKeyVersion, encryptSensitive, sensitiveAad, sensitiveKey } from "@/lib/sensitive";
import type { SeedCtx } from "@/scripts/seed-demo";
import { findDraft, insertDraftVersion, publishFormVersion } from "./service/versions";

const DAY = 24 * 60 * 60 * 1000;
const DEMO_SLUG = "recovery-check";
const SOURCES: readonly FormSubmissionSource[] = ["website", "paid_meta", "organic_search", "qr_code", "social_media", "landing_page", "referral", "partner", "paid_google", "webinar"];
const CAMPAIGNS: Partial<Record<FormSubmissionSource, string>> = { paid_meta: "recovery-autumn", paid_google: "recovery-search", qr_code: "Flyer Ghent station", webinar: "webinar-sleep" };

type Demo = Pick<SeedCtx, "db" | "now" | "rand" | "ids">;
type DemoPersonRow = { id: string; email: string | null; firstName: string | null; locale: string };

const pickOf = <X>(rand: () => number, xs: readonly X[]): X => xs[Math.floor(rand() * xs.length) % xs.length]!;

/** CTA targets for the demo assessment from booking's rows when they exist (else URL buttons). */
async function demoRefs(db: DbOrTx, now: Date): Promise<RecoveryCheckRefs> {
  const base = process.env.APP_URL?.startsWith("https://") ? process.env.APP_URL : "https://beam.example.com";
  const template = async (kind: "day" | "night") =>
    (await db.select({ id: sessionTemplates.id }).from(sessionTemplates).where(and(eq(sessionTemplates.kind, kind), eq(sessionTemplates.isActive, true))).orderBy(asc(sessionTemplates.createdAt)).limit(1))[0]?.id;
  const [event] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.kind, "event"), eq(sessions.status, "open"), gt(sessions.startsAt, now)))
    .orderBy(asc(sessions.startsAt))
    .limit(1);
  const refs: RecoveryCheckRefs = { baseUrl: base };
  const day = await template("day");
  const night = await template("night");
  if (day) refs.dayTemplateId = day;
  if (night) refs.nightTemplateId = night;
  if (event) refs.eventSessionId = event.id;
  return refs;
}

/** Answers of one demo visitor of the recovery check. */
function recoveryAnswers(rand: () => number, p: DemoPersonRow | null, n: number): Answers {
  const stress = 1 + Math.floor(rand() * 10);
  const a: Answers = {
    email: p?.email ?? `forms-demo-${n}@example.com`,
    first_name: p?.firstName ?? "Demo",
    sensitive_consent: true,
    newsletter: rand() < 0.3,
    sleep_hours: pickOf(rand, ["lt5", "5_6", "7_8", "gt8"]),
    sleep_quality: 1 + Math.floor(rand() * 5),
    stress_level: stress,
    movement: pickOf(rand, ["rarely", "weekly", "several", "daily"]),
    screen_time: pickOf(rand, ["lt1", "1_3", "3_5", "gt5"]),
    recovery_practices: ["sauna", "breathwork", "meditation", "walks"].filter(() => rand() < 0.4),
    cold_exposure: rand() < 0.5,
  };
  if (stress >= 6) a.stress_physical = rand() < 0.5;
  return a;
}

async function ensureRecoveryCheck(db: DbOrTx, now: Date, ownerId: string | null): Promise<{ formId: string; versionId: string; form: SeedForm } | null> {
  const [existing] = await db.select({ id: forms.id }).from(forms).where(eq(forms.slug, DEMO_SLUG));
  if (existing) return null;
  const form = recoveryCheckSeed(await demoRefs(db, now));
  const [row] = await db.insert(forms).values({ slug: DEMO_SLUG, kind: form.kind, name: form.name, status: "draft", createdByUserId: ownerId }).returning({ id: forms.id });
  const draft = await insertDraftVersion(db, { formId: row!.id, version: 1, definition: form.definition, scoring: form.scoring, locales: form.locales, createdByUserId: ownerId, changeNote: "Demo assessment" });
  await publishFormVersion(db, { formId: row!.id, versionId: draft.versionId, publishedByUserId: ownerId, now }, { skipDpiaCheck: "demo_seed" });
  return { formId: row!.id, versionId: draft.versionId, form };
}

/** Publishes the `health-declaration` draft seeded by `defaults` (demo only, DPIA gate skipped). */
async function publishHealthDeclaration(db: DbOrTx, now: Date, ownerId: string | null): Promise<boolean> {
  const [hd] = await db.select().from(forms).where(eq(forms.slug, "health-declaration"));
  if (!hd || hd.status !== "draft") return false;
  const draft = await findDraft(db, hd.id);
  if (!draft) return false;
  await publishFormVersion(db, { formId: hd.id, versionId: draft.id, publishedByUserId: ownerId, changeNote: "Published by the demo seed", now }, { skipDpiaCheck: "demo_seed" });
  return true;
}

type SubmissionPlan = { status: "completed" | "partial" | "abandoned" | "started"; daysAgo: number; source: FormSubmissionSource; person: DemoPersonRow | null; locale: Locale };

export async function runFormsDemoSeed(s: Demo): Promise<{ created: number; published: string[] }> {
  const { db, now, rand, ids } = s;
  const ownerId = ids.get("platform.user.owner") ?? null;
  const published: string[] = [];
  if (await publishHealthDeclaration(db, now, ownerId)) published.push("health-declaration");
  const recovery = await ensureRecoveryCheck(db, now, ownerId);
  if (!recovery) return { created: 0, published };
  published.push(DEMO_SLUG);
  ids.set("forms.form.recovery-check", recovery.formId);

  const people = await db
    .select({ id: persons.id, email: persons.email, firstName: persons.firstName, locale: persons.locale })
    .from(persons)
    .where(sql`${persons.email} like ${"crm-demo-%@example.com"}`)
    .orderBy(asc(persons.createdAt), asc(persons.email))
    .limit(30);
  const personAt = (n: number): DemoPersonRow | null => (people.length ? people[n % people.length]! : null);
  const localeOf = (p: DemoPersonRow | null, n: number): Locale => (p && ["nl-BE", "fr-BE", "en"].includes(p.locale) ? (p.locale as Locale) : (["nl-BE", "fr-BE", "en"] as const)[n % 3]!);
  const canEncrypt = sensitiveKey(currentKeyVersion()) !== null;

  let created = 0;
  const statuses: SubmissionPlan["status"][] = ["completed", "completed", "completed", "completed", "completed", "completed", "completed", "completed", "completed", "completed", "completed", "completed", "completed", "completed", "partial", "partial", "partial", "abandoned", "abandoned", "started"];
  for (let n = 0; n < statuses.length; n++) {
    const status = statuses[n]!;
    const anonymous = status !== "completed" && n % 2 === 1;
    const person = anonymous ? null : personAt(n);
    const plan: SubmissionPlan = { status, daysAgo: 1 + Math.floor(rand() * 40), source: SOURCES[n % SOURCES.length]!, person, locale: localeOf(person, n) };
    await insertRecoverySubmission(db, now, recovery, plan, recoveryAnswers(rand, person, n), canEncrypt);
    created++;
  }

  for (const slug of ["contact", "newsletter"] as const) {
    const [f] = await db.select().from(forms).where(eq(forms.slug, slug));
    if (!f?.currentVersionId) continue;
    const count = slug === "contact" ? 6 : 4;
    for (let k = 0; k < count; k++) {
      const p = personAt(20 + created + k);
      const answers: Answers =
        slug === "contact"
          ? { email: p?.email ?? `forms-demo-contact-${k}@example.com`, first_name: p?.firstName ?? "Demo", message: "Ik had graag meer info over een groepsbezoek.", newsletter: k % 2 === 0 }
          : { email: p?.email ?? `forms-demo-news-${k}@example.com`, first_name: p?.firstName ?? "Demo", newsletter: true };
      const completedAt = new Date(now.getTime() - (2 + k * 3) * DAY);
      await db.insert(formSubmissions).values({
        formId: f.id,
        formVersionId: f.currentVersionId,
        personId: p?.id ?? null,
        status: "completed",
        identifiedBy: p ? "email" : "none",
        answers,
        path: [slug === "contact" ? "contact" : "signup"],
        endingKey: "thanks",
        source: SOURCES[(k + 3) % SOURCES.length]!,
        funnel: slug,
        locale: localeOf(p, k),
        startedAt: new Date(completedAt.getTime() - 3 * 60 * 1000),
        lastActivityAt: completedAt,
        completedAt,
      });
    }
    created += count;
  }
  return { created, published };
}

async function insertRecoverySubmission(db: DbOrTx, now: Date, r: { formId: string; versionId: string; form: SeedForm }, plan: SubmissionPlan, all: Answers, canEncrypt: boolean): Promise<void> {
  const { definition, scoring } = r.form;
  const startedAt = new Date(now.getTime() - plan.daysAgo * DAY);
  const full = computePath(definition, scoring, all);
  const sectionsDone = plan.status === "completed" ? full.path.length : plan.status === "started" ? 0 : 1 + Math.floor(plan.daysAgo % 2);
  const path = full.path.slice(0, sectionsDone);
  const checked = validateAnswers(definition, path, all, { final: plan.status === "completed" }, scoring);
  if (!checked.ok) throw new Error(`demo answers invalid: ${JSON.stringify(checked.fields)}`);
  const { plain, sensitive } = splitSensitive(definition, checked.clean, scoring);
  const completed = plan.status === "completed";
  const score = completed ? computeScore(definition, scoring, checked.clean) : null;
  const outcome = score ? selectOutcome(scoring, checked.clean, score) : null;
  const stored = score ? splitScore(score) : null;
  const lastActivityAt = new Date(startedAt.getTime() + 4 * 60 * 1000);
  const [row] = await db
    .insert(formSubmissions)
    .values({
      formId: r.formId,
      formVersionId: r.versionId,
      personId: plan.person?.id ?? null,
      status: plan.status,
      identifiedBy: plan.person ? "email" : "none",
      answers: plain,
      score: stored?.plain ?? null,
      outcomeKey: outcome?.key ?? null,
      endingKey: completed ? full.endingKey : null,
      path,
      currentSectionKey: completed ? null : (full.path[sectionsDone] ?? null),
      utm: plan.source === "paid_meta" ? { source: "ig", medium: "cpc", campaign: CAMPAIGNS.paid_meta } : {},
      source: plan.source,
      campaign: CAMPAIGNS[plan.source] ?? null,
      funnel: definition.settings.funnel ?? `form:${DEMO_SLUG}`,
      appliedTagKeys: completed && plan.person ? (outcome?.tagKeys ?? []) : [],
      locale: plan.locale,
      consentSnapshot: completed ? [{ purpose: "sensitive_processing", granted: true, wordingVersion: `form:${DEMO_SLUG}:v1:sensitive_consent`, fieldKey: "sensitive_consent" }] : [],
      startedAt,
      lastActivityAt,
      completedAt: completed ? lastActivityAt : null,
      abandonedAt: plan.status === "abandoned" ? new Date(lastActivityAt.getTime() + DAY) : null,
    })
    .returning({ id: formSubmissions.id });
  // SE2: sensitive answers are stored only once the sensitive-processing consent was given.
  if (!canEncrypt || !checked.clean.sensitive_consent) return;
  const values: Record<string, unknown> = { ...sensitive };
  for (const [k, v] of Object.entries(stored?.sensitive ?? {})) values[`score:${k}`] = v;
  const rows = Object.entries(values).map(([fieldKey, value]) => {
    const enc = encryptSensitive(JSON.stringify(value), sensitiveAad.formAnswer(row!.id, fieldKey));
    return { submissionId: row!.id, personId: plan.person?.id ?? null, fieldKey, valueEnc: enc.valueEnc, keyVersion: enc.keyVersion };
  });
  if (rows.length) await db.insert(formSensitiveAnswers).values(rows);
}

export const seed = { after: ["site"], run: (s: SeedCtx): Promise<unknown> => runFormsDemoSeed(s) };
