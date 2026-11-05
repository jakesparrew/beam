/**
 * The submission pipeline without HTTP (forms spec rules U1 to U11, ID1 to ID10, C1 to C5,
 * SE1 to SE2, A1 to A6, E1 to E4, R2 and R3). The route handlers of forms-P4 call these with the
 * `action()` context of the public request; every function runs in the caller's transaction and
 * records its events and email in it (E4, C4).
 *
 * Status machine (U11): `started` -> `partial` (save) -> `completed` (submit); `started` and
 * `partial` -> `abandoned` (job); `abandoned` -> `partial` (resume, save or submit with proof).
 * Every status change runs `select ... for update` and a guarded `update ... where status in (...)`,
 * so a submit racing the abandon job cannot produce two outcomes.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { formLinks, forms, formSubmissions, formVersions, type FormConsentSnapshotJson, type FormScoreJson, type FormSubmissionSource } from "@beam/db/schema";
import {
  brusselsDay,
  cleanLandingPath,
  cleanReferrer,
  computePath,
  computeScore,
  deriveFunnel,
  deriveSensitiveKeys,
  deriveSource,
  FormResultLinkProps,
  FormResultProps,
  hostOf,
  isScored,
  isUnder,
  MARKETING_CONSENT_AGE,
  nextStep,
  readUtm,
  selectOutcome,
  SENSITIVE_CONSENT_AGE,
  splitScore,
  validateAnswers,
  validateSection,
  type Answers,
  type Ending,
  type FormDefinition,
  type FormScoring,
  type Utm,
} from "@beam/core/forms";
import { ACQUISITION_SOURCES, type Acquisition, type AcquisitionSource } from "@beam/core/crm";
import { t, type Locale, type LocalizedText } from "@beam/core/i18n";
import { AppError, and, ConflictError, desc, eq, inArray, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { applyTag, createInboxThreadFromForm, fillAcquisitionIfEmpty, findOrCreatePersonByEmail, getPerson, getPersonPrefill, recordConsent, updatePersonFields } from "@/modules/crm/api";
import { sendTransactional } from "@/modules/email/api";
import { readReferralCode } from "@/modules/site/api";
import { buildPrefill, isActiveStaff, mappedKeys, resolveIdentity, tokenFor, type Prefill } from "./identity";
import { isBotSubmission, limitResultLink, limitStart, limitSubmit, logBotDropped } from "./rate-limit";
import { deleteSensitiveExcept, hasSensitiveConsent, linkSensitive, scoreKey, sensitiveConsentKey, sensitiveKeysOf, storeSensitive } from "./sensitive";
import {
  appOrigin,
  createIdentityToken,
  createResultToken,
  ctaRedirectUrl,
  hashIp,
  hashToken,
  hostedFormUrl,
  randomToken,
  RESULT_TOKEN_DAYS,
  resultPageUrl,
  STAFF_ENTRY_TTL_SECONDS,
  verifyEmbedContext,
  verifySubmissionCookie,
} from "./tokens";
import { parseVersion, type StaffCtx } from "./versions";

export type { Prefill } from "./identity";
/** The context of a public request (`action()` with `audience: 'public'`, or a customer session). */
export type PublicCtx = Ctx;
/** A job context (`JobCtx` extends it). */
export type JobCtxLike = Ctx;

/** Proof of ownership on save and submit (section 4): resume token, signed `fsid`, or an identity token of the submission's person. */
export type SubmissionProof = { resumeToken?: string | null; fsid?: string | null; identityToken?: string | null };

/** `410 form_closed`: the form is archived (P10, U6). */
export class FormClosedError extends AppError {
  override readonly name: string = "FormClosedError";
  constructor() {
    super("conflict", "form_closed");
  }
}

const DAY_MS = 86_400_000;
export const ABANDON_AFTER_MS = DAY_MS;

type SubmissionRow = typeof formSubmissions.$inferSelect;
type FormRow = typeof forms.$inferSelect;
type Loaded = { sub: SubmissionRow; form: FormRow; version: { id: string; version: number; locales: string[] }; definition: FormDefinition; scoring: FormScoring };

const text = (t: LocalizedText | undefined, locale: Locale): string | null => (t ? (t[locale] ?? null) : null);

// ---------------------------------------------------------------------------
// Loading and guards
// ---------------------------------------------------------------------------

async function loadSubmission(tx: Tx, submissionId: string, lock: boolean): Promise<Loaded> {
  const q = tx.select().from(formSubmissions).where(eq(formSubmissions.id, submissionId));
  const [sub] = lock ? await q.for("update") : await q;
  if (!sub) throw new NotFoundError("submission_not_found");
  const [form] = await tx.select().from(forms).where(eq(forms.id, sub.formId));
  const [v] = await tx.select().from(formVersions).where(eq(formVersions.id, sub.formVersionId));
  if (!form || !v) throw new NotFoundError("submission_not_found");
  const c = parseVersion(v);
  return { sub, form, version: { id: v.id, version: v.version, locales: v.locales }, definition: c.definition, scoring: c.scoring };
}

/** Section 4: resume token, `fsid`, a session or identity token of the submission's person; else `404`. */
export function hasProof(ctx: Ctx, sub: SubmissionRow, slug: string, proof: SubmissionProof): boolean {
  if (proof.resumeToken && sub.resumeTokenHash && hashToken(proof.resumeToken) === sub.resumeTokenHash) return true;
  if (proof.fsid && verifySubmissionCookie(proof.fsid) === sub.id) return true;
  if (sub.personId) {
    if (ctx.actor.kind === "customer" && ctx.actor.personId === sub.personId) return true;
    const claims = tokenFor(proof.identityToken, slug, ctx.now);
    if (claims && claims.personId === sub.personId) return true;
  }
  return false;
}

/** U11 `abandoned` -> `partial`: within `resumeDays` of `last_activity_at` with resume on, else within 24 hours of `abandoned_at`. */
export function mayReopen(sub: SubmissionRow, def: FormDefinition, now: Date): boolean {
  if (sub.status !== "abandoned") return false;
  if (def.settings.resumeEnabled) return now.getTime() - sub.lastActivityAt.getTime() <= def.settings.resumeDays * DAY_MS;
  return !!sub.abandonedAt && now.getTime() - sub.abandonedAt.getTime() <= DAY_MS;
}

/** The guarded status update of U11; zero rows means the row moved on (`conflict`). */
async function guardedUpdate(tx: Tx, id: string, from: SubmissionRow["status"][], set: Partial<typeof formSubmissions.$inferInsert>): Promise<void> {
  const rows = await tx
    .update(formSubmissions)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(formSubmissions.id, id), inArray(formSubmissions.status, from)))
    .returning({ id: formSubmissions.id });
  if (!rows.length) throw new ConflictError("submission_state_changed");
}

