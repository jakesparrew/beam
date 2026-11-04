"use server";
/**
 * Consent and suppression actions (crm spec 4.1, 4.4), crm-P3. Staff changes are audited as
 * `consent.change`, `suppression.add` and `consent_wording.publish`. The public token actions
 * take the email link token as their only credential (crm spec 4.4); an unknown token never
 * reveals anything.
 */
import { z } from "zod";
import { consentWordings, rateLimits } from "@beam/db/schema";
import { brusselsDay, canEditPreferences, CONSENT_PURPOSES, MARKETING_PURPOSES, SUPPRESSION_SCOPES, type ConsentOutcome, type MarketingPurpose } from "@beam/core/crm";
import { LOCALES, LocalizedTextSchema, missingLocales } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { AppError, eq, NotFoundError, RateLimitedError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { rateLimit } from "@/lib/rate-limit";
import { sendTransactional } from "@/modules/email/api";
import { findByEmail } from "../persons/api";
import { activePerson, addSuppression, applyPreferences, changePersonLocale, currentWordingVersion, getCurrentConsents, recordConsent, unsubscribe } from "./api";
import { marketingState, resolvePreferenceToken } from "./queries";

const Purposes = z.object(Object.fromEntries(MARKETING_PURPOSES.map((p) => [p, z.boolean()])) as Record<MarketingPurpose, z.ZodBoolean>);
const Token = z.string().min(16).max(200);

/** Fresh preference links per person per day (crm spec 4.4). */
export const PREFERENCE_LINK_DAILY_LIMIT = 3;

const staffId = (ctx: Ctx): string => (ctx.actor.kind === "staff" ? ctx.actor.userId : "unknown");

export const recordStaffConsent = action(
  {
    name: "crm.record_staff_consent",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ personId: z.uuid(), purpose: z.enum(CONSENT_PURPOSES), status: z.enum(["granted", "withdrawn"]) }),
    audit: false,
  },
  async (ctx, input): Promise<{ recordId: string | null; outcome: ConsentOutcome }> => {
    const person = await activePerson(ctx.tx, input.personId);
    const before = (await getCurrentConsents(ctx.tx, person.id))[input.purpose];
    let wordingVersion = await currentWordingVersion(ctx.tx, input.purpose);
    if (input.status === "granted") {
      if (input.purpose !== "b2b") throw new ValidationError("staff_grant_b2b_legitimate_interest_only", { purpose: "staff_grant_b2b_only" });
      if (!wordingVersion) throw new ValidationError("wording_not_published", { purpose: "wording_not_published" });
    }
    wordingVersion ??= "unsubscribe";
    const result = await recordConsent(ctx.tx, ctx, {
      personId: person.id,
      purpose: input.purpose,
      status: input.status,
      method: "staff",
      source: `staff:${staffId(ctx)}`,
      wordingVersion,
      ...(input.status === "granted" ? { lawfulBasis: "legitimate_interest" as const } : {}),
      ...(ctx.ip ? { ip: ctx.ip } : {}),
    });
    await ctx.audit({
      action: "consent.change",
      entityType: "person",
      entityId: person.id,
      personId: person.id,
      oldValue: { purpose: input.purpose, status: before?.status ?? null },
      newValue: { purpose: input.purpose, status: input.status, outcome: result.outcome },
    });
    return result;
  },
);

export const addManualSuppression = action(
  {
    name: "crm.add_suppression",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ email: z.string().trim().toLowerCase().email().max(254), scope: z.enum(SUPPRESSION_SCOPES), note: z.string().trim().min(3).max(500) }),
    audit: false,
  },
  async (ctx, input): Promise<{ suppressionId: string }> => {
    const { suppressionId, created } = await addSuppression(ctx.tx, ctx, { email: input.email, scope: input.scope, reason: "manual", source: `staff:${staffId(ctx)}` });
    await ctx.audit({ action: "suppression.add", entityType: "suppression", entityId: suppressionId, newValue: { scope: input.scope, reason: "manual", note: input.note, created } });
    return { suppressionId };
  },
);

