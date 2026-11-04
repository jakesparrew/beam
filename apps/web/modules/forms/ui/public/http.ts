/**
 * The plumbing of forms' public route handlers (forms spec section 4 "Route handlers", rules R1,
 * R4 and the ownership proof). `handlePublic(req, fn)`:
 *
 * - counts the request in platform's per-IP `forms` bucket (R1, 20 per minute; the WAF limits in
 *   front of it too) with the client IP from the first `x-forwarded-for` entry;
 * - refuses a body above 64 KB with `413` (R4) and unparsable JSON with `400 validation`;
 * - resolves a customer session from the request's session cookie (ID1), every other caller is
 *   the public actor;
 * - runs `fn` in one transaction with a `Ctx` (events, consent and the result email are written
 *   in it, E4), then flushes the integration log and durable writes and runs the jobs it enqueued
 *   after the response (PL-34);
 * - maps errors to `{ ok: false, error: { code, message, fields? } }` with their status:
 *   `400 validation`, `404 not_found`, `409 conflict`, `410 form_closed`, `413`, `429
 *   rate_limited` with `retry-after`, `500 internal` (reported with tags `form_slug` and `route`,
 *   ids only).
 *
 * The `fsid` cookie (`HttpOnly; Secure; SameSite=None`, 24 hours) carries the HMAC-signed
 * submission id set by `start`; it is one of the proofs of ownership on save and submit.
 */
import "server-only";
import { z } from "zod";
import { isLocale, type Locale } from "@beam/core/i18n";
import { forms, formSubmissions, formVersions } from "@beam/db/schema";
import { scheduleJobs } from "@/lib/action";
import { actorFromSession, loadSession } from "@/lib/auth";
import { createCtx, ctxState, eq, flushDurableWrites, flushIntegrationLog, getAppDb, NotFoundError, type Actor, type Ctx, type Db, type Tx } from "@/lib/ctx";
import { SESSION_COOKIE_NAMES } from "@/lib/files";
import { reportError } from "@/lib/logger";
import { limitApiRequest } from "@/lib/rate-limit";
import { loadCurrentKeyVersion } from "@/lib/sensitive";
import { getPerson } from "@/modules/crm/api";
import type { Answers, FormDefinition } from "@beam/core/forms";
import { buildPrefill } from "../../service/identity";
import { FormClosedError } from "../../service/submissions";
import { signSubmissionId } from "../../service/tokens";
import { parseVersion } from "../../service/versions";

/** R4: request bodies above 64 KB answer `413`. */
export const BODY_LIMIT_BYTES = 64 * 1024;
/** The ownership cookie set by `start`. */
export const FSID_COOKIE = "fsid";
export const FSID_MAX_AGE_SECONDS = 24 * 60 * 60;

export const NO_STORE = { "cache-control": "no-store" } as const;

export type PublicCall = {
  req: Request;
  tx: Tx;
  ctx: Ctx;
  ip: string;
  userAgent: string;
  /** The parsed JSON body (`undefined` for a request without one). */
  body: unknown;
  cookie: (name: string) => string | null;
  /** Adds a `set-cookie` header to the response. */
  setCookie: (value: string) => void;
};

export type HandleOptions = {
  /** Route name for error reports (`start`, `save`, ...). */
  route: string;
  /** The form slug for error reports. */
  slug?: string;
  /** Read and parse a JSON body (default true for POST). */
  body?: boolean;
};

/** `{ ok: false, error }` with a status. */
export function errorResponse(status: number, code: string, message: string = code, fields?: Record<string, string>, headers: Record<string, string> = {}): Response {
  return Response.json({ ok: false, error: fields ? { code, message, fields } : { code, message } }, { status, headers: { ...NO_STORE, ...headers } });
}

/** The client IP: the first `x-forwarded-for` entry (Vercel), then `x-real-ip`. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** One cookie of the request's `cookie` header. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** The `fsid` cookie for a submission (`HttpOnly; Secure; SameSite=None`, 24 hours). */
export function fsidCookie(submissionId: string): string {
  return `${FSID_COOKIE}=${encodeURIComponent(signSubmissionId(submissionId))}; Path=/api/public/forms; Max-Age=${FSID_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=None`;
}

/** The actor of the request: a customer session (ID1), else public. */
async function actorOf(db: Db, req: Request): Promise<Actor> {
  for (const name of SESSION_COOKIE_NAMES) {
    const token = readCookie(req, name);
    if (!token) continue;
    try {
      const actor = actorFromSession(await loadSession(db, token));
      if (actor?.kind === "customer") return actor;
    } catch {
      // An unreadable session is the public actor.
    }
  }
  return { kind: "public" };
}

const STATUS: Record<string, number> = { validation: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, rate_limited: 429 };

