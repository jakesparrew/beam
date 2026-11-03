import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, authSessions, files } from "@beam/db/schema";
import { filesSizeLevel as filesSizeLevelFor, GB } from "./alerts";
import { eq, sql, ValidationError } from "./ctx";
import {
  canDownload,
  fileToken,
  MAX_FILE_BYTES,
  purgeExpiredFiles,
  readFile,
  serveFile,
  signFileUrl,
  storeFile,
  verifyFileToken,
} from "./files";
import { makeCtx, resetRuntime, staffActor } from "./testing";
import { GET } from "../app/api/public/files/[id]/route";

let handle: DbHandle;
beforeAll(async () => {
  process.env.AUTH_SECRET ??= "test-auth-secret-for-vitest-only";
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const tokenOf = (url: string) => new URL(url, "http://x").searchParams.get("t");

describe("storeFile (PL-45, PL-50)", () => {
  it("stores bytes with their sha256", async () => {
    const ctx = makeCtx(handle.db);
    const { fileId, sha256 } = await storeFile(ctx, { kind: "export", name: "export.csv", mime: "text/csv", bytes: new TextEncoder().encode("a,b\n") });
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const read = await readFile(handle.db, fileId);
    expect(read).toMatchObject({ name: "export.csv", mime: "text/csv", kind: "export", personId: null });
    expect(new TextDecoder().decode(read!.bytes)).toBe("a,b\n");
  });

  it("refuses 10 MB + 1 byte, and SVG by type, name or content", async () => {
    const ctx = makeCtx(handle.db);
    await expect(storeFile(ctx, { kind: "import", name: "big.csv", mime: "text/csv", bytes: new Uint8Array(MAX_FILE_BYTES + 1) })).rejects.toBeInstanceOf(ValidationError);
    await expect(storeFile(ctx, { kind: "image", name: "a.svg", mime: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") })).rejects.toThrow(/svg/);
    await expect(storeFile(ctx, { kind: "import", name: "a.txt", mime: "text/plain", bytes: new TextEncoder().encode("  <svg onload=x>") })).rejects.toThrow(/svg/);
    expect(await handle.db.select({ id: files.id }).from(files).where(eq(files.name, "big.csv"))).toHaveLength(0);
  });

  it("accepts exactly 10 MB", async () => {
    const ctx = makeCtx(handle.db);
    await expect(storeFile(ctx, { kind: "import", name: "max.bin", mime: "application/octet-stream", bytes: new Uint8Array(MAX_FILE_BYTES) })).resolves.toBeTruthy();
  });
});

describe("signed tokens (PL-47)", () => {
  it("is valid for its file until it expires", () => {
    const id = crypto.randomUUID();
    const url = signFileUrl(id, 60);
    expect(url.startsWith(`/api/public/files/${id}?t=`)).toBe(true);
    expect(verifyFileToken(id, tokenOf(url))).toBe(true);
    expect(verifyFileToken(id, tokenOf(url), new Date(Date.now() + 61_000))).toBe(false);
  });

  it("does not open another file and rejects tampering", () => {
    const id = crypto.randomUUID();
    const t = tokenOf(signFileUrl(id))!;
    expect(verifyFileToken(crypto.randomUUID(), t)).toBe(false);
    expect(verifyFileToken(id, `${t.slice(0, -2)}xx`)).toBe(false);
    expect(verifyFileToken(id, null)).toBe(false);
  });

  it("caps the lifetime at 7 days", () => {
    const id = crypto.randomUUID();
    const t = tokenOf(signFileUrl(id, 30 * 86_400))!;
    expect(verifyFileToken(id, t, new Date(Date.now() + 7 * 86_400_000 - 5000))).toBe(true);
    expect(verifyFileToken(id, t, new Date(Date.now() + 7 * 86_400_000 + 5000))).toBe(false);
    const forged = fileToken(id, Math.floor(Date.now() / 1000) + 30 * 86_400);
    expect(verifyFileToken(id, forged)).toBe(false);
  });
});

describe("access matrix (PL-46)", () => {
  const staff = (permissions: string[]) => staffActor({ permissions });
  const customer = (personId: string) => ({ kind: "customer" as const, userId: crypto.randomUUID(), personId });
  const f = (kind: Parameters<typeof canDownload>[0]["kind"], personId: string | null = null, isPublic = false) => ({ kind, personId, isPublic });

  it("public images are open, private files need a token or a session", () => {
    expect(canDownload(f("image", null, true), { actor: null, tokenValid: false })).toBe(true);
    expect(canDownload(f("image"), { actor: null, tokenValid: false })).toBe(false);
    expect(canDownload(f("invoice_pdf"), { actor: null, tokenValid: true })).toBe(true);
  });

  it("staff need the kind's permission", () => {
    expect(canDownload(f("invoice_pdf"), { actor: staff(["invoices.read"]), tokenValid: false })).toBe(true);
    expect(canDownload(f("invoice_pdf"), { actor: staff(["commerce.sell"]), tokenValid: false })).toBe(false);
    expect(canDownload(f("receipt"), { actor: staff(["commerce.sell"]), tokenValid: false })).toBe(true);
    expect(canDownload(f("import"), { actor: staff(["persons.export"]), tokenValid: false })).toBe(true);
    expect(canDownload(f("export"), { actor: staff(["persons.read"]), tokenValid: false })).toBe(false);
    expect(canDownload(f("rendered_email"), { actor: staff(["email.write"]), tokenValid: false })).toBe(true);
    expect(canDownload(f("image"), { actor: staff([]), tokenValid: false })).toBe(true);
    expect(canDownload(f("export"), { actor: staff(["*"]), tokenValid: false })).toBe(true);
  });

  it("a customer sees only their own invoices, receipts and exports", () => {
    const me = crypto.randomUUID();
    for (const kind of ["invoice_pdf", "receipt", "export"] as const) {
      expect(canDownload(f(kind, me), { actor: customer(me), tokenValid: false })).toBe(true);
      expect(canDownload(f(kind, crypto.randomUUID()), { actor: customer(me), tokenValid: false })).toBe(false);
    }
    expect(canDownload(f("rendered_email", me), { actor: customer(me), tokenValid: false })).toBe(false);
    expect(canDownload(f("import", me), { actor: customer(me), tokenValid: false })).toBe(false);
  });
});

describe("the download route (PL-46, PL-50)", () => {
  const get = (id: string, query = "", cookie?: string) =>
    GET(new Request(`http://localhost/api/public/files/${id}${query}`, cookie ? { headers: { cookie } } : {}), { params: Promise.resolve({ id }) });

  it("serves a public image immutable and inline", async () => {
    const ctx = makeCtx(handle.db);
    const { fileId } = await storeFile(ctx, { kind: "image", name: "logo.png", mime: "image/png", bytes: png, isPublic: true });
    const res = await get(fileId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  it("serves a private file with a token as a no-store attachment", async () => {
    const ctx = makeCtx(handle.db);
    const { fileId } = await storeFile(ctx, { kind: "invoice_pdf", name: "F-2026-0001.pdf", mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) });
    expect((await get(fileId)).status).toBe(404);
    const res = await get(fileId, `?t=${tokenOf(signFileUrl(fileId))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("opens a file for a staff session with the permission and audits export downloads", async () => {
    const ctx = makeCtx(handle.db);
    const person = await makePerson(handle.db);
    const { fileId } = await storeFile(ctx, { kind: "export", name: "gdpr.zip", mime: "application/zip", bytes: randomBytes(16), personId: person.id });
    const user = await makeUser(handle.db, { roleKey: "owner" });
    await handle.db.execute(sql`update roles set permissions = '{*}' where key = 'owner'`);
    const token = randomBytes(32).toString("base64url");
    const later = new Date(Date.now() + 3_600_000);
    await handle.db.insert(authSessions).values({ sessionToken: token, userId: user.id, audience: "staff", expires: later, absoluteExpiresAt: later, mfaAt: new Date() });
    const res = await get(fileId, "", `authjs.session-token=${token}`);
    expect(res.status).toBe(200);
    const audits = await handle.db.select().from(auditLog).where(eq(auditLog.action, "files.downloaded"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityId: fileId, personId: person.id });

    const pending = randomBytes(32).toString("base64url");
    await handle.db.insert(authSessions).values({ sessionToken: pending, userId: user.id, audience: "staff", expires: later, absoluteExpiresAt: later });
    expect((await get(fileId, "", `authjs.session-token=${pending}`)).status).toBe(404);
  });

  it("answers 404 for unknown, malformed and expired files", async () => {
    const ctx = makeCtx(handle.db);
    const { fileId } = await storeFile(ctx, { kind: "image", name: "old.png", mime: "image/png", bytes: png, isPublic: true, expiresAt: new Date(Date.now() - 1000) });
    expect((await get(fileId)).status).toBe(404);
    expect((await get(crypto.randomUUID())).status).toBe(404);
    expect((await serveFile(handle.db, { fileId: "../etc", token: null, sessionToken: null })).status).toBe(404);
  });
});

describe("files.purge_expired and size (PL-48, PL-49)", () => {
  it("deletes only expired rows", async () => {
    const ctx = makeCtx(handle.db);
    const old = await storeFile(ctx, { kind: "export", name: "old.csv", mime: "text/csv", bytes: png, expiresAt: new Date(Date.now() - 60_000) });
    const fresh = await storeFile(ctx, { kind: "export", name: "new.csv", mime: "text/csv", bytes: png, expiresAt: new Date(Date.now() + 60_000) });
    const forever = await storeFile(ctx, { kind: "invoice_pdf", name: "keep.pdf", mime: "application/pdf", bytes: png });
    expect(await purgeExpiredFiles(handle.db)).toBeGreaterThanOrEqual(1);
    const ids = (await handle.db.select({ id: files.id }).from(files)).map((r) => r.id);
    expect(ids).not.toContain(old.fileId);
    expect(ids).toEqual(expect.arrayContaining([fresh.fileId, forever.fileId]));
  });

  it("4 GB + 1 is a digest warning, 5 GB + 1 an alert", () => {
    expect(filesSizeLevelFor(4 * GB)).toBe("ok");
    expect(filesSizeLevelFor(4 * GB + 1)).toBe("warn");
    expect(filesSizeLevelFor(5 * GB + 1)).toBe("alert");
  });
});
