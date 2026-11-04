/**
 * The token preference centre's JSON door (crm spec 4.4). GET returns the state of the token's
 * person (404 for an unknown token). POST saves the switches through `updatePreferencesByToken`;
 * a token whose message is older than 365 days answers 410 for everything but unsubscribing.
 * POST `{ freshLink: true, email? }` asks for a fresh link (`crm.preference_link`, 3 per day).
 */
import { z } from "zod";
import { getAppDb } from "@/lib/ctx";
import type { ActionResult } from "@/lib/action";
import { requestFreshPreferenceLink, updatePreferencesByToken } from "@/modules/crm/consent/actions";
import { getPreferenceState } from "@/modules/crm/consent/queries";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const state = await getPreferenceState(await getAppDb(), token);
  if (!state) return json({ error: { code: "not_found", message: "unknown_token" } }, 404);
  const { firstNameInitial, locale, purposes, suppressedAll, confirmPurpose, canEdit } = state;
  return json({ firstNameInitial, locale, purposes, suppressedAll, confirmPurpose, canEdit });
}

const FreshLinkBody = z.object({ freshLink: z.literal(true), email: z.string().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: { code: "validation", message: "invalid_json" } }, 400);
  }
  const fresh = FreshLinkBody.safeParse(body);
  if (fresh.success) {
    return toResponse(await requestFreshPreferenceLink(fresh.data.email ? { email: fresh.data.email } : { token }));
  }
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return toResponse(await updatePreferencesByToken({ ...payload, token }));
}

function toResponse(result: ActionResult<unknown>): Response {
  if (result.ok) return json({ ok: true });
  const { code, message, fields } = result.error;
  const error = { code, message, ...(fields ? { fields } : {}) };
  switch (code) {
    case "not_found":
      return json({ error }, 404);
    case "conflict":
      return json({ error }, message === "link_expired" ? 410 : 409);
    case "validation":
      return json({ error }, 400);
    case "rate_limited":
      return json({ error }, 429);
    default:
      return json({ error }, 500);
  }
}