/** Maps a thrown error to the JSON error response of section 4. */
export function toErrorResponse(error: unknown, o: { route: string; slug?: string; requestId?: string }): Response {
  if (error instanceof FormClosedError) return errorResponse(410, "form_closed");
  if (error instanceof z.ZodError) {
    const fields: Record<string, string> = {};
    for (const i of error.issues) fields[i.path.map(String).join(".") || "body"] ??= i.message;
    return errorResponse(400, "validation", "validation", fields);
  }
  const e = error as { code?: unknown; message?: string; fields?: Record<string, string>; retryAfterSeconds?: number } | null;
  const code = typeof e?.code === "string" ? e.code : null;
  if (code && code in STATUS) {
    const headers: Record<string, string> = {};
    if (code === "rate_limited") headers["retry-after"] = String(Math.max(1, Math.ceil(e?.retryAfterSeconds ?? 60)));
    return errorResponse(STATUS[code]!, code, e?.message || code, e?.fields, headers);
  }
  reportError(error, { tags: { module: "forms", route: o.route, ...(o.slug ? { form_slug: o.slug } : {}), ...(o.requestId ? { request_id: o.requestId } : {}) } });
  return errorResponse(500, "internal", o.requestId ?? "internal");
}

/** R4 and JSON parsing; `null` body for an empty request. */
async function readBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) return { ok: false, response: errorResponse(413, "payload_too_large") };
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > BODY_LIMIT_BYTES) return { ok: false, response: errorResponse(413, "payload_too_large") };
  if (buf.byteLength === 0) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(buf)) as unknown };
  } catch {
    return { ok: false, response: errorResponse(400, "validation", "invalid_json") };
  }
}

/**
 * Runs one public forms request (see the file comment). `fn` returns a `Response` or a JSON
 * value (answered `200` with `cache-control: no-store`).
 */
export async function handlePublic(req: Request, fn: (call: PublicCall) => Promise<unknown>, opts: HandleOptions = { route: "public" }): Promise<Response> {
  const ip = clientIp(req);
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300);
  let db: Db;
  try {
    db = await getAppDb();
    const limited = await limitApiRequest(db, { pathname: new URL(req.url).pathname, ip });
    if (limited) return limited;
  } catch (error) {
    return toErrorResponse(error, opts);
  }
  let body: unknown;
  if (opts.body ?? req.method === "POST") {
    const r = await readBody(req);
    if (!r.ok) return r.response;
    body = r.body;
  }
  const cookies: string[] = [];
  let ctx: Ctx | undefined;
  try {
    const actor = await actorOf(db, req);
    const locale = (body as { locale?: unknown } | undefined)?.locale;
    const out = await db.transaction(async (tx) => {
      await loadCurrentKeyVersion(tx);
      ctx = createCtx({ tx, actor, ip, ...(isLocale(locale) ? { locale: locale as Locale } : {}) });
      return fn({ req, tx, ctx, ip, userAgent, body, cookie: (name) => readCookie(req, name), setCookie: (v) => cookies.push(v) });
    });
    const done = ctx as Ctx | undefined;
    if (done) {
      await flushIntegrationLog(db, done);
      await flushDurableWrites(db, done);
      scheduleJobs(ctxState(done).enqueuedIds);
    }
    const res = out instanceof Response ? out : Response.json(out ?? { ok: true }, { status: 200, headers: NO_STORE });
    for (const c of cookies) res.headers.append("set-cookie", c);
    return res;
  } catch (error) {
    const failed = ctx as Ctx | undefined;
    if (failed) {
      await flushIntegrationLog(db, failed).catch((e: unknown) => reportError(e));
      await flushDurableWrites(db, failed).catch((e: unknown) => reportError(e));
    }
    return toErrorResponse(error, { ...opts, ...(failed ? { requestId: failed.requestId } : {}) });
  }
}

/** Parses a body with a Zod schema (throws `ZodError`, answered `400 validation`). */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  return schema.parse(body ?? {}) as z.infer<S>;
}

/** The pinned definition of a submission of this slug; `404` for another form's submission. */
export async function submissionDefinition(tx: Tx, submissionId: string, slug: string): Promise<FormDefinition> {
  if (!z.uuid().safeParse(submissionId).success) throw new NotFoundError("submission_not_found");
  const [row] = await tx
    .select({ slug: forms.slug, v: formVersions })
    .from(formSubmissions)
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .where(eq(formSubmissions.id, submissionId));
  if (!row || row.slug !== slug) throw new NotFoundError("submission_not_found");
  return parseVersion(row.v).definition;
}

/** Answers sent by the browser: an object of field keys (values are checked per type by the service, U9). */
export const AnswersBody = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.unknown()).refine((a) => Object.keys(a).length <= 250, "too_many_answers");

/**
 * ID2: known fields hidden by `skipKnownFields` are not sent back by the browser (it only shows
 * first name and masked email), so save and submit fill them from the identified person.
 * Only for a submission identified by session, token or staff; a value the visitor sent wins.
 */
export async function withKnownAnswers(tx: Tx, submissionId: string, def: FormDefinition, answers: Answers): Promise<Answers> {
  const [sub] = await tx
    .select({ personId: formSubmissions.personId, identifiedBy: formSubmissions.identifiedBy })
    .from(formSubmissions)
    .where(eq(formSubmissions.id, submissionId));
  if (!sub?.personId || !["session", "token", "staff"].includes(sub.identifiedBy) || !def.settings.skipKnownFields) return answers;
  const prefill = await buildPrefill(tx, def, sub.personId);
  const out: Answers = { ...answers };
  for (const key of prefill.known) {
    if (out[key] !== undefined && out[key] !== "") continue;
    const f = def.fields[key];
    if (f?.mapsTo === "person.email") {
      const p = await getPerson(tx, sub.personId);
      if (p?.email) out[key] = p.email;
    } else if (prefill.values[key]) out[key] = prefill.values[key]!;
  }
  return out;
}
