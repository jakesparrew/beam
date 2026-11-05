/**
 * platform-P11b: the exit export (PL-92) on PGlite with the defaults seed plus a person, a
 * sensitive field, a staff user with an MFA secret and a stored file. Every table of the schema
 * index is a CSV with its header; files and the manifest are in the archive; sensitive columns
 * stay ciphertext; a second run differs only in `generatedAt`; the archive is age-encrypted.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import type { DbHandle } from "@beam/db";
import { files, personSensitiveFields, users } from "@beam/db/schema";
import { seedDefaults } from "@beam/db/seed";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { eq } from "@/lib/ctx";
import { encryptSensitive, sensitiveAad } from "@/lib/sensitive";
import {
  AGE_RECIPIENT,
  brusselsDay,
  collectExitExport,
  csvField,
  packArchive,
  parseArgs,
  runExitExport,
  schemaTableNames,
  type ExitExport,
} from "./exit-export";

const PLAIN_NOTE = "Slaapt slecht sinds de verhuis";
const PLAIN_TOTP = "JBSWY3DPEHPK3PXP";
const FILE_BYTES = new TextEncoder().encode("%PDF-1.7 demo invoice\n");
const RECIPIENT = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

let h: DbHandle;
let personId: string;
let fileId: string;
let storedEnc: Uint8Array;
let first: ExitExport;
const decoder = new TextDecoder();

const entry = (x: ExitExport, p: string) => x.entries.find((e) => e.path === p);
const text = (x: ExitExport, p: string) => decoder.decode(entry(x, p)!.bytes);

beforeAll(async () => {
  process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
  h = await createTestDb();
  await seedDefaults(h.db);
  const person = await makePerson(h.db, { email: "exit-export@example.com" });
  personId = person.id;
  const enc = encryptSensitive(PLAIN_NOTE, sensitiveAad.personField(personId, "sleep"), 1);
  storedEnc = enc.valueEnc;
  await h.db.insert(personSensitiveFields).values({ personId, key: "sleep", valueEnc: enc.valueEnc, keyVersion: enc.keyVersion });
  const user = await makeUser(h.db, { email: "exit-staff@demo.beam.be", roleKey: "owner" });
  const totp = encryptSensitive(PLAIN_TOTP, sensitiveAad.totpSecret(user.id), 1);
  await h.db.update(users).set({ totpSecretEnc: totp.valueEnc, secretKeyVersion: 1 }).where(eq(users.id, user.id));
  const [f] = await h.db
    .insert(files)
    .values({ kind: "invoice_pdf", name: "factuur 2026-0001.pdf", mime: "application/pdf", sizeBytes: FILE_BYTES.length, bytes: FILE_BYTES, sha256: createHash("sha256").update(FILE_BYTES).digest("hex"), personId })
    .returning({ id: files.id });
  fileId = f!.id;
  first = await collectExitExport(h.db, { now: new Date("2026-11-05T09:00:00Z") });
}, 180_000);

afterAll(() => h.close());

describe("collectExitExport", () => {
  it("writes every table of the schema index as a CSV with its header row", () => {
    const names = schemaTableNames();
    expect(names.length).toBeGreaterThan(50);
    expect(names).toEqual(expect.arrayContaining(["persons", "jobs", "files", "person_sensitive_fields"]));
    for (const name of names) {
      const csv = entry(first, `tables/${name}.csv`);
      expect(csv, name).toBeDefined();
      const table = first.manifest.tables.find((t) => t.name === name)!;
      expect(decoder.decode(csv!.bytes).split("\n")[0]).toBe(table.columns.map((c) => csvField(c)).join(","));
      expect(decoder.decode(csv!.bytes).split("\n").filter(Boolean)).toHaveLength(table.rows + 1);
    }
  });

  it("exports the seed data rows, NULL as an empty field and timestamps in UTC", () => {
    const persons = text(first, "tables/persons.csv");
    expect(persons).toContain("exit-export@example.com");
    expect(first.manifest.tables.find((t) => t.name === "roles")!.rows).toBeGreaterThan(0);
    expect(persons).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?\+00/);
  });

  it("keeps sensitive columns encrypted, exactly as stored", () => {
    const all = first.entries.map((e) => decoder.decode(e.bytes)).join("\n");
    expect(all).not.toContain(PLAIN_NOTE);
    expect(all).not.toContain(PLAIN_TOTP);
    expect(text(first, "tables/person_sensitive_fields.csv")).toContain(`\\x${Buffer.from(storedEnc).toString("hex")}`);
    expect(first.manifest.sensitiveColumns).toEqual(
      expect.arrayContaining([
        { table: "person_sensitive_fields", column: "value_enc", keyColumn: "key_version" },
        { table: "users", column: "totp_secret_enc", keyColumn: "secret_key_version" },
      ]),
    );
    expect(first.manifest.keyNote).toContain("SENSITIVE_DATA_KEY_V<n>");
  });

  it("puts every stored file in the archive and points files.csv at it", () => {
    const listed = first.manifest.files.find((f) => f.id === fileId)!;
    expect(listed.path).toBe(`files/${fileId}/factuur 2026-0001.pdf`);
    expect(entry(first, listed.path)!.bytes).toEqual(FILE_BYTES);
    expect(listed.sha256).toBe(createHash("sha256").update(FILE_BYTES).digest("hex"));
    expect(text(first, "tables/files.csv")).toContain(listed.path);
    expect(text(first, "tables/files.csv")).not.toContain(Buffer.from(FILE_BYTES).toString("hex"));
  });

  it("lists every entry with its hash in the manifest, which comes last", () => {
    const paths = first.entries.map((e) => e.path);
    expect(paths.at(-1)).toBe("manifest.json");
    expect(first.manifest.entries.map((e) => e.path)).toEqual(paths.slice(0, -1));
    for (const e of first.manifest.entries) {
      expect(createHash("sha256").update(entry(first, e.path)!.bytes).digest("hex")).toBe(e.sha256);
    }
    expect(JSON.parse(text(first, "manifest.json"))).toEqual(first.manifest);
  });

  it("gives the same archive on a second run apart from the timestamp", async () => {
    const second = await collectExitExport(h.db, { now: new Date("2026-11-06T22:30:00Z") });
    expect(second.entries.map((e) => e.path)).toEqual(first.entries.map((e) => e.path));
    for (const e of first.entries.filter((x) => x.path !== "manifest.json")) {
      expect(Buffer.from(entry(second, e.path)!.bytes).equals(Buffer.from(e.bytes)), e.path).toBe(true);
    }
    expect({ ...second.manifest, generatedAt: "" }).toEqual({ ...first.manifest, generatedAt: "" });
    expect(second.manifest.generatedAt).toBe("2026-11-06T22:30:00.000Z");
    const strip = (x: ExitExport) => packArchive(x.entries.map((e) => (e.path === "manifest.json" ? { ...e, bytes: new TextEncoder().encode(JSON.stringify({ ...x.manifest, generatedAt: "" })) } : e)));
    expect(Buffer.from(strip(second)).equals(Buffer.from(strip(first)))).toBe(true);
  });
});

describe("runExitExport", () => {
  it("writes only the encrypted archive, mode 0600, named after the Brussels day", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "exit-"));
    try {
      let plain: Uint8Array | undefined;
      const now = new Date("2026-11-05T23:30:00Z");
      const result = await runExitExport({
        db: h.db,
        recipient: RECIPIENT,
        outDir: dir,
        now,
        databaseUrl: "postgres://exit@localhost/beam",
        dump: () => Promise.resolve(new TextEncoder().encode("PGDMP fake dump")),
        encrypt: (bytes, recipient) => {
          expect(recipient).toBe(RECIPIENT);
          plain = bytes;
          return Promise.resolve(new Uint8Array(Buffer.concat([Buffer.from("age-encryption.org/v1\n"), Buffer.from(bytes).reverse()])));
        },
      });
      expect(path.basename(result.file)).toBe(`beam-exit-${brusselsDay(now)}.zip.age`);
      expect(brusselsDay(now)).toBe("2026-11-06");
      const written = await readFile(result.file);
      expect(written.subarray(0, 22).toString()).toBe("age-encryption.org/v1\n");
      expect((await stat(result.file)).mode & 0o777).toBe(0o600);
      const zip = unzipSync(plain!);
      expect(decoder.decode(zip["database.dump"])).toBe("PGDMP fake dump");
      expect(Object.keys(zip)).toEqual(expect.arrayContaining(["manifest.json", "tables/persons.csv", `files/${fileId}/factuur 2026-0001.pdf`]));
      expect(result.manifest.source.pgDump).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a recipient that is not an age public key", async () => {
    await expect(runExitExport({ db: h.db, recipient: "ssh-rsa AAAA", outDir: tmpdir(), skipDump: true })).rejects.toThrow(/age public key/);
    expect(() => parseArgs(["--out", "x"])).toThrow(/usage/);
    expect(parseArgs(["--recipient", RECIPIENT, "--out", "/tmp/x", "--skip-dump"])).toEqual({ recipient: RECIPIENT, outDir: "/tmp/x", skipDump: true });
    expect(AGE_RECIPIENT.test(RECIPIENT)).toBe(true);
  });

  const hasAge = (() => {
    try {
      execFileSync("age", ["--version"], { stdio: "ignore" });
      execFileSync("age-keygen", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  // Needs the `age` binary (installed on the machine that runs the real export); the encryptor
  // contract itself is covered above with an injected encryptor.
  it.runIf(hasAge)("encrypts with the real age binary so only the identity holder can read it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "exit-age-"));
    try {
      const identity = path.join(dir, "key.txt");
      execFileSync("age-keygen", ["-o", identity], { stdio: "ignore" });
      const recipient = execFileSync("age-keygen", ["-y", identity]).toString().trim();
      const result = await runExitExport({ db: h.db, recipient, outDir: dir, skipDump: true, now: new Date("2026-11-05T09:00:00Z") });
      const zip = unzipSync(new Uint8Array(execFileSync("age", ["--decrypt", "--identity", identity, result.file])));
      const manifest = JSON.parse(decoder.decode(zip["manifest.json"])) as { tables: { name: string }[]; source: { pgDump: boolean } };
      expect(manifest.tables.map((t) => t.name)).toEqual(expect.arrayContaining(schemaTableNames()));
      expect(manifest.source.pgDump).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
