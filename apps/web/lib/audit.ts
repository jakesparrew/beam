/**
 * The audit log writer (PL-20, PL-21). `audit_log` is APPEND: rows are only inserted.
 * Every value passes through `redactForAudit()` first.
 */
import { createHash } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { auditLog, SENSITIVE_COLUMNS, type ActorJson } from "@beam/db/schema";
import { SECRET_KEY_PATTERN, SENSITIVE_FIELD_KEYS } from "@beam/core/privacy";

export type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string | null;
  personId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
};

export type AuditMeta = { actor: ActorJson; requestId?: string | null; ip?: string | null };

export const REDACTED = "[redacted]";

/**
 * Keys whose values never reach the audit log: the sensitive field keys, the columns in
 * `SENSITIVE_COLUMNS` (except `activity_events.data`, whose sensitive payload is the
 * `body_enc` key that the secret pattern already catches), and secrets.
 */
function isRedactedKey(key: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  if ((SENSITIVE_FIELD_KEYS as readonly string[]).includes(snake)) return true;
  return SENSITIVE_COLUMNS.some((c) => c.column !== "data" && (c.column === key || c.column === snake));
}

/** Replaces sensitive and secret values with `"[redacted]"`, recursively (PL-21). */
export function redactForAudit(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactForAudit(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isRedactedKey(k) ? REDACTED : redactForAudit(v);
  }
  return out;
}

/** JSON-safe form of an audit value (bigints become strings). */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as unknown;
}

/** Writes one `audit_log` row in `tx`. */
export async function writeAuditRow(tx: DbOrTx, meta: AuditMeta, input: AuditInput): Promise<void> {
  await tx.insert(auditLog).values({
    actor: meta.actor,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    personId: input.personId ?? null,
    oldValue: input.oldValue === undefined ? null : jsonSafe(redactForAudit(input.oldValue)),
    newValue: input.newValue === undefined ? null : jsonSafe(redactForAudit(input.newValue)),
    requestId: meta.requestId ?? null,
    ip: meta.ip ?? null,
  });
}

/** `ctx.audit` is this function bound to the context; exported for `api.ts` (`audit(tx, meta, input)`). */
export const audit = writeAuditRow;

/** `{ digest: sha256(json) }`: what an erased person's audit values become (platform privacy). */
export function auditDigest(value: unknown): { digest: string } {
  return { digest: createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex") };
}