async function reopen(tx: Tx, l: Loaded, now: Date): Promise<void> {
  if (!mayReopen(l.sub, l.definition, now)) throw new ConflictError("submission_expired");
  await guardedUpdate(tx, l.sub.id, ["abandoned"], { status: "partial", abandonedAt: null, lastActivityAt: now });
  l.sub = { ...l.sub, status: "partial", abandonedAt: null, lastActivityAt: now };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function baseEventData(l: Loaded, linkKey: string | null) {
  const s = l.sub;
  return {
    submission_id: s.id,
    form_id: l.form.id,
    form_slug: l.form.slug,
    form_kind: l.form.kind,
    form_version_id: l.version.id,
    version: l.version.version,
    source: s.source as AcquisitionSource,
    campaign: s.campaign,
    funnel: s.funnel,
    utm: s.utm ?? {},
    link_key: linkKey,
  };
}

async function linkKeyOf(tx: Tx, linkId: string | null): Promise<string | null> {
  if (!linkId) return null;
  const [r] = await tx.select({ key: formLinks.key }).from(formLinks).where(eq(formLinks.id, linkId));
  return r?.key ?? null;
}

/** `form.started` once a person is known (at start, or backfilled with `occurred_at = started_at`). */
async function recordStarted(tx: Tx, ctx: Ctx, l: Loaded, personId: string): Promise<void> {
  await ctx.recordEvent({
    kind: "form.started",
    personId,
    occurredAt: l.sub.startedAt,
    data: baseEventData(l, await linkKeyOf(tx, l.sub.linkId)),
    ref: { type: "form_submission", id: l.sub.id },
    dedupeKey: `form:${l.sub.id}:started`,
    isSensitive: false,
  });
}

// ---------------------------------------------------------------------------
// start (U1, A1, A2, ID1, ID2, R2, U5)
// ---------------------------------------------------------------------------

export type StartInput = {
  slug: string;
  locale: Locale;
  url: string;
  referrer?: string;
  embedHost?: string;
  identityToken?: string;
  embedContext?: string;
  ip: string;
};

/** The published form of a slug with its current version; `FormClosedError` when archived. */
export async function loadPublishedForm(tx: Tx, slug: string) {
  const [form] = await tx.select().from(forms).where(eq(forms.slug, slug));
  if (!form || !form.currentVersionId || form.status === "draft") throw new NotFoundError("form_not_found");
  if (form.status === "archived") throw new FormClosedError();
  const [v] = await tx.select().from(formVersions).where(eq(formVersions.id, form.currentVersionId));
  if (!v) throw new NotFoundError("form_not_found");
  return { form, versionRow: v, ...parseVersion(v) };
}

function isAcquisitionSource(v: string | undefined): boolean {
  return !!v && (ACQUISITION_SOURCES as readonly string[]).includes(v);
}

/** A session resume (U5, R2): the continued submission's non-sensitive answers and section. */
export type SessionResume = { answers: Answers; currentSectionKey: string | null };

/**
 * U1: inserts the `started` submission pinned to the current version. U5 (R2): a logged-in
 * customer (`identified_by = session`) instead continues their latest open submission of this
 * form on any device, when its pinned version has resume on and it is within `resumeDays` of
 * `last_activity_at` (`resumed` is then set; no new row, no second `form.started`).
 */
export async function startSubmission(
  tx: Tx,
  ctx: PublicCtx,
  i: StartInput,
): Promise<{ submissionId: string; resumeToken: string | null; prefill: Prefill | null; resumed?: SessionResume }> {
  const { form, versionRow, definition } = await loadPublishedForm(tx, i.slug);
  if (!versionRow.locales.includes(i.locale)) throw new ValidationError("unavailable_locale", { locale: "unavailable_locale" });
  const ipHash = hashIp(i.ip);
  await limitStart(tx, form.id, ipHash, ctx.now);

  let params = new URLSearchParams();
  let urlPath: string | null = null;
  try {
    const u = new URL(i.url);
    params = u.searchParams;
    urlPath = u.pathname;
  } catch {
    /* an unparsable landing URL carries no attribution */
  }
  const embed = verifyEmbedContext(i.embedContext);

  const linkKey = params.get("l")?.trim() || null;
  const [link] = linkKey ? await tx.select().from(formLinks).where(and(eq(formLinks.key, linkKey), eq(formLinks.formId, form.id))) : [];
  const activeLink = link?.isActive ? link : null;

  const utmParams: Record<string, string | undefined> = Object.fromEntries(params.entries());
  for (const [k, v] of Object.entries(embed?.utm ?? {})) if (utmParams[`utm_${k}`] === undefined) utmParams[`utm_${k}`] = v;
  const utm: Utm = readUtm(utmParams, (activeLink?.utm ?? {}));

  const referrer = cleanReferrer(i.referrer || params.get("ref") || embed?.referrer || null);
  const embedHost = i.embedHost ? hostOf(i.embedHost) : null;
  const landingPath = cleanLandingPath(embed?.landingPath ?? embed?.pagePath ?? urlPath);
  const appHost = hostOf(appOrigin());
  const src = params.get("src") ?? undefined;
  const derived = deriveSource({
    src: isAcquisitionSource(src?.trim().toLowerCase()) ? src : undefined,
    utm,
    linkChannel: (activeLink?.channel ?? undefined),
    linkName: activeLink?.name,
    referrerHost: hostOf(referrer) ?? undefined,
    embedHostIsBeam: embedHost ? embedHost === appHost : null,
  });

  const identity = resolveIdentity(ctx, { identityToken: i.identityToken, slug: form.slug });
  if (identity.identifiedBy === "staff" && !definition.settings.staffEntryAllowed) throw new ValidationError("staff_entry_not_allowed", { form: "staff_entry_not_allowed" });
  if (identity.staffUserId && !(await isActiveStaff(tx, identity.staffUserId))) throw new ValidationError("staff_user_inactive", { identityToken: "staff_user_inactive" });

  if (identity.identifiedBy === "session" && identity.personId) {
    const resumed = await resumeForSession(tx, ctx, { formId: form.id, personId: identity.personId, locale: i.locale });
    if (resumed) {
      const prefill = await buildPrefill(tx, resumed.l.definition, identity.personId);
      return { submissionId: resumed.l.sub.id, resumeToken: null, prefill, resumed: resumed.state };
    }
  }

  // U5: a resume token when resume is on; always for embedded forms (edge case 22, kept in memory there).
  const resumeToken = definition.settings.resumeEnabled || embedHost ? randomToken() : null;

  const [row] = await tx
    .insert(formSubmissions)
    .values({
      formId: form.id,
      formVersionId: versionRow.id,
      personId: identity.personId,
      status: "started",
      identifiedBy: identity.identifiedBy,
      utm,
      source: (identity.identifiedBy === "staff" ? "manual" : derived.source) as FormSubmissionSource,
      campaign: derived.campaign,
      funnel: deriveFunnel(definition.settings.funnel, form.slug),
      linkId: activeLink?.id ?? null,
      referrerUrl: referrer,
      landingPath,
      embedHost,
      enteredByUserId: identity.staffUserId,
      locale: i.locale,
      resumeTokenHash: resumeToken ? hashToken(resumeToken) : null,
      ipHash,
      startedAt: ctx.now,
      lastActivityAt: ctx.now,
    })
    .returning();
  const l: Loaded = { sub: row!, form, version: { id: versionRow.id, version: versionRow.version, locales: versionRow.locales }, definition, scoring: parseVersion(versionRow).scoring };
  if (identity.personId) await recordStarted(tx, ctx, l, identity.personId);
  const prefill = identity.personId ? await buildPrefill(tx, definition, identity.personId) : null;
  return { submissionId: row!.id, resumeToken, prefill };
}

/**
 * The partner and the referrer (R3 referral links) of the submission's tracked link
 * (`form_submissions` has no partner column; see the forms-P3 decisions).
 */
async function linkAttributionOf(tx: Tx, sub: SubmissionRow): Promise<{ partnerCompanyId: string | null; referrerPersonId: string | null }> {
  if (!sub.linkId) return { partnerCompanyId: null, referrerPersonId: null };
  const [r] = await tx.select({ p: formLinks.partnerCompanyId, r: formLinks.referrerPersonId }).from(formLinks).where(eq(formLinks.id, sub.linkId));
  return { partnerCompanyId: r?.p ?? null, referrerPersonId: r?.r ?? null };
}

/**
 * Who referred a person the submission creates (R3, rule A1 and A3): the tracked link's
 * `referrer_person_id` and the `beam_ref` referral code. Both apply to a new person only, so they
 * are left out of `fillAcquisitionIfEmpty` for an existing person: an existing customer who opens
 * a friend's link or carries a code is not that friend's referral.
 */
export type ReferralInput = { referralCode: string | null };

/** A3: the person's acquisition in crm's shape, from the submission's own attribution. */
async function acquisitionOf(tx: Tx, l: Loaded, referral: ReferralInput | null = null): Promise<Omit<Acquisition, "captured_at">> {
  const s = l.sub;
  const utm = s.utm ?? {};
  const link = await linkAttributionOf(tx, s);
  return {
    source: s.source as AcquisitionSource,
    funnel: s.funnel,
    form_slug: l.form.slug,
    ...(s.campaign ? { campaign: s.campaign } : {}),
    ...(utm.medium ? { medium: utm.medium } : {}),
    ...(Object.keys(utm).length ? { utm } : {}),
    ...(link.partnerCompanyId ? { partner_company_id: link.partnerCompanyId } : {}),
    ...(referral && link.referrerPersonId ? { referrer_person_id: link.referrerPersonId } : {}),
    ...(referral?.referralCode ? { referral_code: referral.referralCode } : {}),
  };
}

/** A referral code as crm accepts it (trimmed, 1 to 64 characters of `[A-Za-z0-9-]`), else null. */
export function cleanReferralCode(code: string | null | undefined): string | null {
  const c = code?.trim();
  return c && /^[A-Za-z0-9-]{1,64}$/.test(c) ? c : null;
}

/** A cookie reader over a request's `cookie` header, in the shape `site.readReferralCode` takes. */
function cookieJar(header: string | null): { get(name: string): { value: string } | undefined } {
  return {
    get(name) {
      for (const part of (header ?? "").split(";")) {
        const at = part.indexOf("=");
        if (at > 0 && part.slice(0, at).trim() === name) {
          try {
            return { value: decodeURIComponent(part.slice(at + 1).trim()) };
          } catch {
            return undefined;
          }
        }
      }
      return undefined;
    },
  };
}

/**
 * Rule A1 (R3, cross-module D18): the referral code of a public request, read with site's
 * `readReferralCode(cookies, searchParams)` from the `beam_ref` cookie (and site's `?ref=` rule
 * on the request URL), for a caller that holds the `Request` and passes it as `referralCode`.
 */
export function referralCodeOf(req: Request): string | null {
  let params: URLSearchParams | undefined;
  try {
    params = new URL(req.url).searchParams;
  } catch {
    params = undefined;
  }
  return cleanReferralCode(readReferralCode(cookieJar(req.headers.get("cookie")), params));
}

/**
 * The referral code of the request being served, when the caller did not pass one: the
 * `beam_ref` cookie through `next/headers` (route handlers and Server Actions). Outside a request
 * (jobs, imports, tests without a request) there is no cookie and no code.
 */
async function ambientReferralCode(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    return cleanReferralCode(readReferralCode(jar));
  } catch {
    return null;
  }
}

