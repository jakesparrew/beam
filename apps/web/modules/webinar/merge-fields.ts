/**
 * webinar merge fields (webinar spec 4.8; email rule 23). Facade read by `pnpm gen:indexes`,
 * keyed `webinar.<field>` in `MERGE_FIELDS`: `{{webinar.access_url}}`, `{{webinar.title}}` and
 * `{{webinar.starts_at_local}}`, used by the seeded marketing template `webinar-follow-up` and by
 * staff-written webinar emails.
 *
 * A resolver reads only the message's `context` ids (`registration_id`, `webinar_id`), which
 * every send of this module and every webinar journey enrolment (subject ref
 * `webinar_registration:<id>`) carries. A missing or unknown id returns `null`, which email
 * renders as the token's fallback or an empty string. `access_url` also needs the registration
 * to belong to the recipient (or a person merged into them), so a personal link never reaches
 * another person.
 */
import type { DbOrTx } from "@beam/db";
import { persons, webinarRegistrations, webinars } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { titleIn, webinarAccessUrl, webinarDate } from "@beam/email/templates/webinar";
import { eq } from "@/lib/ctx";

export type WebinarMergeFieldArgs = { tx: DbOrTx; personId: string | null; context: Readonly<Record<string, string>>; locale: Locale };
type Resolver = (args: WebinarMergeFieldArgs) => Promise<string | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idOf = (v: string | undefined) => (v && UUID.test(v) ? v : null);

/** The webinar of `context.webinar_id`, else of the registration of `context.registration_id`. */
async function webinarOf(tx: DbOrTx, context: Readonly<Record<string, string>>) {
  const webinarId = idOf(context.webinar_id);
  if (webinarId) {
    const [w] = await tx.select({ title: webinars.title, startsAt: webinars.startsAt }).from(webinars).where(eq(webinars.id, webinarId));
    if (w) return w;
  }
  const registrationId = idOf(context.registration_id);
  if (!registrationId) return null;
  const [w] = await tx
    .select({ title: webinars.title, startsAt: webinars.startsAt })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(eq(webinarRegistrations.id, registrationId));
  return w ?? null;
}

const accessUrl: Resolver = async ({ tx, personId, context, locale }) => {
  const registrationId = idOf(context.registration_id);
  if (!registrationId || !personId) return null;
  const [r] = await tx
    .select({ id: webinarRegistrations.id, tokenVersion: webinarRegistrations.tokenVersion, personId: webinarRegistrations.personId, mergedInto: persons.mergedIntoPersonId })
    .from(webinarRegistrations)
    .innerJoin(persons, eq(persons.id, webinarRegistrations.personId))
    .where(eq(webinarRegistrations.id, registrationId));
  if (!r) return null;
  if (r.personId !== personId && r.mergedInto !== personId) {
    const [recipient] = await tx.select({ mergedInto: persons.mergedIntoPersonId }).from(persons).where(eq(persons.id, personId));
    if (recipient?.mergedInto !== r.personId) return null;
  }
  return webinarAccessUrl(r.id, r.tokenVersion, locale);
};

const title: Resolver = async ({ tx, context, locale }) => {
  const w = await webinarOf(tx, context);
  return w ? titleIn(w.title as Record<string, string>, locale) || null : null;
};

const startsAtLocal: Resolver = async ({ tx, context, locale }) => {
  const w = await webinarOf(tx, context);
  return w?.startsAt ? webinarDate(w.startsAt, locale) : null;
};

export const mergeFields: Record<"access_url" | "title" | "starts_at_local", Resolver> = {
  access_url: accessUrl,
  title,
  starts_at_local: startsAtLocal,
};
