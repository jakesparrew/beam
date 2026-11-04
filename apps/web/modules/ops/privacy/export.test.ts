/**
 * Rule 60 (ops-P5): the subject export. One JSON and CSVs per registered module, `sensitive.json`,
 * `README.txt` in the person's locale; parts above 9 MB; stored encrypted, decryptable with the
 * key; 7-day expiry; only the subject (or `privacy.run` staff) downloads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { files, personSensitiveFields, retentionPolicies } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { PRIVACY_EXPORT_EXPIRY_DAYS, PRIVACY_EXPORT_PART_BYTES } from "@beam/core/ops";

const jar = new Map<string, string>();
vi.mock("next/headers", async () => (await import("./ops-p5.fixtures")).headersMock(jar));
vi.mock("next/server", () => ({ after: () => undefined }));

const { eq, inArray, setAppDb } = await import("@/lib/ctx");
const { encryptSensitive, sensitiveAad } = await import("@/lib/sensitive");
const { makeCtx, makeJobCtx, resetRuntime, staffActor } = await import("@/lib/testing");
const { GDPR_REGISTRY } = await import("@/registry/privacy.generated");
const o = await import("./orchestrator");
const z = await import("./export-zip");
const portalDownload = await import("@/app/[locale]/(portal)/account/privacy/[id]/download/route");
const adminDownload = await import("@/app/(admin)/admin/privacy/[id]/download/route");
const { drainPrivacy, requestOf, signInCustomer, signInStaffWith, unzip, useTestKey } = await import("./ops-p5.fixtures");

let h: DbHandle;
let staffId: string;
beforeAll(async () => {
  useTestKey();
  h = await createTestDb();
  setAppDb(h.db);
  staffId = (await makeUser(h.db)).id;
  await h.db.insert(retentionPolicies).values([{ key: "platform.ai_requests", tableName: "ai_requests", days: 30, action: "delete", description: "AI request log" }]).onConflictDoNothing();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

const staff = () => makeCtx(h.db, staffActor({ userId: staffId, permissions: ["privacy.run", "persons.export"] }));
const portalGet = (id: string) => portalDownload.GET(new Request(`http://localhost/fr/account/privacy/${id}/download`), { params: Promise.resolve({ locale: "fr", id }) });
const adminGet = (id: string) => adminDownload.GET(new Request(`http://localhost/admin/privacy/${id}/download`), { params: Promise.resolve({ id }) });

async function exportFor(personId: string) {
  const r = await o.createRequest(staff(), { personId, kind: "export", requestedBy: "staff" });
  await o.verifyRequest(staff(), { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: false });
  await drainPrivacy(h.db);
  return requestOf(h.db, r.id);
}

describe("subject export", () => {
  it("zips one JSON and the CSVs per module, sensitive.json and a README in the person's locale", async () => {
    const { person } = await signInCustomer(h.db, jar, { locale: "fr-BE", email: "export-subject@example.com" });
    const enc = encryptSensitive("sleeps badly", sensitiveAad.personField(person.id, "sleep"));
    await h.db.insert(personSensitiveFields).values({ personId: person.id, key: "sleep", valueEnc: enc.valueEnc, keyVersion: enc.keyVersion });
    const row = await exportFor(person.id);
    expect(row.status).toBe("done");
    expect(row.fileId).not.toBeNull();

    const res = await portalGet(row.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const entries = unzip(new Uint8Array(await res.arrayBuffer()));
    const names = entries.map((e) => e.name);
    for (const m of Object.keys(GDPR_REGISTRY)) expect(names, m).toContain(`${m}.json`);
    expect(names.some((n) => n.startsWith("crm/") && n.endsWith(".csv"))).toBe(true);
    expect(names).toContain("sensitive.json");
    const sensitive = JSON.parse(entries.find((e) => e.name === "sensitive.json")!.text) as { fields: Record<string, string> };
    expect(sensitive.fields.sleep).toBe("sleeps badly");
    expect(entries.find((e) => e.name === "crm.json")!.text).toContain("export-subject@example.com");

    const readme = entries.find((e) => e.name === "README.txt")!.text;
    expect(readme).toContain("Autorité de protection des données");
    expect(readme).toContain("https://www.dataprotectionauthority.be");
    expect(readme).toContain("Neon"); // recipients
    expect(readme).toContain("ai_requests"); // retention periods
    expect(readme).toContain("manual"); // source (acquisition.source)
    expect(readme).not.toContain("⟦"); // every label resolved in fr-BE (tests throw on a missing key anyway)
  });

  it("stores the parts encrypted with a 7-day expiry; they decrypt with the key and not with another", async () => {
    const p = await makePerson(h.db, { email: "encrypted-subject@example.com" });
    const row = await exportFor(p.id);
    const ids = [row.fileId!, ...row.partFileIds];
    const stored = await h.db.select().from(files).where(inArray(files.id, ids));
    for (const f of stored) {
      expect(Buffer.from(f.bytes).toString("latin1")).not.toContain("encrypted-subject@example.com");
      expect(f).toMatchObject({ kind: "export", personId: p.id, isPublic: false });
      const days = (f.expiresAt!.getTime() - row.completedAt!.getTime()) / 86_400_000;
      expect(Math.round(days)).toBe(PRIVACY_EXPORT_EXPIRY_DAYS);
    }
    const plain = z.decryptPart(stored.find((f) => f.id === row.fileId)!.bytes, z.partAad(row.id, 0));
    expect(Buffer.from(plain).toString("latin1")).toContain("encrypted-subject@example.com");
    const saved = process.env.SENSITIVE_DATA_KEY_V1;
    process.env.SENSITIVE_DATA_KEY_V1 = Buffer.alloc(32, 9).toString("base64");
    expect(() => z.decryptPart(stored[0]!.bytes, z.partAad(row.id, 0))).toThrow(/decrypt_failed/);
    process.env.SENSITIVE_DATA_KEY_V1 = saved;
  });

  it("splits a zip above the part size into parts and streams it back intact (9 MB in production)", async () => {
    expect(PRIVACY_EXPORT_PART_BYTES).toBe(9 * 1024 * 1024);
    const p = await makePerson(h.db, { email: "parts-subject@example.com" });
    const requestId = (await o.createRequest(staff(), { personId: p.id, kind: "export", requestedBy: "staff" })).id;
    let stored: Awaited<ReturnType<typeof z.storeSubjectExport>> | undefined;
    await h.db.transaction(async (tx) => {
      stored = await z.storeSubjectExport(makeJobCtx(h.db, "privacy.export", { tx }), requestId, p.id, { partBytes: 4096 });
    });
    expect(stored!.fileIds.length).toBeGreaterThan(2);
    const stream = await z.openExportStream(h.db, { id: requestId, fileId: stored!.fileIds[0]!, partFileIds: stored!.fileIds.slice(1) });
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(bytes.length).toBe(stored!.bytes);
    expect(unzip(bytes).map((e) => e.name)).toContain("README.txt");
  });

  it("only the subject or privacy.run staff download; an expired export is gone", async () => {
    const { person } = await signInCustomer(h.db, jar);
    const row = await exportFor(person.id);
    expect((await portalGet(row.id)).status).toBe(200);

    jar.clear();
    await signInCustomer(h.db, jar);
    expect((await portalGet(row.id)).status).toBe(404);
    jar.clear();
    expect((await portalGet(row.id)).status).toBe(404);

    await signInStaffWith(h.db, jar, ["persons.export"], "management");
    expect((await adminGet(row.id)).status).toBe(403);
    jar.clear();
    await signInStaffWith(h.db, jar, ["privacy.run"], "technical_admin");
    expect((await adminGet(row.id)).status).toBe(200);

    await h.db.update(files).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(files.id, row.fileId!));
    expect((await adminGet(row.id)).status).toBe(410);
  });
});
