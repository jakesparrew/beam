/**
 * Plumbing of the assistant's public routes: same-origin only, a 32 KB body cap, the PL-68 API
 * limit, the visitor token from `x-assistant-token`, a customer session when there is one, and
 * transactions that write timeline events, jobs and durable rows like every other public route.
 */
import "server-only";
import type { z } from "zod";
import { scheduleJobs } from "@/lib/action";
import { actorFromSession, loadSession } from "@/lib/auth";
import { createCtx, ctxState, flushDurableWrites, flushIntegrationLog, getAppDb, type Actor, type Ctx, type Db, type Tx } from "@/lib/ctx";
import { SESSION_COOKIE_NAMES } from "@/lib/files";
import { reportError } from "@/lib/logger";
import { limitApiRequest } from "@/lib/rate-limit";
import { loadCurrentKeyVersion } from "@/lib/sensitive";

export const NO_STORE = { "cache-control": "no-store" } as const;
const BODY_LIMIT = 32 * 1024;

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: NO_STORE });
export const fail = (status: number, code: string) => json({ ok: false, error: code }, status);

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export function visitorToken(req: Request): string | null {
  return req.headers.get("x-assistant-token")?.trim() || null;
}

/** Browsers send `Origin` on every POST from a page; it must be this site. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The signed-in customer of the request, else the public actor. */
export async function actorOf(db: Db, req: Request): Promise<Actor> {
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

export async function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S> | null> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > BODY_LIMIT) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(buf)));
    return parsed.success ? (parsed.data as z.infer<S>) : null;
  } catch {
    return null;
  }
}

/** Origin check, API limit, database and actor: the first lines of every assistant route. */
export async function openRequest(req: Request): Promise<{ ok: true; db: Db; actor: Actor; ip: string } | { ok: false; response: Response }> {
  if (!sameOrigin(req)) return { ok: false, response: fail(403, "origin") };
  const ip = clientIp(req);
  const db = await getAppDb();
  const limited = await limitApiRequest(db, { pathname: new URL(req.url).pathname, ip });
  if (limited) return { ok: false, response: limited };
  return { ok: true, db, actor: await actorOf(db, req), ip };
}

/** One transaction with a request ctx; events, durable rows and jobs are flushed after commit. */
export async function inTx<T>(db: Db, actor: Actor, ip: string, fn: (tx: Tx, ctx: Ctx) => Promise<T>): Promise<T> {
  let ctx: Ctx | undefined;
  try {
    const out = await db.transaction(async (tx) => {
      await loadCurrentKeyVersion(tx);
      ctx = createCtx({ tx, actor, ip });
      return fn(tx, ctx);
    });
    const done = ctx as Ctx | undefined;
    if (done) {
      await flushIntegrationLog(db, done);
      await flushDurableWrites(db, done);
      scheduleJobs(ctxState(done).enqueuedIds);
    }
    return out;
  } catch (error) {
    const failed = ctx as Ctx | undefined;
    if (failed) await flushDurableWrites(db, failed).catch((e: unknown) => reportError(e));
    throw error;
  }
}
