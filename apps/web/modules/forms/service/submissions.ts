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
import type { Tx } from "@beam/db";
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
  type Answers,
  type Ending,
  type FormDefinition,
  type FormKind,
  type FormLinkChannel,
  type FormScoring,
  type Utm,
} from "@beam/core/forms";
import { ACQUISITION_SOURCES, type Acquisition, type AcquisitionSource } from "@beam/core/crm";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { AppError, and, ConflictError, eq, inArray, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { applyTag, fillAcquisitionIfEmpty, findOrCreatePersonByEmail, getPerson, getPersonPrefill, recordConsent, updatePersonFields } from "@/modules/crm/api";
import { sendTransactional } from "@/modules/email/api";
import { buildPrefill, isActiveStaff, mappedKeys, resolveIdentity, tokenFor, type IdentifiedBy, type Prefill } from "./identity";
import { isBotSubmission, limitResultLink, limitStart, limitSubmit, logBotDropped } from "./rate-limit";
import { deleteSensitiveExcept, hasSensitiveConsent, linkSensitive, scoreKey, sensitiveConsentKey, storeSensitive } from "./sensitive";
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
    form_kind: l.form.kind as FormKind,
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

/** U1: inserts the `started` submission pinned to the current version. */
export async function startSubmission(tx: Tx, ctx: PublicCtx, i: StartInput): Promise<{ submissionId: string; resumeToken: string | null; prefill: Prefill | null }> {
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
  const utm: Utm = readUtm(utmParams, (activeLink?.utm ?? {}) as Utm);

  const referrer = cleanReferrer(i.referrer || params.get("ref") || embed?.referrer || null);
  const embedHost = i.embedHost ? hostOf(i.embedHost) : null;
  const landingPath = cleanLandingPath(embed?.landingPath ?? embed?.pagePath ?? urlPath);
  const appHost = hostOf(appOrigin());
  const src = params.get("src") ?? undefined;
  const derived = deriveSource({
    src: isAcquisitionSource(src?.trim().toLowerCase()) ? src : undefined,
    utm,
    linkChannel: (activeLink?.channel ?? undefined) as FormLinkChannel | undefined,
    linkName: activeLink?.name,
    referrerHost: hostOf(referrer) ?? undefined,
    embedHostIsBeam: embedHost ? embedHost === appHost : null,
  });

  const identity = resolveIdentity(ctx, { identityToken: i.identityToken, slug: form.slug });
  if (identity.identifiedBy === "staff" && !definition.settings.staffEntryAllowed) throw new ValidationError("staff_entry_not_allowed", { form: "staff_entry_not_allowed" });
  if (identity.staffUserId && !(await isActiveStaff(tx, identity.staffUserId))) throw new ValidationError("staff_user_inactive", { identityToken: "staff_user_inactive" });

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

/** The partner of the submission's tracked link (`form_submissions` has no partner column; see the package decisions). */
async function partnerOf(tx: Tx, sub: SubmissionRow): Promise<string | null> {
  if (!sub.linkId) return null;
  const [r] = await tx.select({ p: formLinks.partnerCompanyId }).from(formLinks).where(eq(formLinks.id, sub.linkId));
  return r?.p ?? null;
}

/** A3: the person's acquisition in crm's shape, from the submission's own attribution. */
async function acquisitionOf(tx: Tx, l: Loaded): Promise<Omit<Acquisition, "captured_at">> {
  const s = l.sub;
  const utm = s.utm ?? {};
  const partner = await partnerOf(tx, s);
  return {
    source: s.source as AcquisitionSource,
    funnel: s.funnel,
    form_slug: l.form.slug,
    ...(s.campaign ? { campaign: s.campaign } : {}),
    ...(utm.medium ? { medium: utm.medium } : {}),
    ...(Object.keys(utm).length ? { utm } : {}),
    ...(partner ? { partner_company_id: partner } : {}),
  };
}

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

/** ID3 and A3: finds or creates the person by email; fills the acquisition once. */
async function linkByEmail(tx: Tx, ctx: Ctx, l: Loaded, email: string, profile: ProfilePatch): Promise<{ personId: string; created: boolean }> {
  const acquisition = await acquisitionOf(tx, l);
  const r = await findOrCreatePersonByEmail(tx, ctx, {
    email,
    locale: l.sub.locale as Locale,
    acquisition,
    ...(profile.firstName ? { firstName: profile.firstName } : {}),
    ...(profile.lastName ? { lastName: profile.lastName } : {}),
    ...(profile.phone ? { phone: profile.phone } : {}),
  });
  if (!r.created) await fillAcquisitionIfEmpty(tx, ctx, r.personId, acquisition);
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
  i: { submissionId: string; proof: SubmissionProof; sectionKey: string; answers: Answers },
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
  const v = validateAnswers(l.definition, [i.sectionKey], merged, { final: true }, l.scoring);
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
    const { personId } = await linkByEmail(tx, ctx, l, profile.email, profile);
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
  return { submissionId: l.sub.id, answers: (l.sub.answers ?? {}) as Answers, currentSectionKey: l.sub.currentSectionKey };
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
 */
export async function completeSubmission(
  tx: Tx,
  ctx: PublicCtx,
  i: { submissionId: string; proof: SubmissionProof; answers: Answers; ip: string; userAgent: string; honeypot?: string | null },
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
  let identifiedBy = l.sub.identifiedBy as IdentifiedBy;
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
  if (profile.email) await limitSubmit(tx, l.form.id, profile.email, ctx.now);

  let created = false;
  let conflicts: string[] = [];
  const newlyLinked = !l.sub.personId;
  if (personId) {
    await fillAcquisitionIfEmpty(tx, ctx, personId, await acquisitionOf(tx, l));
    conflicts = await updateProfile(tx, ctx, personId, patchOf(profile), false, await getPersonPrefill(tx, personId));
  } else if (profile.email) {
    // ID3: find or create without profile values, so the conflicts of ID4 compare with the stored ones.
    const r = await linkByEmail(tx, ctx, l, profile.email, {});
    created = r.created;
    personId = r.personId;
    identifiedBy = "email";
    conflicts = await updateProfile(tx, ctx, personId, patchOf(profile), !created, await getPersonPrefill(tx, personId));
  }
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
    ...(identifiedBy === "staff" ? { source: "manual" as FormSubmissionSource } : {}),
    enteredByUserId: staffUserId,
    appliedTagKeys: applied,
    consentSnapshot: consents.snapshot,
    resultTokenHash: hashToken(token),
    resultTokenExpiresAt: new Date(ctx.now.getTime() + RESULT_TOKEN_DAYS * DAY_MS),
    resultEmailMessageId: emailMessageId,
    completedAt: ctx.now,
    lastActivityAt: ctx.now,
  });
  l.sub = { ...l.sub, personId, identifiedBy, ...(identifiedBy === "staff" ? { source: "manual" } : {}) } as SubmissionRow;

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
  }
  return {
    resultUrl: ending.kind === "result" ? resultPageUrl(l.form.slug, l.sub.locale as Locale, token) : null,
    redirectUrl: ending.kind === "redirect" ? (ending.redirectUrl ?? null) : null,
    endingKey: ending.key,
    pendingConfirmation: consents.pendingConfirmation,
  };
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
  const [sent] = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from jobs where key like ${`form_result_link:${sub.id}:${day}:%`}`));
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