const referralFor = async (code: string | null | undefined): Promise<ReferralInput> => ({
  referralCode: code === undefined ? await ambientReferralCode() : cleanReferralCode(code),
});

// ---------------------------------------------------------------------------
// Person linking, profile and consent (ID3, ID4, ID9, A3, C1 to C5)
// ---------------------------------------------------------------------------

type ProfilePatch = { firstName?: string; lastName?: string; phone?: string; birthOn?: string };

function profileOf(def: FormDefinition, answers: Answers): { email: string | null } & ProfilePatch {
  const m = mappedKeys(def);
  const str = (k: string | undefined): string | undefined => {
    const v = k ? answers[k] : undefined;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const out: { email: string | null } & ProfilePatch = { email: str(m["person.email"]) ?? null };
  const fn = str(m["person.first_name"]);
  const ln = str(m["person.last_name"]);
  const ph = str(m["person.phone"]);
  const bo = str(m["person.birth_on"]);
  if (fn) out.firstName = fn;
  if (ln) out.lastName = ln;
  if (ph) out.phone = ph;
  if (bo) out.birthOn = bo;
  return out;
}

const patchOf = (p: ProfilePatch): ProfilePatch => {
  const out: ProfilePatch = {};
  for (const k of ["firstName", "lastName", "phone", "birthOn"] as const) if (p[k]) out[k] = p[k];
  return out;
};

/**
 * ID3 and A3: finds or creates the person by email; fills the acquisition once. The referral
 * (link referrer and `beam_ref` code) reaches crm only in the creating call; an existing person
 * whose acquisition is still empty gets the acquisition without it.
 */
async function linkByEmail(tx: Tx, ctx: Ctx, l: Loaded, email: string, profile: ProfilePatch, referral: ReferralInput): Promise<{ personId: string; created: boolean }> {
  const r = await findOrCreatePersonByEmail(tx, ctx, {
    email,
    locale: l.sub.locale as Locale,
    acquisition: await acquisitionOf(tx, l, referral),
    ...(profile.firstName ? { firstName: profile.firstName } : {}),
    ...(profile.lastName ? { lastName: profile.lastName } : {}),
    ...(profile.phone ? { phone: profile.phone } : {}),
  });
  if (!r.created) await fillAcquisitionIfEmpty(tx, ctx, r.personId, await acquisitionOf(tx, l));
  return r;
}

/** ID4: profile writes; with `email` identification only empty fields, and the differing names are the conflicts. */
async function updateProfile(tx: Tx, ctx: Ctx, personId: string, patch: ProfilePatch, onlyEmpty: boolean, before: Awaited<ReturnType<typeof getPersonPrefill>>): Promise<string[]> {
  if (!Object.keys(patch).length) return [];
  const conflicts: string[] = [];
  if (onlyEmpty) {
    for (const [k, v] of Object.entries(patch) as [keyof ProfilePatch, string][]) {
      const cur = before[k];
      if (cur !== null && cur !== undefined && cur !== "" && cur !== v) conflicts.push(k);
    }
  }
  await updatePersonFields(tx, ctx, personId, patch, { onlyEmpty });
  return conflicts;
}

type ConsentResult = { snapshot: FormConsentSnapshotJson[]; pendingConfirmation: boolean; skippedMinor: boolean };
const MARKETING = ["newsletter", "events", "member_comms", "b2b"];

/**
 * C1 to C5: one `recordConsent` per ticked consent field (an unticked box records nothing), plus
 * `assessment_result` for result forms (C3). Under 13 by the submitted birth date no marketing
 * consent is requested (C5). No outcome rolls the submit back.
 */
async function writeConsents(
  tx: Tx,
  ctx: Ctx,
  l: Loaded,
  personId: string,
  answers: Answers,
  o: { birthOn?: string; staffUserId: string | null; ip?: string; userAgent?: string; resultConsent: boolean },
): Promise<ConsentResult> {
  const out: ConsentResult = { snapshot: [], pendingConfirmation: false, skippedMinor: false };
  const minor = o.birthOn ? isUnder(o.birthOn, brusselsDay(ctx.now), MARKETING_CONSENT_AGE) : false;
  const prefix = `form:${l.form.slug}:v${l.version.version}`;
  const base = {
    personId,
    status: "granted" as const,
    method: "form" as const,
    source: o.staffUserId ? `staff:${o.staffUserId}` : `form:${l.form.slug}`,
    lawfulBasis: "consent" as const,
    ref: { type: "form_submission", id: l.sub.id },
    ...(o.ip ? { ip: o.ip } : {}),
    ...(o.userAgent ? { userAgent: o.userAgent.slice(0, 500) } : {}),
  };
  for (const key of Object.keys(l.definition.fields).sort()) {
    const f = l.definition.fields[key]!;
    if (f.type !== "consent" || answers[f.key] !== true) continue;
    const wordingVersion = `${prefix}:${f.key}`;
    if (MARKETING.includes(f.purpose) && minor) {
      out.snapshot.push({ purpose: f.purpose, granted: false, wordingVersion, fieldKey: f.key, skippedMinor: true });
      out.skippedMinor = true;
      continue;
    }
    const r = await recordConsent(tx, ctx, { ...base, purpose: f.purpose, wordingVersion });
    const entry: FormConsentSnapshotJson & { pendingConfirmation?: boolean } = {
      purpose: f.purpose,
      granted: r.outcome === "recorded" || r.outcome === "unchanged",
      wordingVersion,
      fieldKey: f.key,
    };
    if (r.outcome === "needs_confirmation") entry.pendingConfirmation = out.pendingConfirmation = true;
    if (r.outcome === "skipped_minor") entry.skippedMinor = out.skippedMinor = true;
    out.snapshot.push(entry);
  }
  if (o.resultConsent) {
    const wordingVersion = `${prefix}:submit`;
    const r = await recordConsent(tx, ctx, { ...base, purpose: "assessment_result", wordingVersion });
    out.snapshot.push({ purpose: "assessment_result", granted: r.outcome === "recorded" || r.outcome === "unchanged", wordingVersion, fieldKey: "submit" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// save (U2, SE2, ID9) and resume (U5)
// ---------------------------------------------------------------------------

/** U2: merges one section's answers; sensitive answers are stored only once `sensitive_processing` is ticked (SE2). */
export async function saveSection(
  tx: Tx,
  ctx: PublicCtx,
  i: { submissionId: string; proof: SubmissionProof; sectionKey: string; answers: Answers; referralCode?: string | null },
): Promise<{ next: { sectionKey: string } | { end: true } }> {
  const l = await loadSubmission(tx, i.submissionId, true);
  if (!hasProof(ctx, l.sub, l.form.slug, i.proof)) throw new NotFoundError("submission_not_found");
  if (l.form.status === "archived") throw new FormClosedError();
  if (l.sub.status === "completed") throw new ConflictError("submission_completed");
  if (l.sub.status === "abandoned") await reopen(tx, l, ctx.now);
  const section = l.definition.sections.find((s) => s.key === i.sectionKey);
  if (!section) throw new ValidationError("unknown_section", { sectionKey: "unknown_section" });

  const stored = (l.sub.answers ?? {}) as Answers;
  const merged: Answers = { ...stored, ...i.answers };
  // L4: this section's visibility reads the answers of the sections before it on the path.
  const v = validateSection(l.definition, l.sub.path, i.sectionKey, merged, l.scoring);
  if (!v.ok) throw new ValidationError("validation", v.fields);

  const sensitiveKeys = new Set(deriveSensitiveKeys(l.definition, l.scoring));
  const plainSection: Answers = {};
  const sensitiveSection: Answers = {};
  for (const fk of section.fieldKeys) {
    if (!(fk in v.clean)) continue;
    (sensitiveKeys.has(fk) ? sensitiveSection : plainSection)[fk] = v.clean[fk]!;
  }
  const answers: Answers = { ...stored };
  for (const fk of section.fieldKeys) delete answers[fk];
  Object.assign(answers, plainSection);
  // C5: special-category consent needs 16, also at the save (nothing sensitive of a minor is stored).
  const consentKey = sensitiveConsentKey(l.definition);
  const saved = profileOf(l.definition, answers);
  if (consentKey && answers[consentKey] === true && saved.birthOn && isUnder(saved.birthOn, brusselsDay(ctx.now), SENSITIVE_CONSENT_AGE)) {
    const held = (await sensitiveKeysOf(tx, [l.sub.id])).get(l.sub.id) ?? [];
    if (!held.length) throw new ValidationError("validation", { [consentKey]: "guardian_required" });
    // The birth date came after the sensitive answers: an error would roll this delete back, so the
    // save erases them and keeps the consent unticked; the submit then refuses with guardian_required.
    await deleteSensitiveExcept(tx, l.sub.id, []);
    delete answers[consentKey];
  }
  // SE2: before the consent is ticked the server discards sensitive answers; the browser keeps them.
  if (Object.keys(sensitiveSection).length && hasSensitiveConsent(l.definition, answers)) {
    await storeSensitive(tx, { submissionId: l.sub.id, personId: l.sub.personId, values: sensitiveSection });
  }

  const step = nextStep(l.definition, l.scoring, { ...answers, ...sensitiveSection }, i.sectionKey);
  const at = l.sub.path.indexOf(i.sectionKey);
  const path = at >= 0 ? l.sub.path.slice(0, at + 1) : [...l.sub.path, i.sectionKey];
  const set: Partial<typeof formSubmissions.$inferInsert> = {
    status: "partial",
    answers,
    path,
    currentSectionKey: "section" in step ? step.section : i.sectionKey,
    lastActivityAt: ctx.now,
  };

  // ID9: a saved valid email links an anonymous submission to a person when `capturePartialLeads` is on.
  const profile = profileOf(l.definition, answers);
  if (!l.sub.personId && l.definition.settings.capturePartialLeads && profile.email) {
    const { personId } = await linkByEmail(tx, ctx, l, profile.email, profile, await referralFor(i.referralCode));
    set.personId = personId;
    set.identifiedBy = "email";
    await linkSensitive(tx, l.sub.id, personId);
    const c = await writeConsents(tx, ctx, l, personId, answers, { ...(profile.birthOn ? { birthOn: profile.birthOn } : {}), staffUserId: null, resultConsent: false });
    if (c.snapshot.length) set.consentSnapshot = c.snapshot;
    await recordStarted(tx, ctx, l, personId);
  }
  await guardedUpdate(tx, l.sub.id, ["started", "partial"], set);
  return { next: "section" in step ? { sectionKey: step.section } : { end: true } };
}

/** U5 `GET resume`: the open submission of a resume token (an abandoned one within its window becomes `partial`). */
export async function resumeSubmission(
  tx: Tx,
  ctx: PublicCtx,
  i: { slug: string; token: string },
): Promise<{ submissionId: string; answers: Answers; currentSectionKey: string | null } | null> {
  const [row] = await tx
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .where(and(eq(formSubmissions.resumeTokenHash, hashToken(i.token)), eq(forms.slug, i.slug)));
  if (!row) return null;
  const l = await loadSubmission(tx, row.id, true);
  if (l.form.status === "archived" || l.sub.status === "completed") return null;
  if (l.sub.status === "abandoned") {
    if (!mayReopen(l.sub, l.definition, ctx.now)) return null;
    await reopen(tx, l, ctx.now);
  } else if (l.definition.settings.resumeEnabled && ctx.now.getTime() - l.sub.lastActivityAt.getTime() > l.definition.settings.resumeDays * DAY_MS) {
    return null;
  }
  return { submissionId: l.sub.id, answers: (l.sub.answers ?? {}) as Answers, currentSectionKey: resumeSectionOf(l) };
}

// ---------------------------------------------------------------------------
// Cross-device resume for logged-in customers (U5, R2; forms-P8)
// ---------------------------------------------------------------------------

/** Statuses a submission can be continued from. */
const OPEN_STATUSES: SubmissionRow["status"][] = ["started", "partial", "abandoned"];

/**
 * Whether a session customer may continue this open submission: the form is still published,
 * the pinned version has resume on, it is within `resumeDays` of `last_activity_at` (abandoned:
 * `mayReopen`), and it was not a staff-assisted entry (ID10 keeps its own consent rules).
 */
function sessionResumable(sub: SubmissionRow, formStatus: FormRow["status"], def: FormDefinition, now: Date): boolean {
  if (formStatus !== "published" || !def.settings.resumeEnabled || sub.identifiedBy === "staff" || sub.identifiedBy === "import") return false;
  if (sub.status === "abandoned") return mayReopen(sub, def, now);
  if (sub.status !== "started" && sub.status !== "partial") return false;
  return now.getTime() - sub.lastActivityAt.getTime() <= def.settings.resumeDays * DAY_MS;
}

/** The person's latest open submission of a form (any device), locked, when it may be continued. */
async function latestResumable(tx: Tx, formId: string, personId: string, now: Date): Promise<Loaded | null> {
  const [row] = await tx
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.formId, formId), eq(formSubmissions.personId, personId), inArray(formSubmissions.status, OPEN_STATUSES)))
    .orderBy(desc(formSubmissions.lastActivityAt), desc(formSubmissions.startedAt))
    .limit(1);
  if (!row) return null;
  const l = await loadSubmission(tx, row.id, true);
  return OPEN_STATUSES.includes(l.sub.status) && sessionResumable(l.sub, l.form.status, l.definition, now) ? l : null;
}

/**
 * U5 (R2): continues the session customer's latest open submission of the form. An abandoned one
 * becomes `partial` (its `form.abandoned` event stays); the locale follows the device when the
 * pinned version offers it. Ownership on later saves is the session itself (section 4).
 */
async function resumeForSession(tx: Tx, ctx: Ctx, i: { formId: string; personId: string; locale: Locale }): Promise<{ l: Loaded; state: SessionResume } | null> {
  const l = await latestResumable(tx, i.formId, i.personId, ctx.now);
  if (!l) return null;
  if (l.sub.status === "abandoned") await reopen(tx, l, ctx.now);
  const locale = l.version.locales.includes(i.locale) ? i.locale : l.sub.locale;
  await guardedUpdate(tx, l.sub.id, ["started", "partial"], { lastActivityAt: ctx.now, locale });
  l.sub = { ...l.sub, lastActivityAt: ctx.now, locale };
  return { l, state: { answers: (l.sub.answers ?? {}) as Answers, currentSectionKey: resumeSectionOf(l) } };
}

/**
 * U5 with SE1: resume never returns sensitive answers, and the submit needs them in its body, so
 * the visitor continues at the first saved section that holds a sensitive field when it comes
 * before the stored current section (they answer it again); otherwise at the stored one.
 */
function resumeSectionOf(l: Loaded): string | null {
  const current = l.sub.currentSectionKey;
  const sensitive = new Set(deriveSensitiveKeys(l.definition, l.scoring));
  const sections = l.definition.sections;
  const back = l.sub.path.find((k) => sections.find((s) => s.key === k)?.fieldKeys.some((fk) => sensitive.has(fk)));
  if (!back) return current;
  const at = (k: string) => sections.findIndex((s) => s.key === k);
  return current === null || at(back) < at(current) ? back : current;
}

// ---------------------------------------------------------------------------
// submit (U3, U6, U7, ID1 to ID4, ID10, C1 to C5, SE1, SE2, A3, A5, E1 to E4, R2, R3)
// ---------------------------------------------------------------------------

export type CompleteResult = { resultUrl: string | null; redirectUrl: string | null; endingKey: string; pendingConfirmation: boolean };

function endingOf(def: FormDefinition, key: string | null): Ending {
  return def.endings.find((e) => e.key === key) ?? def.endings[0]!;
}

/** The result of an already completed submission (U7: same URL, nothing changes). */
function storedResult(l: Loaded): CompleteResult {
  const ending = endingOf(l.definition, l.sub.endingKey);
  const token = createResultToken(l.sub.id, l.sub.resultTokenVersion);
  return {
    resultUrl: ending.kind === "result" ? resultPageUrl(l.form.slug, l.sub.locale as Locale, token) : null,
    redirectUrl: ending.kind === "redirect" ? (ending.redirectUrl ?? null) : null,
    endingKey: ending.key,
    pendingConfirmation: (l.sub.consentSnapshot ?? []).some((c) => (c as { pendingConfirmation?: boolean }).pendingConfirmation === true),
  };
}

/** The props of `forms.result` in the submission locale (never a sensitive value, SE4). */
function resultEmailData(l: Loaded, ending: Ending, o: { firstName: string | null; outcome: ReturnType<typeof selectOutcome>; total: number | null; token: string; pendingConfirmation: boolean }) {
  const locale = l.sub.locale as Locale;
  const range = o.total !== null && l.scoring.total ? l.scoring.total.ranges.find((r) => o.total! >= r.from && o.total! <= r.to) : undefined;
  const data = {
    firstName: o.firstName,
    formTitle: text(l.definition.title, locale) ?? l.form.slug,
    outcomeLabel: o.outcome ? text(o.outcome.label, locale) : null,
    scoreLine: ending.showScore && o.total !== null ? String(Math.round(o.total * 100) / 100) : null,
    explanation: (o.outcome ? text(o.outcome.explanation, locale) : null) ?? (range ? text(range.explanation, locale) : null),
    recommendation: (o.outcome ? text(o.outcome.recommendation, locale) : null) ?? (range ? text(range.recommendation, locale) : null),
    intro: text(ending.email?.intro, locale),
    resultUrl: resultPageUrl(l.form.slug, locale, o.token),
    ctas: ending.ctas.slice(0, 4).map((c) => ({ label: text(c.label, locale) ?? c.key, url: ctaRedirectUrl(o.token, c.key) })),
    pendingConfirmation: o.pendingConfirmation,
  };
  return FormResultProps.parse(data);
}

/**
 * U3: validates every visible required field on the recomputed path, links the person, writes
 * profile, consent, sensitive answers, score and outcome, applies outcome tags, creates the
 * result token, queues the result email and records the events, all in the caller's transaction.
 * A bot (honeypot or under 3 seconds, R3) gets a normal-looking thank-you and nothing is written.
 * `referralCode` (R3, rule A1) is the submit request's `beam_ref` code (`referralCodeOf(req)`);
 * left out, the code is read from the request being served (`next/headers`). It reaches crm only
 * when this submit creates the person.
 */
export async function completeSubmission(
  tx: Tx,
  ctx: PublicCtx,
  i: { submissionId: string; proof: SubmissionProof; answers: Answers; ip: string; userAgent: string; honeypot?: string | null; referralCode?: string | null },
): Promise<CompleteResult> {
  const l = await loadSubmission(tx, i.submissionId, true);
  if (!hasProof(ctx, l.sub, l.form.slug, i.proof)) throw new NotFoundError("submission_not_found");
  if (l.sub.status === "completed") return storedResult(l);
  if (l.form.status === "archived") throw new FormClosedError();
  const def = l.definition;
  if (isBotSubmission({ honeypot: i.honeypot, startedAt: l.sub.startedAt, now: ctx.now })) {
    logBotDropped({ formId: l.form.id, submissionId: l.sub.id, reason: i.honeypot?.trim() ? "honeypot" : "too_fast" });
    const thanks = def.endings.find((e) => e.kind === "thank_you") ?? def.endings[0]!;
    return { resultUrl: null, redirectUrl: null, endingKey: thanks.key, pendingConfirmation: false };
  }
  if (l.sub.status === "abandoned") await reopen(tx, l, ctx.now);

  // L1, L5, U9: the server recomputes the path and validates every visible required field on it.
  const merged: Answers = { ...((l.sub.answers ?? {}) as Answers), ...i.answers };
  const { path, endingKey: pathEnding } = computePath(def, l.scoring, merged);
  const v = validateAnswers(def, path, merged, { final: true }, l.scoring);
  if (!v.ok) throw new ValidationError("validation", v.fields);
  const clean = v.clean;
  const sensitiveKeys = deriveSensitiveKeys(def, l.scoring);
  const sensitiveSet = new Set(sensitiveKeys);
  const profile = profileOf(def, clean);

  // C5: special-category consent needs 16; SE2: no sensitive answer without the consent.
  const consentKey = sensitiveConsentKey(def);
  if (consentKey && clean[consentKey] === true && profile.birthOn && isUnder(profile.birthOn, brusselsDay(ctx.now), SENSITIVE_CONSENT_AGE)) {
    throw new ValidationError("validation", { [consentKey]: "guardian_required" });
  }
  const hasSensitive = Object.keys(clean).some((k) => sensitiveSet.has(k));
  if (hasSensitive && !hasSensitiveConsent(def, clean)) throw new ValidationError("validation", { [consentKey ?? "sensitive_processing"]: "required" });

  // ID1, ID2, ID10: who is this?
  let identifiedBy = l.sub.identifiedBy;
  let personId = l.sub.personId;
  let staffUserId = l.sub.enteredByUserId;
  if (identifiedBy === "staff") {
    const claims = tokenFor(i.proof.identityToken, l.form.slug, ctx.now);
    if (!claims || !claims.staffUserId || claims.staffUserId !== staffUserId || claims.personId !== personId) {
      throw new ValidationError("staff_token_expired", { identityToken: "staff_token_expired" });
    }
    if (!(await isActiveStaff(tx, claims.staffUserId))) throw new ValidationError("staff_user_inactive", { identityToken: "staff_user_inactive" });
  } else if (!personId || identifiedBy === "none" || identifiedBy === "email") {
    const session = ctx.actor.kind === "customer" ? ctx.actor.personId : null;
    const claims = session ? null : tokenFor(i.proof.identityToken, l.form.slug, ctx.now);
    if (session) [personId, identifiedBy] = [session, "session"];
    else if (claims && !claims.staffUserId) [personId, identifiedBy] = [claims.personId, "token"];
  }
  if (personId && identifiedBy === "token" && profile.email) {
    // ID2 and edge case 7: with a token, changing the email drops the token identification.
    const p = await getPerson(tx, personId);
    if (p?.email && p.email.toLowerCase() !== profile.email) [personId, identifiedBy] = [null, "none"];
  }
  if (personId && identifiedBy === "email" && profile.email) {
    // ID9 then ID3: a save-time email link holds only while the submitted email is still that person's.
    const p = await getPerson(tx, personId);
    if (p?.email?.toLowerCase() !== profile.email.toLowerCase()) [personId, identifiedBy] = [null, "none"];
  }
  if (profile.email) await limitSubmit(tx, l.form.id, profile.email, ctx.now);

  let conflicts: string[] = [];
  if (personId) {
    await fillAcquisitionIfEmpty(tx, ctx, personId, await acquisitionOf(tx, l));
    // ID4: an email identification (ID9 at the save) only fills empty fields; session and token overwrite.
    conflicts = await updateProfile(tx, ctx, personId, patchOf(profile), identifiedBy === "email", await getPersonPrefill(tx, personId));
  } else if (profile.email) {
    // ID3: find or create without profile values, so the conflicts of ID4 compare with the stored ones.
    const r = await linkByEmail(tx, ctx, l, profile.email, {}, await referralFor(i.referralCode));
    personId = r.personId;
    identifiedBy = "email";
    conflicts = await updateProfile(tx, ctx, personId, patchOf(profile), !r.created, await getPersonPrefill(tx, personId));
  }
  const newlyLinked = !!personId && personId !== l.sub.personId;
  if (identifiedBy !== "staff") staffUserId = null;

  // S2 to S8, SE1, S6: score once with the pinned version; sensitive values only encrypted.
  const score = computeScore(def, l.scoring, clean);
  const outcome = selectOutcome(l.scoring, clean, score);
  const split = splitScore(score);
  const plain: Answers = {};
  const sensitive: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(clean)) (sensitiveSet.has(k) ? sensitive : plain)[k] = val;
  for (const [k, d] of Object.entries(split.sensitive)) sensitive[scoreKey(k)] = d;
  // Edge case 6: with email identification differing profile values stay in `answers` (they are plain mapped fields already).
  await storeSensitive(tx, { submissionId: l.sub.id, personId, values: sensitive });
  await deleteSensitiveExcept(tx, l.sub.id, Object.keys(sensitive));

  const ending = endingOf(def, pathEnding ?? outcome?.endingKey ?? null);
  const scored = isScored(l.scoring);
  const resultConsent = ending.kind === "result" || def.settings.sendResultEmail;
  let consents: ConsentResult = { snapshot: [], pendingConfirmation: false, skippedMinor: false };
  const applied: string[] = [];
  if (personId) {
    consents = await writeConsents(tx, ctx, l, personId, clean, {
      ...(profile.birthOn ? { birthOn: profile.birthOn } : {}),
      staffUserId,
      ip: i.ip,
      userAgent: i.userAgent,
      resultConsent,
    });
    for (const tagKey of outcome?.tagKeys ?? []) {
      try {
        if ((await applyTag(tx, ctx, personId, tagKey, "form")).applied) applied.push(tagKey);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    }
  }

  const token = createResultToken(l.sub.id, l.sub.resultTokenVersion);
  let emailMessageId: string | null = null;
  if (personId && def.settings.sendResultEmail) {
    const prefill = await getPersonPrefill(tx, personId);
    const data = resultEmailData(l, ending, { firstName: prefill.firstName, outcome, total: split.plain.total, token, pendingConfirmation: consents.pendingConfirmation });
    const r = await sendTransactional(ctx, { template: "forms.result", personId, locale: l.sub.locale as Locale, data, key: `form_result:${l.sub.id}:email` });
    emailMessageId = r.emailMessageId;
  }

  const storedScore: FormScoreJson | null = scored ? split.plain : null;
  await guardedUpdate(tx, l.sub.id, ["started", "partial"], {
    status: "completed",
    personId,
    identifiedBy,
    answers: plain,
    score: storedScore,
    outcomeKey: outcome?.key ?? null,
    endingKey: ending.key,
    path,
    currentSectionKey: null,
    ...(identifiedBy === "staff" ? { source: "manual" } : {}),
    enteredByUserId: staffUserId,
    appliedTagKeys: applied,
    consentSnapshot: consents.snapshot,
    resultTokenHash: hashToken(token),
    resultTokenExpiresAt: new Date(ctx.now.getTime() + RESULT_TOKEN_DAYS * DAY_MS),
    resultEmailMessageId: emailMessageId,
    completedAt: ctx.now,
    lastActivityAt: ctx.now,
  });
  l.sub = { ...l.sub, personId, identifiedBy, ...(identifiedBy === "staff" ? { source: "manual" } : {}) };

  // E1 to E4: events only with a person, in this transaction, deduped.
  if (personId) {
    if (newlyLinked) await recordStarted(tx, ctx, l, personId);
    const base = baseEventData(l, await linkKeyOf(tx, l.sub.linkId));
    const ref = { type: "form_submission", id: l.sub.id };
    const dims = Object.fromEntries(Object.entries(split.plain.dimensions).map(([k, d]) => [k, d.rangeKey]));
    await ctx.recordEvent({
      kind: "form.completed",
      personId,
      occurredAt: ctx.now,
      ref,
      isSensitive: false,
      dedupeKey: `form:${l.sub.id}:completed`,
      data: {
        ...base,
        outcome_key: outcome?.key ?? null,
        score: scored ? split.plain.total : null,
        dimensions: dims,
        ending_key: ending.key,
        applied_tag_keys: applied,
        profile_conflicts: conflicts,
        via_import: false,
        entered_by_staff: identifiedBy === "staff",
      },
    });
    if (scored || ending.kind === "result") {
      await ctx.recordEvent({
        kind: "assessment.result_generated",
        personId,
        occurredAt: ctx.now,
        ref,
        isSensitive: false,
        dedupeKey: `form:${l.sub.id}:result`,
        data: {
          submission_id: l.sub.id,
          form_slug: l.form.slug,
          form_kind: l.form.kind,
          form_version_id: l.version.id,
          version: l.version.version,
          outcome_key: outcome?.key ?? null,
          score: scored ? split.plain.total : null,
          funnel: l.sub.funnel,
          source: base.source,
          result_email: emailMessageId ? "queued" : "not_sent",
        },
      });
    }
    // crm's unified inbox (cross-module D62): one thread per submission when the version asks for it.
    if (def.settings.createInboxThread) {
      const locale = l.sub.locale as Locale;
      await createInboxThreadFromForm(tx, ctx, { personId, submissionId: l.sub.id, subject: text(def.title, locale) ?? l.form.slug, body: inboxBody(def, plain, path, locale) });
    }
  }
  return {
    resultUrl: ending.kind === "result" ? resultPageUrl(l.form.slug, l.sub.locale as Locale, token) : null,
    redirectUrl: ending.kind === "redirect" ? (ending.redirectUrl ?? null) : null,
    endingKey: ending.key,
    pendingConfirmation: consents.pendingConfirmation,
  };
}

/** Field types whose answers are not message content (consents are recorded on their own, C1). */
const NOT_IN_INBOX = new Set(["consent", "acknowledgement", "hidden", "utm"]);

/**
 * The inbox message of a submission: `Label: value` per answered non-sensitive field on the path,
 * in section order and the submission locale (choice keys as their option labels). Sensitive
 * answers never reach the inbox (SE4): only `plain` is read.
 */
export function inboxBody(def: FormDefinition, plain: Answers, path: readonly string[], locale: Locale): string {
  const lines: string[] = [];
  for (const sectionKey of path) {
    for (const key of def.sections.find((s) => s.key === sectionKey)?.fieldKeys ?? []) {
      const f = def.fields[key];
      const v = plain[key];
      if (!f || NOT_IN_INBOX.has(f.type) || v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
      const optionLabel = (k: unknown) => ("options" in f ? (f.options.find((o) => o.key === k)?.label[locale] ?? String(k)) : String(k));
      const value = typeof v === "boolean" ? t(locale, v ? "forms.inbox.yes" : "forms.inbox.no") : Array.isArray(v) ? v.map(optionLabel).join(", ") : optionLabel(v);
      lines.push(`${text(f.label, locale) ?? key}: ${value}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// abandon (U4) and staff entry (ID10)
// ---------------------------------------------------------------------------

/** U4: up to `limit` open submissions idle for 24 hours become `abandoned`; `form.abandoned` when the person is known. */
export async function markAbandoned(tx: Tx, ctx: JobCtxLike, limit: number): Promise<number> {
  const cutoff = new Date(ctx.now.getTime() - ABANDON_AFTER_MS);
  const due = await tx
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(and(inArray(formSubmissions.status, ["started", "partial"]), sql`${formSubmissions.lastActivityAt} < ${cutoff.toISOString()}::timestamptz`))
    .orderBy(formSubmissions.lastActivityAt)
    .limit(limit)
    .for("update", { skipLocked: true });
  let n = 0;
  for (const { id } of due) {
    const rows = await tx
      .update(formSubmissions)
      .set({ status: "abandoned", abandonedAt: ctx.now, updatedAt: ctx.now })
      .where(and(eq(formSubmissions.id, id), inArray(formSubmissions.status, ["started", "partial"])))
      .returning();
    const s = rows[0];
    if (!s) continue;
    n++;
    if (!s.personId) continue;
    const [f] = await tx.select({ slug: forms.slug }).from(forms).where(eq(forms.id, s.formId));
    const sens = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from form_sensitive_answers where submission_id = ${s.id} and field_key not like 'score:%'`));
    const sensCount = Number(sens[0]?.n ?? 0);
    await ctx.recordEvent({
      kind: "form.abandoned",
      personId: s.personId,
      occurredAt: ctx.now,
      ref: { type: "form_submission", id: s.id },
      isSensitive: false,
      dedupeKey: `form:${s.id}:abandoned`,
      data: {
        submission_id: s.id,
        form_slug: f?.slug ?? "",
        form_version_id: s.formVersionId,
        last_section_key: s.currentSectionKey ?? s.path.at(-1) ?? null,
        answered_count: Object.keys(s.answers ?? {}).length + sensCount,
      },
    });
  }
  return n;
}

/**
 * ID10: the hosted URL with a 2-hour staff identity token for a person (permission
 * `persons.write`; only forms with `settings.staffEntryAllowed`; the locale defaults to the
 * person's and must be one of the version's).
 */
export async function createStaffEntryUrl(tx: Tx, ctx: StaffCtx, i: { formId: string; personId: string; locale?: Locale }): Promise<{ url: string }> {
  ctx.require("persons.write");
  if (ctx.actor.kind !== "staff") throw new ValidationError("staff_only");
  const [form] = await tx.select().from(forms).where(eq(forms.id, i.formId));
  if (!form || form.status !== "published" || !form.currentVersionId) throw new NotFoundError("form_not_found");
  const [v] = await tx.select().from(formVersions).where(eq(formVersions.id, form.currentVersionId));
  const c = parseVersion(v!);
  if (!c.definition.settings.staffEntryAllowed) throw new ValidationError("staff_entry_not_allowed", { formId: "staff_entry_not_allowed" });
  const person = await getPerson(tx, i.personId);
  if (!person) throw new NotFoundError("person_not_found");
  const locale = i.locale ?? person.locale;
  if (!c.locales.includes(locale)) throw new ValidationError("unavailable_locale", { locale: "unavailable_locale" });
  const pt = createIdentityToken({ personId: person.id, formSlug: form.slug, ttlSeconds: STAFF_ENTRY_TTL_SECONDS, staffUserId: ctx.actor.userId, now: ctx.now });
  return { url: hostedFormUrl(form.slug, locale, { pt }) };
}

// ---------------------------------------------------------------------------
// Result links (ID8)
// ---------------------------------------------------------------------------

export const RESULT_LINKS_PER_DAY = 3;

/**
 * ID8 (`requestResultLink`, public): always `{ ok: true }`. When a completed submission of that
 * form exists for that email, enqueues `forms.send_result_link` (at most 3 per email per form
 * per day, keys `form_result_link:<submission_id>:<YYYY-MM-DD>:<n>`).
 */
export async function requestResultLink(tx: Tx, ctx: PublicCtx, i: { slug: string; email: string; locale: Locale }): Promise<{ ok: true }> {
  const [form] = await tx.select({ id: forms.id }).from(forms).where(eq(forms.slug, i.slug));
  if (!form) return { ok: true };
  await limitResultLink(tx, form.id, i.email, ctx.now);
  const email = i.email.trim().toLowerCase();
  const [sub] = rowsOf<{ id: string; locale: string }>(
    await tx.execute(sql`
      select s.id, s.locale from form_submissions s join persons p on p.id = s.person_id
      where s.form_id = ${form.id} and s.status = 'completed' and lower(p.email) = ${email} and p.erased_at is null
      order by s.completed_at desc limit 1`),
  );
  if (!sub) return { ok: true };
  const day = brusselsDay(ctx.now);
  const [sent] = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from jobs where idempotency_key like ${`form_result_link:${sub.id}:${day}:%`}`));
  const n = Number(sent?.n ?? 0) + 1;
  if (n > RESULT_LINKS_PER_DAY) return { ok: true };
  await ctx.enqueue({ kind: "forms.send_result_link", payload: { submissionId: sub.id, locale: sub.locale }, key: `form_result_link:${sub.id}:${day}:${n}` });
  return { ok: true };
}

/**
 * `forms.send_result_link`: a fresh result URL by email. An expired link is renewed (the token
 * version is bumped, so the old link stays dead) for another 180 days. The email key is the job
 * key (`form_result_link:<submission_id>:<YYYY-MM-DD>:<n>`), so a rerun sends nothing new.
 */
export async function sendResultLink(tx: Tx, ctx: Ctx, i: { submissionId: string; locale: Locale; key: string }): Promise<{ emailMessageId: string | null }> {
  const l = await loadSubmission(tx, i.submissionId, true);
  if (l.sub.status !== "completed" || !l.sub.personId) return { emailMessageId: null };
  let version = l.sub.resultTokenVersion;
  if (!l.sub.resultTokenExpiresAt || l.sub.resultTokenExpiresAt.getTime() <= ctx.now.getTime()) {
    version += 1;
    await tx
      .update(formSubmissions)
      .set({
        resultTokenVersion: version,
        resultTokenHash: hashToken(createResultToken(l.sub.id, version)),
        resultTokenExpiresAt: new Date(ctx.now.getTime() + RESULT_TOKEN_DAYS * DAY_MS),
        updatedAt: ctx.now,
      })
      .where(eq(formSubmissions.id, l.sub.id));
  }
  const locale = (l.version.locales.includes(i.locale) ? i.locale : l.sub.locale) as Locale;
  const prefill = await getPersonPrefill(tx, l.sub.personId);
  const data = FormResultLinkProps.parse({
    firstName: prefill.firstName,
    formTitle: text(l.definition.title, locale) ?? l.form.slug,
    resultUrl: resultPageUrl(l.form.slug, locale, createResultToken(l.sub.id, version)),
  });
  const r = await sendTransactional(ctx, { template: "forms.result_link", personId: l.sub.personId, locale, data, key: i.key });
  return { emailMessageId: r.emailMessageId };
}

// ---------------------------------------------------------------------------
// Customer portal "My results" (forms spec section 5, R2; forms-P8)
// ---------------------------------------------------------------------------

/** A completed submission on the portal list; `hasResultPage` when its ending is a result page. */
export type PortalCompletedResult = {
  submissionId: string;
  formSlug: string;
  formName: LocalizedText;
  completedAt: Date;
  outcomeLabel: LocalizedText | null;
  hasResultPage: boolean;
};

/** An open submission the customer can continue (the latest open one per form, U5). */
export type PortalOpenSubmission = { submissionId: string; formSlug: string; formName: LocalizedText; lastActivityAt: Date };

export type PortalResults = { completed: PortalCompletedResult[]; open: PortalOpenSubmission[] };

/**
 * The portal list of one person (always `ctx.actor.personId` of the page): completed submissions,
 * newest first, and per form the latest open submission that may be continued on any device
 * (`sessionResumable`). Never an answer value or a score.
 */
export async function listPortalResults(db: DbOrTx, personId: string, now: Date): Promise<PortalResults> {
  const rows = await db
    .select({ s: formSubmissions, slug: forms.slug, name: forms.name, formStatus: forms.status, v: formVersions })
    .from(formSubmissions)
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .where(eq(formSubmissions.personId, personId))
    .orderBy(desc(formSubmissions.lastActivityAt), desc(formSubmissions.startedAt));
  const out: PortalResults = { completed: [], open: [] };
  const seenOpen = new Set<string>();
  for (const r of rows) {
    const c = parseVersion(r.v);
    if (r.s.status === "completed" && r.s.completedAt) {
      const outcome = c.scoring.outcomes.find((o) => o.key === r.s.outcomeKey);
      out.completed.push({
        submissionId: r.s.id,
        formSlug: r.slug,
        formName: r.name,
        completedAt: r.s.completedAt,
        outcomeLabel: outcome?.label ?? null,
        hasResultPage: endingOf(c.definition, r.s.endingKey).kind === "result",
      });
    } else if (OPEN_STATUSES.includes(r.s.status) && !seenOpen.has(r.s.formId)) {
      // Only the latest open submission of a form is the one a new start continues (U5).
      seenOpen.add(r.s.formId);
      if (sessionResumable(r.s, r.formStatus, c.definition, now)) {
        out.open.push({ submissionId: r.s.id, formSlug: r.slug, formName: r.name, lastActivityAt: r.s.lastActivityAt });
      }
    }
  }
  out.completed.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
  return out;
}

/**
 * "View result" (portal): a fresh result link for the customer's own completed submission. The
 * link lives another 180 days from now; an expired token is replaced by bumping
 * `result_token_version` (the dead link stays dead), a valid one keeps its token so the result
 * email's link keeps working, and a submission that never had one (an import) gets its first.
 * Another person's submission, an open one or one without a result page answers `not_found`.
 */
export async function openPortalResult(tx: Tx, ctx: Ctx, i: { submissionId: string }): Promise<{ url: string }> {
  if (ctx.actor.kind !== "customer") throw new NotFoundError("submission_not_found");
  const personId = ctx.actor.personId;
  const [own] = await tx
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.id, i.submissionId), eq(formSubmissions.personId, personId), eq(formSubmissions.status, "completed")));
  if (!own) throw new NotFoundError("submission_not_found");
  const l = await loadSubmission(tx, own.id, true);
  if (l.sub.status !== "completed" || l.sub.personId !== personId) throw new NotFoundError("submission_not_found");
  if (endingOf(l.definition, l.sub.endingKey).kind !== "result") throw new NotFoundError("result_not_available");
  const live = !!l.sub.resultTokenHash && !!l.sub.resultTokenExpiresAt && l.sub.resultTokenExpiresAt.getTime() > ctx.now.getTime();
  const version = live || !l.sub.resultTokenHash ? l.sub.resultTokenVersion : l.sub.resultTokenVersion + 1;
  const token = createResultToken(l.sub.id, version);
  await tx
    .update(formSubmissions)
    .set({
      resultTokenVersion: version,
      resultTokenHash: hashToken(token),
      resultTokenExpiresAt: new Date(ctx.now.getTime() + RESULT_TOKEN_DAYS * DAY_MS),
      updatedAt: ctx.now,
    })
    .where(eq(formSubmissions.id, l.sub.id));
  return { url: resultPageUrl(l.form.slug, l.sub.locale as Locale, token) };
}

/** The portal's empty-state link: the newest published assessment offered in the locale, or null. */
export async function featuredAssessment(db: DbOrTx, locale: Locale): Promise<{ slug: string; name: LocalizedText } | null> {
  const [row] = await db
    .select({ slug: forms.slug, name: forms.name })
    .from(forms)
    .innerJoin(formVersions, eq(formVersions.id, forms.currentVersionId))
    .where(and(eq(forms.status, "published"), eq(forms.kind, "assessment"), sql`${locale} = any(${formVersions.locales})`))
    .orderBy(desc(formVersions.publishedAt), desc(forms.createdAt))
    .limit(1);
  return row ?? null;
}
