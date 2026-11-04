/**
 * `action()`: the one way to write from a request (architecture section 3, platform spec 4.1).
 *
 * Order: resolve the session and actor for the audience (`unauthorized`), check the permission
 * before anything else runs (`forbidden`, PL-15), parse the input with Zod (`validation` with
 * fields), count the rate limit (`rate_limited`), then run the handler in one transaction with
 * a `Ctx` from `createCtx()`. A staff write gets one automatic `audit_log` row unless the
 * handler audited its own action name (PL-20). After the commit, `after()` runs exactly the
 * jobs this action enqueued (PL-34). The integration log and durable writes are flushed after
 * commit or rollback. Errors map to results by their `code`; anything else is `internal`,
 * reported to Sentry, and answered with the request id.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { ForbiddenError } from "@beam/core/errors";
import { isLocale, type Locale } from "@beam/core/i18n";
import type { Permission } from "../registry/types.generated";
import { actorFromSession, getSession, requestMeta, type SessionInfo } from "./auth";
import { actorHasPermission, createCtx, ctxState, flushDurableWrites, flushIntegrationLog, getAppDb, type Actor, type Ctx } from "./ctx";
import { runJobs } from "./job-runner";
import { reportError } from "./logger";
import { checkRateLimits, type RateLimitRequest } from "./rate-limit";
import { loadCurrentKeyVersion } from "./sensitive";

export type ActionErrorCode = "unauthorized" | "forbidden" | "validation" | "not_found" | "conflict" | "rate_limited" | "internal";

export type ActionResult<O> =
  | { ok: true; data: O }
  | { ok: false; error: { code: ActionErrorCode; message: string; fields?: Record<string, string> } };

export type AuditSpec<I, O> =
  | string
  | { entityType: string; entityId: (i: I, o: O) => string | null; personId?: (i: I, o: O) => string | null };

export type ActionAudience = "public" | "staff" | "staff_pending_mfa" | "customer" | "any_signed_in";

/** The PL-68 buckets an action counts against, from its parsed input and the client IP. */
export type ActionRateLimit<I> = (input: I, meta: { ip: string }) => RateLimitRequest;

export type ActionDefinition<I extends z.ZodTypeAny, O> = {
  name: `${string}.${string}`;
  audience: ActionAudience;
  permission?: Permission;
  input: I;
  audit?: AuditSpec<z.infer<I>, O> | false;
  rateLimit?: ActionRateLimit<z.infer<I>>;
};

const CODES = new Set<string>(["unauthorized", "forbidden", "validation", "not_found", "conflict", "rate_limited", "internal"]);

/** Budget of the post-commit run of the action's own jobs (PL-34). */
export const AFTER_BUDGET_MS = 8000;

const sessions = new WeakMap<Ctx, SessionInfo | null>();

/** The session an action runs under (for `staff_pending_mfa` handlers, whose actor is not staff yet). */
export function actionSession(ctx: Ctx): SessionInfo | null {
  return sessions.get(ctx) ?? null;
}

/** Runs the given jobs after the response (PL-34); a no-op outside a request scope. */
export function scheduleJobs(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const list = [...ids];
  try {
    after(async () => {
      try {
        await runJobs({ ids: list, budgetMs: AFTER_BUDGET_MS });
      } catch (error) {
        reportError(error, { tags: { phase: "after_jobs" } });
      }
    });
  } catch {
    // No request scope (scripts): the tick runs the jobs.
  }
}

function fieldsOf(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_";
    fields[key] ??= issue.message;
  }
  return fields;
}

function isNextControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") || digest === "NEXT_NOT_FOUND");
}

type Failure = Extract<ActionResult<never>, { ok: false }>;

const fail = (code: ActionErrorCode, message: string = code, fields?: Record<string, string>): Failure => ({
  ok: false,
  error: fields ? { code, message, fields } : { code, message },
});

