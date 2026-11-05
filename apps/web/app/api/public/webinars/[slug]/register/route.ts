/**
 * `POST /api/public/webinars/[slug]/register` (webinar spec 4.4, rules 14 and 18): the site
 * registration form. `{ email, firstName, lastName?, locale, consents, wordingVersion, utm,
 * website }` -> always `202 { ok: true }` once the body is valid, whether the person is new,
 * already registered or blocked (no account enumeration). A filled honeypot (`website`) answers
 * 202 and writes nothing. 20 requests per IP per minute on top of the 60/min `/api/*` rule.
 *
 * In one transaction: the person (`crm.findOrCreatePersonByEmail`, acquisition `webinar` with
 * `referral_code` from `site.readReferralCode()` when the `beam_ref` cookie holds one), the
 * registration (source `site`), `webinar.registered`, the ticked consents and the access email
 * (outbox). A closed webinar answers `409 webinar.register.closed`; an unknown or non-public slug
 * `404`. Viewer data (tokens, emails) never reaches the logs.
 */
import { z } from "zod";
import { PublicRegisterInput } from "@beam/core/webinar";
import { scheduleJobs } from "@/lib/action";
import { createCtx, ctxState, flushDurableWrites, flushIntegrationLog, getAppDb, type Ctx } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { limitApiRequest } from "@/lib/rate-limit";
import { loadCurrentKeyVersion } from "@/lib/sensitive";
import { readReferralCode } from "@/modules/site/api";
import { findPublicWebinarBySlug, limitPublicRegistration, registerByEmail, REGISTER_ERRORS } from "@/modules/webinar/server/registration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const error = (status: number, code: string, message: string = code) => json(status, { ok: false, error: { code, message } });

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

function cookieReader(req: Request): { get(name: string): { value: string } | undefined } {
  const header = req.headers.get("cookie") ?? "";
  return {
    get(name) {
      for (const part of header.split(";")) {
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

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const ip = clientIp(req);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return error(400, "validation", "invalid_json");
  }
  if (raw && typeof raw === "object" && typeof (raw as { website?: unknown }).website === "string" && (raw as { website: string }).website.length > 0) {
    return json(202, { ok: true });
  }
  const parsed = PublicRegisterInput.safeParse(raw);
  if (!parsed.success) return json(400, { ok: false, error: { code: "validation", message: "validation", fields: z.flattenError(parsed.error).fieldErrors } });
  const input = parsed.data;

  const db = await getAppDb();
  const limited = await limitApiRequest(db, { pathname: new URL(req.url).pathname, ip });
  if (limited) return limited;
  if (!(await limitPublicRegistration(db, ip))) return error(429, "rate_limited");

  const referralCode = readReferralCode(cookieReader(req), new URL(req.url).searchParams);
  let ctx: Ctx | undefined;
  try {
    const outcome = await db.transaction(async (tx) => {
      await loadCurrentKeyVersion(tx);
      ctx = createCtx({ tx, actor: { kind: "public" }, ip, locale: input.locale });
      const w = await findPublicWebinarBySlug(tx, slug);
      if (!w) return "not_found" as const;
      await registerByEmail(tx, ctx, w, {
        email: input.email,
        firstName: input.firstName,
        ...(input.lastName ? { lastName: input.lastName } : {}),
        locale: input.locale,
        consents: input.consents,
        wordingVersion: input.wordingVersion,
        utm: input.utm,
        referralCode,
      });
      return "ok" as const;
    });
    const done = ctx;
    if (done) {
      await flushIntegrationLog(db, done);
      await flushDurableWrites(db, done);
      scheduleJobs(ctxState(done).enqueuedIds);
    }
    if (outcome === "not_found") return error(404, "not_found", "webinar_not_found");
    return json(202, { ok: true });
  } catch (e) {
    const failed = ctx;
    if (failed) {
      await flushIntegrationLog(db, failed).catch((x: unknown) => reportError(x));
      await flushDurableWrites(db, failed).catch((x: unknown) => reportError(x));
    }
    const code = (e as { code?: string } | null)?.code;
    const message = (e as Error | null)?.message ?? "";
    if (message === REGISTER_ERRORS.closed) return error(409, "conflict", REGISTER_ERRORS.closed);
    if (code === "validation") return error(400, "validation", message);
    reportError(e, { tags: { module: "webinar", route: "register" } });
    return error(500, "internal", ctx?.requestId ?? "internal");
  }
}
