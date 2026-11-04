/**
 * Personalisation values (email spec rules 13, 23, 24).
 *
 * - `resolveMergeFields(tx, { personId, context, locale, names })`: the module merge fields
 *   (`{{webinar.title}}`) collected by `pnpm gen:indexes` into `MERGE_FIELDS`. A resolver gets
 *   only `{ tx, personId, context, locale }`, where `context` holds the message's ids
 *   (`{ registration_id, session_id, order_id }`), never names or addresses. An unknown name and
 *   a resolver that throws give `null`, so the token's fallback renders.
 * - `buildTokenValues()`: the `EMAIL_TOKENS` values of one recipient, read only from `persons`
 *   (names), `v_person_status`, `v_person_credits`, `booking.getNextBooking()` and crm's link
 *   URLs, plus the merge fields. Sensitive fields are never read. Only names used are computed.
 * - `mergeFieldProblems()`: the unknown tokens and merge fields of a version's texts (rule 13:
 *   an unknown one blocks publishing; the publish action of email-P5 calls it).
 */
import type { DbOrTx } from "@beam/db";
import { persons, vPersonCredits, vPersonStatus } from "@beam/db/schema";
import { isEmailToken, MERGE_FIELD_PATTERN, unknownTokens } from "@beam/core/email";
import { formatDate, formatDateTime, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import type { TokenValues } from "@beam/email/blocks";
import { eq } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { MERGE_FIELDS } from "@/registry/merge-fields.generated";
import { getNextBooking } from "@/modules/booking/api";

export type MergeFieldArgs = { tx: DbOrTx; personId: string | null; context: Readonly<Record<string, string>>; locale: Locale };
export type MergeFieldResolver = (args: MergeFieldArgs) => Promise<string | null>;
export type MergeFieldRegistry = Readonly<Record<string, MergeFieldResolver | undefined>>;

const registry = (): MergeFieldRegistry => MERGE_FIELDS;

/** The registered merge-field names (`<module>.<field>`). */
export function mergeFieldNames(source: MergeFieldRegistry = registry()): string[] {
  return Object.keys(source).sort();
}

/** Only string ids pass into a resolver's context. */
function idsOnly(context: Readonly<Record<string, unknown>> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(context ?? {})) if (typeof v === "string") out[k] = v;
  return out;
}

export async function resolveMergeFields(
  tx: DbOrTx,
  input: { personId: string | null; context: Readonly<Record<string, unknown>> | null | undefined; locale: Locale; names: readonly string[] },
  source: MergeFieldRegistry = registry(),
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const context = idsOnly(input.context);
  for (const name of new Set(input.names)) {
    if (!MERGE_FIELD_PATTERN.test(name)) continue;
    const resolver = source[name];
    if (!resolver) {
      out[name] = null;
      continue;
    }
    try {
      const value = await resolver({ tx, personId: input.personId, context: { ...context }, locale: input.locale });
      out[name] = value === undefined || value === "" ? null : value;
    } catch (error) {
      reportError(error, { tags: { merge_field: name } });
      out[name] = null;
    }
  }
  return out;
}

/** The unknown tokens and merge fields of `texts` (rule 13); empty means publishable. */
export function mergeFieldProblems(texts: readonly string[], source: MergeFieldRegistry = registry()): string[] {
  const names = mergeFieldNames(source);
  const out: string[] = [];
  for (const text of texts) for (const name of unknownTokens(text, names)) if (!out.includes(name)) out.push(name);
  return out;
}

/** The message's crm links; `unsubscribeUrl` is null for transactional mail (the token falls back). */
export type LinkUrls = { preferencesUrl: string; unsubscribeUrl: string | null };

/** `APP_URL` (the public origin), without a trailing slash. */
export function appOrigin(): string {
  return (process.env.APP_URL ?? "https://beam.be").replace(/\/$/, "");
}

export async function buildTokenValues(
  tx: DbOrTx,
  input: {
    personId: string | null;
    locale: Locale;
    context: Readonly<Record<string, unknown>> | null | undefined;
    names: readonly string[];
    links: LinkUrls | null;
  },
  source: MergeFieldRegistry = registry(),
): Promise<TokenValues> {
  const names = new Set(input.names);
  const values: Record<string, string | null> = {};
  const uses = (n: string) => names.has(n);
  const { personId, locale } = input;

  if (personId && (uses("first_name") || uses("last_name") || uses("full_name"))) {
    const [p] = await tx.select({ firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(eq(persons.id, personId));
    values.first_name = p?.firstName ?? null;
    values.last_name = p?.lastName ?? null;
    values.full_name = [p?.firstName, p?.lastName].filter((x) => x?.trim()).join(" ") || null;
  }
  if (personId && (uses("status") || uses("membership_period_end_on"))) {
    const [s] = await tx
      .select({ status: vPersonStatus.status, end: vPersonStatus.membershipPeriodEndAt })
      .from(vPersonStatus)
      .where(eq(vPersonStatus.personId, personId));
    values.status = s?.status ?? null;
    values.membership_period_end_on = s?.end ? formatDate(s.end, locale, "long") : null;
  }
  if (personId && uses("credits_remaining")) {
    const rows = await tx.select({ kind: vPersonCredits.creditKind, units: vPersonCredits.remainingUnits }).from(vPersonCredits).where(eq(vPersonCredits.personId, personId));
    const units = rows.filter((r) => r.kind !== "euro").reduce((sum, r) => sum + r.units, 0);
    values.credits_remaining = rows.length ? String(units) : null;
  }
  if (personId && uses("next_booking_at")) {
    const next = await getNextBooking(tx, personId);
    values.next_booking_at = next ? formatDateTime(next.startsAt, locale, "long") : null;
  }
  if (uses("portal_url")) values.portal_url = `${appOrigin()}/${URL_SEGMENT[locale]}/account`;
  if (input.links) {
    values.preferences_url = input.links.preferencesUrl;
    values.unsubscribe_url = input.links.unsubscribeUrl;
  }
  const mergeNames = [...names].filter((n) => !isEmailToken(n) && MERGE_FIELD_PATTERN.test(n));
  if (mergeNames.length) Object.assign(values, await resolveMergeFields(tx, { personId, context: input.context, locale, names: mergeNames }, source));
  return values;
}