/** Maps an error to its result by `error.code` (and the Zod, forbidden and unique-violation cases). */
export function errorToResult(error: unknown, ctx: { name: string; requestId: string }): Failure {
  if (error instanceof z.ZodError) return fail("validation", "validation", fieldsOf(error));
  if (error instanceof ForbiddenError) return fail("forbidden", error.message);
  const e = error as { code?: unknown; message?: string; fields?: Record<string, string>; cause?: { code?: unknown } } | null;
  if (e && typeof e.code === "string" && CODES.has(e.code) && e.code !== "internal") {
    return fail(e.code as ActionErrorCode, e.message || e.code, e.fields);
  }
  if (e && (e.code === "23505" || e.cause?.code === "23505")) return fail("conflict");
  reportError(error, { tags: { action: ctx.name, request_id: ctx.requestId } });
  return fail("internal", ctx.requestId);
}

function resolveActor(audience: ActionAudience, session: SessionInfo | null): Actor | null {
  const actor = actorFromSession(session);
  switch (audience) {
    case "public":
      return actor ?? { kind: "public" };
    case "staff":
      return actor?.kind === "staff" ? actor : null;
    case "staff_pending_mfa":
      return session?.audience === "staff" ? (actor ?? { kind: "public" }) : null;
    case "customer":
      return actor?.kind === "customer" ? actor : null;
    case "any_signed_in":
      return actor;
  }
}

function localeFor(session: SessionInfo | null, metaLocale: Locale | null, raw: unknown): Locale {
  if (session) return session.user.locale;
  const fromInput = (raw as { locale?: unknown } | null)?.locale;
  if (isLocale(fromInput)) return fromInput;
  return metaLocale ?? "nl-BE";
}

export function action<I extends z.ZodTypeAny, O>(
  def: ActionDefinition<I, O>,
  handler: (ctx: Ctx, input: z.infer<I>) => Promise<O>,
): (raw: unknown) => Promise<ActionResult<O>> {
  return async (raw: unknown): Promise<ActionResult<O>> => {
    const requestId = `req_${randomUUID()}`;
    let ctx: Ctx | undefined;
    const db = await getAppDb();
    try {
      const [session, meta] = await Promise.all([getSession(), requestMeta()]);
      const actor = resolveActor(def.audience, session);
      if (!actor) return fail("unauthorized");
      if (def.permission && !actorHasPermission(actor, def.permission)) return fail("forbidden", `forbidden: ${def.permission}`);
      const parsed = def.input.safeParse(raw ?? {});
      if (!parsed.success) return fail("validation", "validation", fieldsOf(parsed.error));
      const input = parsed.data as z.infer<I>;
      if (def.rateLimit) {
        const verdict = await checkRateLimits(db, def.rateLimit(input, { ip: meta.ip ?? "unknown" }));
        if (!verdict.ok) return fail("rate_limited", "rate_limited", { retry_after: String(verdict.retryAfterSeconds) });
      }
      const locale = localeFor(session, meta.locale, raw);
      const data = await db.transaction(async (tx) => {
        // New sensitive writes use settings.security.current_key_version, read in this transaction (PL-69).
        await loadCurrentKeyVersion(tx);
        ctx = createCtx({ tx, actor, requestId, ip: meta.ip, locale });
        sessions.set(ctx, session);
        const out = await handler(ctx, input);
        if (actor.kind === "staff" && def.audit !== false && !ctxState(ctx).auditedActions.has(def.name)) {
          const spec = def.audit;
          await ctx.audit({
            action: def.name,
            entityType: typeof spec === "object" ? spec.entityType : (spec ?? def.name.split(".")[0]!),
            entityId: typeof spec === "object" ? spec.entityId(input, out) : null,
            personId: typeof spec === "object" && spec.personId ? spec.personId(input, out) : null,
            newValue: input,
          });
        }
        return out;
      });
      const done = ctx as Ctx | undefined;
      if (done) {
        await flushIntegrationLog(db, done);
        await flushDurableWrites(db, done);
        scheduleJobs(ctxState(done).enqueuedIds);
      }
      return { ok: true, data };
    } catch (error) {
      const failed = ctx as Ctx | undefined;
      if (failed) {
        await flushIntegrationLog(db, failed).catch((e: unknown) => reportError(e));
        await flushDurableWrites(db, failed).catch((e: unknown) => reportError(e));
      }
      if (isNextControlFlow(error)) throw error;
      return errorToResult(error, { name: def.name, requestId });
    }
  };
}
