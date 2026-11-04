/**
 * Files in Postgres (`files`, PL-45 to PL-50): at most 10 MB, sha256 on store, no SVG.
 * Downloads go through `/api/public/files/[id]`: a public image is open; otherwise a signed
 * token (`signFileUrl`), a staff session with the kind's permission, or the customer the file
 * belongs to (kinds `invoice_pdf`, `receipt`, `export`).
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { Db, DbOrTx } from "@beam/db";
import { authSessions, files, roles, users, type RoleKey } from "@beam/db/schema";
import type { Permission } from "../registry/types.generated";
import { writeAuditRow } from "./audit";
import { actorHasPermission, and, eq, gt, sql, ValidationError, type Actor, type Ctx } from "./ctx";

export type FileKind = (typeof files.kind.enumValues)[number];

export const MAX_FILE_BYTES = 10_485_760;
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const DEFAULT_TTL_SECONDS = 86_400;
export const MAX_TTL_SECONDS = 604_800;

function looksLikeSvg(mime: string, name: string, bytes: Uint8Array): boolean {
  if (/svg/i.test(mime) || /\.svgz?$/i.test(name)) return true;
  const head = Buffer.from(bytes.subarray(0, 512)).toString("utf8").replace(/^\uFEFF/, "").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

/** Stores a file (PL-45, PL-50). Throws `ValidationError` above 10 MB, for SVG, or a bad image type. */
export async function storeFile(
  ctx: Ctx,
  input: { kind: FileKind; name: string; mime: string; bytes: Uint8Array; isPublic?: boolean; expiresAt?: Date; personId?: string },
): Promise<{ fileId: string; sha256: string }> {
  if (input.bytes.byteLength > MAX_FILE_BYTES) throw new ValidationError("file_too_large", { file: "too_large" });
  if (looksLikeSvg(input.mime, input.name, input.bytes)) throw new ValidationError("svg_not_allowed", { file: "type_not_allowed" });
  if (input.kind === "image" && !(IMAGE_MIMES as readonly string[]).includes(input.mime)) {
    throw new ValidationError("image_type_not_allowed", { file: "type_not_allowed" });
  }
  if (input.isPublic && input.kind !== "image") throw new ValidationError("only_images_are_public", { file: "not_public" });
  const name = input.name.replace(/[/\\]/g, "_").slice(0, 200) || "file";
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const [row] = await ctx.tx
    .insert(files)
    .values({
      kind: input.kind,
      name,
      mime: input.mime,
      sizeBytes: input.bytes.byteLength,
      bytes: input.bytes,
      sha256,
      isPublic: input.isPublic ?? false,
      expiresAt: input.expiresAt ?? null,
      personId: input.personId ?? null,
      createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
    })
    .returning({ id: files.id });
  return { fileId: row!.id, sha256 };
}

export type StoredFile = { name: string; mime: string; bytes: Uint8Array; kind: FileKind; personId: string | null };

/** Reads a file with its bytes; `null` for unknown and expired files. */
export async function readFile(tx: DbOrTx, fileId: string): Promise<StoredFile | null> {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return null;
  const rows = await tx
    .select({ name: files.name, mime: files.mime, bytes: files.bytes, kind: files.kind, personId: files.personId, expiresAt: files.expiresAt })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  const r = rows[0];
  if (!r || (r.expiresAt && r.expiresAt.getTime() <= Date.now())) return null;
  return { name: r.name, mime: r.mime, bytes: r.bytes, kind: r.kind, personId: r.personId };
}

// ---------------------------------------------------------------------------
// Signed tokens (PL-47)
// ---------------------------------------------------------------------------

function signingKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return Buffer.from(hkdfSync("sha256", secret, "", "beam-files-v1", 32));
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function fileToken(fileId: string, exp: number): string {
  const mac = createHmac("sha256", signingKey()).update(`${fileId}.${exp}`).digest();
  return `${b64url(String(exp))}.${b64url(mac)}`;
}

/** `/api/public/files/<id>?t=<token>`, valid `ttlSeconds` (default 1 day, at most 7 days). */
export function signFileUrl(fileId: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return `/api/public/files/${fileId}?t=${fileToken(fileId, exp)}`;
}

