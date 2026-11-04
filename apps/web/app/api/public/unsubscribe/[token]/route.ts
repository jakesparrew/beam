/**
 * RFC 8058 one-click unsubscribe (crm spec 4.4, rule 3.16). POST withdraws the message's purpose
 * with source `one_click:<email_message_id>` and answers 200 with an empty body; an unknown token
 * also answers 200 and writes nothing (no enumeration; mail clients do not retry). GET never
 * mutates (link scanners): it redirects to the preference centre's confirm page.
 */
import { URL_SEGMENT } from "@beam/core/i18n";
import { getAppDb } from "@/lib/ctx";
import { appUrl } from "@/lib/auth";
import { unsubscribeByToken } from "@/modules/crm/consent/actions";
import { resolvePreferenceToken } from "@/modules/crm/consent/queries";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  await unsubscribeByToken({ token, oneClick: true });
  return new Response(null, { status: 200, headers: NO_STORE });
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  let segment = URL_SEGMENT["nl-BE"];
  try {
    const link = await resolvePreferenceToken(await getAppDb(), token);
    if (link) segment = URL_SEGMENT[link.locale];
  } catch {
    // An unreadable token still lands on the page, which says the link is not valid.
  }
  const location = appUrl(`/${segment}/preferences/${encodeURIComponent(token)}?confirm=unsubscribe`);
  return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
}
