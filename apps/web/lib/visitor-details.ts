/**
 * Owner: someone signed in without a client account (staff looking at the site) is not asked again
 * for what the session already knows. Their email and name prefill the guest details, and so does
 * the phone of the client record with that email when there is one. They can still change them.
 */
import type { DbOrTx } from "@beam/db";
import { persons } from "@beam/db/schema";
import type { SessionInfo } from "@/lib/auth";
import { and, isNull, sql } from "@/lib/ctx";

export type VisitorDetails = { email?: string; firstName?: string; lastName?: string; phone?: string };

export async function knownVisitorDetails(db: DbOrTx, session: SessionInfo | null): Promise<VisitorDetails> {
  if (!session) return {};
  const email = session.user.email.trim().toLowerCase();
  const [first = "", ...rest] = (session.user.name ?? "").trim().split(/\s+/);
  const [person] = await db
    .select({ firstName: persons.firstName, lastName: persons.lastName, phone: persons.phone })
    .from(persons)
    .where(and(sql`lower(${persons.email}) = ${email}`, isNull(persons.mergedIntoPersonId), isNull(persons.erasedAt)))
    .limit(1)
    .catch(() => []);
  const out: VisitorDetails = { email };
  const firstName = person?.firstName || first;
  const lastName = person?.lastName || rest.join(" ");
  if (firstName) out.firstName = firstName;
  if (lastName) out.lastName = lastName;
  if (person?.phone) out.phone = person.phone;
  return out;
}