/** True when `token` was made for `fileId` and has not expired. */
export function verifyFileToken(fileId: string, token: string | null | undefined, now: Date = new Date()): boolean {
  if (!token) return false;
  const [expPart, macPart] = token.split(".");
  if (!expPart || !macPart) return false;
  const exp = Number(Buffer.from(expPart, "base64url").toString("utf8"));
  if (!Number.isInteger(exp) || exp * 1000 <= now.getTime()) return false;
  if (exp * 1000 - now.getTime() > (MAX_TTL_SECONDS + 60) * 1000) return false;
  const expected = createHmac("sha256", signingKey()).update(`${fileId}.${exp}`).digest();
  const given = Buffer.from(macPart, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Access matrix (PL-46) and responses (PL-50)
// ---------------------------------------------------------------------------

export const KIND_PERMISSION: Record<Exclude<FileKind, "image">, string> = {
  invoice_pdf: "invoices.read",
  receipt: "commerce.sell",
  import: "persons.export",
  export: "persons.export",
  rendered_email: "email.write",
  // DPIA register documents and other compliance papers (the DPIA screen needs `settings.write`).
  staff_document: "settings.write",
};

const CUSTOMER_KINDS: readonly FileKind[] = ["invoice_pdf", "receipt", "export"];

export function canDownload(
  file: { kind: FileKind; personId: string | null; isPublic: boolean },
  access: { actor: Actor | null; tokenValid: boolean },
): boolean {
  if (file.isPublic && file.kind === "image") return true;
  if (access.tokenValid) return true;
  const actor = access.actor;
  if (!actor) return false;
  if (actor.kind === "staff") return file.kind === "image" || actorHasPermission(actor, KIND_PERMISSION[file.kind] as Permission);
  if (actor.kind === "customer") return CUSTOMER_KINDS.includes(file.kind) && !!file.personId && file.personId === actor.personId;
  return false;
}

export function fileHeaders(file: { name: string; mime: string; isPublic: boolean; kind: FileKind; sizeBytes: number }): Headers {
  const h = new Headers({ "content-type": file.mime, "x-content-type-options": "nosniff", "content-length": String(file.sizeBytes) });
  if (file.isPublic && file.kind === "image") {
    h.set("cache-control", "public, max-age=31536000, immutable");
    h.set("content-disposition", `inline; filename="${encodeURIComponent(file.name)}"`);
  } else {
    h.set("cache-control", "private, no-store");
    h.set("content-disposition", `attachment; filename="${file.name.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  }
  return h;
}

export const SESSION_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

/**
 * The actor of a session cookie, for the file route: a live session row (idle and absolute
 * expiry), an active user, and for staff a completed MFA step. Permissions come from the role.
 */
export async function actorFromSessionToken(db: DbOrTx, token: string | null | undefined): Promise<Actor | null> {
  if (!token) return null;
  const rows = await db
    .select({
      userId: users.id,
      audience: users.audience,
      status: users.status,
      personId: users.personId,
      roleKey: users.roleKey,
      mfaAt: authSessions.mfaAt,
      permissions: roles.permissions,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .leftJoin(roles, eq(roles.key, users.roleKey))
    .where(and(eq(authSessions.sessionToken, token), gt(authSessions.expires, sql`now()`), gt(authSessions.absoluteExpiresAt, sql`now()`)))
    .limit(1);
  const r = rows[0];
  if (!r || r.status !== "active") return null;
  if (r.audience === "staff") {
    if (!r.mfaAt || !r.roleKey) return null;
    return { kind: "staff", userId: r.userId, roleKey: r.roleKey as RoleKey, permissions: new Set((r.permissions ?? []) as Permission[]), mfaAt: r.mfaAt };
  }
  return r.personId ? { kind: "customer", userId: r.userId, personId: r.personId } : null;
}

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

/** The whole download route (PL-46, PL-50): 404 for unknown, expired and denied files (no existence leak). */
export async function serveFile(db: Db, input: { fileId: string; token: string | null; sessionToken: string | null; ip?: string | null }): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.fileId)) return notFound();
  const rows = await db
    .select({ id: files.id, name: files.name, mime: files.mime, kind: files.kind, personId: files.personId, isPublic: files.isPublic, sizeBytes: files.sizeBytes, expiresAt: files.expiresAt })
    .from(files)
    .where(eq(files.id, input.fileId))
    .limit(1);
  const meta = rows[0];
  if (!meta || (meta.expiresAt && meta.expiresAt.getTime() <= Date.now())) return notFound();
  const tokenValid = verifyFileToken(meta.id, input.token);
  const actor = meta.isPublic || tokenValid ? null : await actorFromSessionToken(db, input.sessionToken);
  if (!canDownload(meta, { actor, tokenValid })) return notFound();
  const [body] = await db.select({ bytes: files.bytes }).from(files).where(eq(files.id, meta.id));
  if (meta.kind === "export") {
    await writeAuditRow(
      db,
      { actor: actor?.kind === "staff" ? { kind: "staff", id: actor.userId, roleKey: actor.roleKey } : actor?.kind === "customer" ? { kind: "customer", id: actor.userId } : { kind: "system", id: null }, ip: input.ip ?? null },
      { action: "files.downloaded", entityType: "file", entityId: meta.id, personId: meta.personId, newValue: { kind: meta.kind, via: tokenValid ? "token" : "session" } },
    );
  }
  return new Response(new Uint8Array(body!.bytes), { status: 200, headers: fileHeaders(meta) });
}

/** PL-48: deletes expired files, 100 rows per statement. Returns the number deleted. */
export async function purgeExpiredFiles(tx: DbOrTx, maxRounds = 1000): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxRounds; i++) {
    const deleted = await tx
      .delete(files)
      .where(sql`${files.id} in (select id from files where expires_at is not null and expires_at < now() limit 100)`)
      .returning({ id: files.id });
    total += deleted.length;
    if (deleted.length < 100) break;
  }
  return total;
}

