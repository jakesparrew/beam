/**
 * POST /api/public/cookie-consent (site spec section 4, rules 36-39; site-P5). Body
 * `{ consentKey?, action, choices: { analytics, marketing }, bannerVersion, locale }`: appends one
 * `cookie_consents` row (person linked when a customer session exists, IP only as HMAC), sets
 * `beam_consent` (`Secure; SameSite=Lax; Path=/; Max-Age=15724800`, readable by JS) and returns
 * `{ consentKey }`. Counts against the PL-68 per-IP API bucket.
 */
import { z } from "zod";
import { getAppDb } from "@/lib/ctx";
import { actorFromSession, loadSession } from "@/lib/auth";
import { SESSION_COOKIE_NAMES } from "@/lib/files";
import { limitApiRequest } from "@/lib/rate-limit";
import { consentSetCookie, recordCookieConsent } from "@/modules/site/server/consent";
import { choicesFor } from "@beam/core/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

const Body = z.object({
  consentKey: z.uuid().optional(),
  action: z.enum(["accept_all", "reject_all", "custom", "withdraw"]),
  choices: z.object({ analytics: z.boolean(), marketing: z.boolean() }),
  bannerVersion: z.number().int().min(0).max(1_000_000),
  locale: z.enum(["nl-BE", "fr-BE", "en"]),
});

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}

export async function POST(request: Request): Promise<Response> {
  const db = await getAppDb();
  const ip = clientIp(request);
  const limited = await limitApiRequest(db, { pathname: new URL(request.url).pathname, ip: ip ?? "unknown" });
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: { code: "validation", message: "invalid_json" } }, { status: 400, headers: NO_STORE });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    const fields = Object.fromEntries(parsed.error.issues.map((i) => [i.path.join(".") || "body", i.message]));
    return Response.json({ error: { code: "validation", message: "invalid_body", fields } }, { status: 400, headers: NO_STORE });
  }
  const body = parsed.data;

  const header = request.headers.get("cookie");
  const token = SESSION_COOKIE_NAMES.map((n) => cookieValue(header, n)).find((v) => !!v) ?? null;
  const actor = token ? actorFromSession(await loadSession(db, token)) : null;
  const personId = actor?.kind === "customer" ? actor.personId : null;

  const now = new Date();
  const { consentKey } = await recordCookieConsent(db, { ...body, personId, ip, now });
  const choices = choicesFor(body.action, body.choices);
  return Response.json(
    { consentKey },
    { status: 200, headers: { ...NO_STORE, "set-cookie": consentSetCookie({ consentKey, bannerVersion: body.bannerVersion, choices, now }) } },
  );
}