export const publishConsentWording = action(
  {
    name: "crm.publish_consent_wording",
    audience: "staff",
    permission: "settings.write",
    input: z.object({ purpose: z.enum(CONSENT_PURPOSES), text: LocalizedTextSchema }),
    audit: false,
  },
  async (ctx, input): Promise<{ version: number }> => {
    const missing = missingLocales(input.text, LOCALES);
    if (missing.length) throw new ValidationError("missing_locales", { text: missing.join(",") });
    await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`consent_wording:${input.purpose}`}))`);
    const [last] = await ctx.tx
      .select({ version: sql<number>`coalesce(max(${consentWordings.version}), 0)::int` })
      .from(consentWordings)
      .where(eq(consentWordings.purpose, input.purpose));
    const version = Number(last?.version ?? 0) + 1;
    await ctx.tx.insert(consentWordings).values({
      purpose: input.purpose,
      version,
      text: input.text,
      publishedAt: ctx.now,
      createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
    });
    await ctx.audit({ action: "consent_wording.publish", entityType: "consent_wording", entityId: `${input.purpose}@${version}`, newValue: { purpose: input.purpose, version } });
    return { version };
  },
);

/**
 * Public: the token is the only credential (crm spec 4.4). A token whose message is older than
 * 365 days may only unsubscribe (`conflict` `link_expired`, the route answers 410).
 */
export const updatePreferencesByToken = action(
  {
    name: "crm.update_preferences_by_token",
    audience: "public",
    input: z.object({ token: Token, purposes: Purposes, locale: z.enum(LOCALES).optional(), unsubscribeAll: z.boolean().optional() }),
  },
  async (ctx, input): Promise<{ changed: MarketingPurpose[]; skipped: Partial<Record<MarketingPurpose, ConsentOutcome>> }> => {
    const link = await resolvePreferenceToken(ctx.tx, input.token);
    if (!link) throw new NotFoundError("unknown_token");
    if (!canEditPreferences(link.sentAt, ctx.now) && !input.unsubscribeAll) {
      const state = await marketingState(ctx.tx, link.personId);
      const grants = MARKETING_PURPOSES.some((p) => input.purposes[p] && !state.purposes[p]);
      const localeChange = !!input.locale && input.locale !== state.locale;
      if (grants || localeChange) throw new AppError("conflict", "link_expired");
    }
    if (input.locale) await changePersonLocale(ctx.tx, ctx, link.personId, input.locale);
    return applyPreferences(ctx.tx, ctx, link.personId, {
      purposes: input.purposes,
      unsubscribeAll: input.unsubscribeAll,
      method: "preference_centre",
      source: "preference_centre",
      ip: ctx.ip,
    });
  },
);

/**
 * Public: unsubscribes the token's person from the message's purpose, or from `purpose` when
 * given (`all` for everything). The RFC 8058 one-click POST stores source `one_click:<message_id>`.
 * An unknown token writes nothing and answers `{ done: false }`.
 */
export const unsubscribeByToken = action(
  {
    name: "crm.unsubscribe_by_token",
    audience: "public",
    input: z.object({ token: Token, purpose: z.enum([...MARKETING_PURPOSES, "all"]).optional(), oneClick: z.boolean().optional() }),
  },
  async (ctx, input): Promise<{ done: boolean; purpose: MarketingPurpose | "all" | null }> => {
    const link = await resolvePreferenceToken(ctx.tx, input.token);
    if (!link) return { done: false, purpose: null };
    const purpose = input.purpose ?? link.purpose;
    if (!purpose) return { done: false, purpose: null };
    const person = await activePerson(ctx.tx, link.personId);
    if (!person.email) return { done: false, purpose };
    await unsubscribe(ctx.tx, ctx, {
      personId: person.id,
      purpose,
      method: "unsubscribe_link",
      source: input.oneClick ? `one_click:${link.emailMessageId}` : "unsubscribe_link",
    });
    return { done: true, purpose };
  },
);

/**
 * Public: "email me a fresh link" (crm spec 4.4, edge case 26), `crm.preference_link`, at most
 * three per person per day (key `preference_link:<person_id>:<YYYY-MM-DD>:<n>`). From a known
 * token over the limit it is `rate_limited`; from a typed address the reply is always the same.
 */
export const requestFreshPreferenceLink = action(
  {
    name: "crm.request_preference_link",
    audience: "public",
    input: z.object({ token: Token.optional(), email: z.string().trim().toLowerCase().email().max(254).optional() }).refine((v) => !!v.token || !!v.email, { message: "token_or_email" }),
  },
  async (ctx, input): Promise<{ ok: true }> => {
    let personId: string | null = null;
    if (input.token) personId = (await resolvePreferenceToken(ctx.tx, input.token))?.personId ?? null;
    if (!personId && input.email) {
      const found = await findByEmail(ctx.tx, input.email);
      personId = found && !found.erasedAt ? found.id : null;
    }
    if (!personId) return { ok: true };
    const person = await activePerson(ctx.tx, personId);
    if (!person.email) return { ok: true };
    const key = `crm:preference_link:${person.id}`;
    const verdict = await rateLimit(ctx.tx, { key, limit: PREFERENCE_LINK_DAILY_LIMIT, windowSeconds: 86_400 }, ctx.now);
    if (!verdict.ok) {
      if (input.token) throw new RateLimitedError(verdict.retryAfterSeconds);
      return { ok: true };
    }
    const [row] = await ctx.tx.select({ count: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, key));
    await sendTransactional(ctx, {
      template: "crm.preference_link",
      personId: person.id,
      locale: person.locale,
      data: { firstName: person.firstName ?? null },
      key: `preference_link:${person.id}:${brusselsDay(ctx.now)}:${row?.count ?? 1}`,
    });
    return { ok: true };
  },
);
