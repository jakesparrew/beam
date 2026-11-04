/**
 * The subject export (ops rule 60, GDPR articles 15 and 20): one store-only zip with, per
 * registered module, `<module>.json` (the portable copy) and one CSV per table
 * (`<module>/<table>.csv`), plus `sensitive.json` from `readSensitive(ctx, personId,
 * 'privacy_export')` and `README.txt` in the person's locale (purposes and legal bases,
 * recipients, retention periods, source, the right to complain).
 *
 * Storage: the zip is cut into parts of `PRIVACY_EXPORT_PART_BYTES` (9 MB; a `files` row holds
 * at most 10 MB), each encrypted with AES-256-GCM under `SENSITIVE_DATA_KEY_V<n>` before
 * `storeFile` (kind `export`, the subject's `person_id`, expiry 7 days). The download decrypts
 * the parts in order and streams the original zip.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DbOrTx, Tx } from "@beam/db";
import { files } from "@beam/db/schema";
import { t, type Locale } from "@beam/core/i18n";
import {
  CONTRACTUAL_PURPOSES,
  ERASE_ORDER,
  PRIVACY_EXPORT_EXPIRY_DAYS,
  PRIVACY_EXPORT_PART_BYTES,
  SUBPROCESSORS,
  SUPERVISORY_AUTHORITY,
  toCsv,
  zipStore,
  type ZipEntry,
} from "@beam/core/ops";
import { eq, inArray, sql } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import { PermanentError, type JobCtx } from "@/lib/job-runner";
import { currentKeyVersion, readSensitive, rowsOf, sensitiveKey } from "@/lib/sensitive";
import { GDPR_REGISTRY } from "@/registry/privacy.generated";

const DAY_MS = 86_400_000;
const FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

type Registry = Readonly<Record<string, { export(tx: Tx, personId: string): Promise<Record<string, unknown>> } | undefined>>;

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

function jsonReplacer(this: unknown, key: string, value: unknown): unknown {
  const raw = key === "" ? value : (this as Record<string, unknown>)[key];
  if (typeof raw === "bigint") return raw.toString();
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("base64");
  return value;
}

export const toJsonText = (value: unknown): string => `${JSON.stringify(value, jsonReplacer, 2)}\n`;

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield await Promise.resolve(bytes);
}

const textEntry = (name: string, text: string): ZipEntry => ({ name, data: once(new TextEncoder().encode(text)) });

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);

const safeName = (s: string) => s.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80) || "data";

/** One CSV per table: an array of rows becomes a CSV over the union of their keys. */
function csvEntries(module: string, data: Record<string, unknown>): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const [table, value] of Object.entries(data)) {
    const rows = Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : [];
    if (Array.isArray(value) && value.length && !rows.length) continue;
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    if (!columns.length) continue;
    const cells = rows.map((r) => columns.map((c) => (typeof r[c] === "bigint" ? String(r[c]) : r[c] instanceof Uint8Array ? Buffer.from(r[c] as Uint8Array).toString("base64") : r[c])));
    out.push({ name: `${module}/${safeName(table)}.csv`, data: toCsv(columns, cells) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// README.txt (rule 60)
// ---------------------------------------------------------------------------

type ReadmeFacts = {
  consents: { purpose: string; status: string; lawful_basis: string }[];
  retention: { key: string; table_name: string; days: number | null; action: string; description: string }[];
  source: string | null;
  importSources: string[];
};

async function readmeFacts(tx: DbOrTx, personId: string): Promise<ReadmeFacts> {
  const consents = rowsOf<ReadmeFacts["consents"][number]>(
    await tx.execute(sql`select distinct on (purpose) purpose::text as purpose, status::text as status, lawful_basis::text as lawful_basis
      from consent_records where person_id = ${personId}::uuid order by purpose, recorded_at desc, id desc`),
  );
  const retention = rowsOf<ReadmeFacts["retention"][number]>(
    await tx.execute(sql`select key, table_name, days, action::text as action, description from retention_policies where is_active order by run_order, key`),
  );
  const [person] = rowsOf<{ source: string | null }>(await tx.execute(sql`select acquisition->>'source' as source from persons where id = ${personId}::uuid`));
  const imports = rowsOf<{ source: string }>(
    await tx.execute(sql`select distinct i.source::text as source from import_rows r join imports i on i.id = r.import_id where r.person_id = ${personId}::uuid
      union select distinct h.source::text from imported_history h where h.person_id = ${personId}::uuid order by 1`),
  );
  return { consents, retention, source: person?.source ?? null, importSources: imports.map((r) => r.source) };
}

/** The README in the person's locale; every heading and label comes from the ops catalogue. */
export function readmeText(locale: Locale, facts: ReadmeFacts): string {
  const tr = (key: string, params?: Record<string, string | number>) => t(locale, `ops.privacy.readme.${key}`, params);
  const basis = (b: string) => t(locale, `ops.privacy.legal_basis.${b}`);
  const lines: string[] = [tr("title"), "", tr("intro"), tr("portable_note"), ""];
  lines.push(`== ${tr("purposes_title")} ==`);
  for (const p of CONTRACTUAL_PURPOSES) lines.push(`- ${tr(`purpose.${p}`)} (${basis(p === "legal_obligations" ? "accounting_law" : "contract")})`);
  for (const c of facts.consents.filter((c) => c.status === "granted")) lines.push(`- ${c.purpose} (${basis(c.lawful_basis === "legitimate_interest" ? "legitimate_interest" : "consent")})`);
  lines.push("", `== ${tr("recipients_title")} ==`);
  for (const s of SUBPROCESSORS) lines.push(`- ${s.name}: ${t(locale, s.roleKey)}; ${t(locale, s.dataKey)}; ${s.location}${s.transfer ? ` (${s.transfer})` : ""}`);
  lines.push("", `== ${tr("retention_title")} ==`);
  for (const r of facts.retention) {
    const period = r.days === null ? basis("accountability") : tr("days", { count: r.days });
    lines.push(`- ${r.table_name} (${r.key}): ${period}. ${r.description}`);
  }
  lines.push("", `== ${tr("source_title")} ==`);
  lines.push(`- ${facts.source ?? "-"}`);
  for (const s of facts.importSources) lines.push(`- import: ${s}`);
  lines.push("", `== ${tr("complaint_title")} ==`);
  lines.push(tr("complaint_body", { authority: SUPERVISORY_AUTHORITY[locale], url: SUPERVISORY_AUTHORITY.url }), "");
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// The zip entries
// ---------------------------------------------------------------------------

/** Modules in erase order first (stable), then any other registered module. */
function moduleOrder(registry: Registry): string[] {
  const names = Object.keys(registry);
  return [...ERASE_ORDER.filter((m) => names.includes(m)), ...names.filter((m) => !(ERASE_ORDER as readonly string[]).includes(m)).sort()];
}

/**
 * The subject export's entries, in order: per module `<module>.json` and its CSVs, then
 * `sensitive.json` and `README.txt`. `ctx` must be the system actor (`readSensitive` purpose
 * `privacy_export`).
 */
export async function* buildSubjectExport(tx: Tx, ctx: JobCtx, personId: string, registry: Registry = GDPR_REGISTRY as unknown as Registry): AsyncIterable<{ name: string; data: AsyncIterable<Uint8Array> }> {
  for (const moduleId of moduleOrder(registry)) {
    const reg = registry[moduleId];
    if (!reg) continue;
    const data = (await reg.export(tx, personId)) ?? {};
    yield textEntry(`${moduleId}.json`, toJsonText(data));
    for (const entry of csvEntries(moduleId, data)) yield entry;
  }
  // `ctx.tx` is `tx` (the export job's transaction); `readSensitive` audits through `ctx`.
  const sensitive = await readSensitive(ctx, personId, "privacy_export");
  yield textEntry("sensitive.json", toJsonText(sensitive));
  const [p] = rowsOf<{ locale: string }>(await tx.execute(sql`select locale::text as locale from persons where id = ${personId}::uuid`));
  const locale = (["nl-BE", "fr-BE", "en"] as const).find((l) => l === p?.locale) ?? "nl-BE";
  yield textEntry("README.txt", readmeText(locale, await readmeFacts(tx, personId)));
}

// ---------------------------------------------------------------------------
// Encrypted parts
// ---------------------------------------------------------------------------

export const partAad = (requestId: string, index: number) => `privacy_export:${requestId}:${index}`;

function exportKey(version: number): Buffer {
  const key = sensitiveKey(version);
  if (!key) throw new PermanentError(`missing_key: SENSITIVE_DATA_KEY_V${version}`);
  return key;
}

/** `[format][key version][iv][ciphertext][tag]`, AES-256-GCM. */
export function encryptPart(plain: Uint8Array, aad: string, version: number = currentKeyVersion()): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", exportKey(version), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([FORMAT, version]), iv, ct, cipher.getAuthTag()]));
}

export function decryptPart(enc: Uint8Array, aad: string): Uint8Array {
  const buf = Buffer.from(enc);
  if (buf.length < 2 + IV_BYTES + TAG_BYTES || buf[0] !== FORMAT) throw new PermanentError("decrypt_failed: bad format");
  const iv = buf.subarray(2, 2 + IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", exportKey(buf[1]!), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(buf.subarray(2 + IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]));
  } catch (error) {
    throw new PermanentError("decrypt_failed", { cause: error });
  }
}

/** Cuts a byte stream into parts of at most `partBytes`. */
export async function* cutParts(stream: AsyncIterable<Uint8Array>, partBytes: number): AsyncIterable<Uint8Array> {
  let buf = new Uint8Array(partBytes);
  let used = 0;
  for await (const chunk of stream) {
    let at = 0;
    while (at < chunk.length) {
      const n = Math.min(partBytes - used, chunk.length - at);
      buf.set(chunk.subarray(at, at + n), used);
      used += n;
      at += n;
      if (used === partBytes) {
        yield buf;
        buf = new Uint8Array(partBytes);
        used = 0;
      }
    }
  }
  if (used > 0) yield buf.subarray(0, used);
}

export type StoredExport = { fileIds: string[]; bytes: number; expiresAt: Date };

/** Zips, encrypts and stores the subject export; returns the file ids in order. */
export async function storeSubjectExport(ctx: JobCtx, requestId: string, personId: string, opts: { partBytes?: number } = {}): Promise<StoredExport> {
  const expiresAt = new Date(ctx.now.getTime() + PRIVACY_EXPORT_EXPIRY_DAYS * DAY_MS);
  const fileIds: string[] = [];
  let bytes = 0;
  const zip = zipStore(buildSubjectExport(ctx.tx, ctx, personId));
  for await (const part of cutParts(zip, opts.partBytes ?? PRIVACY_EXPORT_PART_BYTES)) {
    const index = fileIds.length;
    const { fileId } = await storeFile(ctx, {
      kind: "export",
      name: `privacy-export-${requestId}.zip.${String(index + 1).padStart(3, "0")}.enc`,
      mime: "application/octet-stream",
      bytes: encryptPart(part, partAad(requestId, index)),
      expiresAt,
      personId,
    });
    fileIds.push(fileId);
    bytes += part.length;
  }
  return { fileIds, bytes, expiresAt };
}

/** The decrypted zip, part by part, for a download response; null when a part is gone or expired. */
export async function openExportStream(db: DbOrTx, request: { id: string; fileId: string | null; partFileIds: string[] }, now: Date = new Date()): Promise<ReadableStream<Uint8Array> | null> {
  if (!request.fileId) return null;
  const ids = [request.fileId, ...request.partFileIds];
  const rows = await db.select({ id: files.id, expiresAt: files.expiresAt }).from(files).where(inArray(files.id, ids));
  if (rows.length !== ids.length || rows.some((r) => r.expiresAt && r.expiresAt.getTime() <= now.getTime())) return null;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= ids.length) {
        controller.close();
        return;
      }
      const index = i++;
      const [f] = await db.select({ bytes: files.bytes }).from(files).where(eq(files.id, ids[index]!));
      if (!f) {
        controller.error(new Error("export part missing"));
        return;
      }
      controller.enqueue(decryptPart(f.bytes, partAad(request.id, index)));
    },
  });
}

/** Deletes the stored parts of a request's export (erasure of the subject, ops section 9). */
export async function deleteExportFiles(tx: DbOrTx, fileIds: readonly string[]): Promise<number> {
  if (!fileIds.length) return 0;
  const gone = await tx.delete(files).where(inArray(files.id, [...fileIds])).returning({ id: files.id });
  return gone.length;
}
