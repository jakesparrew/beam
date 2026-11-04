// Review fixes of fix-w09-platform-review: the `staff_document` files kind (request of ops-P6).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { files } from "@beam/db/schema";
import { eq } from "./ctx";
import { canDownload, KIND_PERMISSION, readFile, storeFile } from "./files";
import { makeCtx, resetRuntime, staffActor } from "./testing";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

describe("files kind staff_document", () => {
  it("is downloaded by settings.write staff only, never by a customer", () => {
    expect(KIND_PERMISSION.staff_document).toBe("settings.write");
    const doc = (personId: string | null = null) => ({ kind: "staff_document" as const, personId, isPublic: false });
    expect(canDownload(doc(), { actor: staffActor({ permissions: ["settings.write"] }), tokenValid: false })).toBe(true);
    expect(canDownload(doc(), { actor: staffActor({ permissions: ["persons.export", "invoices.read"] }), tokenValid: false })).toBe(false);
    expect(canDownload(doc(), { actor: null, tokenValid: false })).toBe(false);
    expect(canDownload(doc(), { actor: null, tokenValid: true })).toBe(true);
    const me = crypto.randomUUID();
    expect(canDownload(doc(me), { actor: { kind: "customer", userId: crypto.randomUUID(), personId: me }, tokenValid: false })).toBe(false);
  });

  it("stores a PDF of that kind without an expiry", async () => {
    const user = await makeUser(handle.db, { roleKey: "owner" });
    const ctx = makeCtx(handle.db, staffActor({ userId: user.id, permissions: ["settings.write"] }));
    const bytes = Buffer.from("%PDF-1.7 dpia register");
    const { fileId } = await storeFile(ctx, { kind: "staff_document", name: "dpia-register.pdf", mime: "application/pdf", bytes });
    const [row] = await handle.db.select({ kind: files.kind, expiresAt: files.expiresAt }).from(files).where(eq(files.id, fileId));
    expect(row).toEqual({ kind: "staff_document", expiresAt: null });
    expect((await readFile(handle.db, fileId))?.kind).toBe("staff_document");
  });
});
