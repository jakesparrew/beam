/**
 * The emailed claim link (booking spec 4.4, R44, edge case 9). GET never changes state (mail
 * scanners prefetch links): it looks up `claim_token_hash` and answers 303 to
 * `/<locale>/claim/<token>` in the person's locale, or to `/<default>/claim/invalid` for an
 * unknown or superseded token. POST is not served: the claim is the `claimSeat` server action
 * posted from the claim page, so it runs inside `action()`.
 */
import { URL_SEGMENT } from "@beam/core/i18n";
import { persons } from "@beam/db/schema";
import { appUrl } from "@/lib/auth";
import { eq, getAppDb } from "@/lib/ctx";
import { entryByToken } from "@/modules/booking/server/claim";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  let location = appUrl(`/${URL_SEGMENT["nl-BE"]}/claim/invalid`);
  try {
    const db = await getAppDb();
    const entry = await entryByToken(db, token);
    if (entry) {
      const [person] = await db.select({ locale: persons.locale }).from(persons).where(eq(persons.id, entry.personId));
      location = appUrl(`/${URL_SEGMENT[person?.locale ?? "nl-BE"]}/claim/${encodeURIComponent(token)}`);
    }
  } catch {
    // An unreadable token lands on the invalid page.
  }
  return new Response(null, { status: 303, headers: { ...HEADERS, location } });
}

export function POST(): Response {
  return new Response(null, { status: 405, headers: { ...HEADERS, allow: "GET" } });
}
