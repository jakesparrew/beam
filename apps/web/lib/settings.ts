/**
 * Settings (PL-41, PL-42). Each key is declared once, with a Zod schema and a default, in its
 * owner's `modules/<m>/config.ts` (`defineSetting`), and collected into `SETTINGS`.
 * `getSetting` returns the default when no row exists. `setSetting` is the one write path
 * (the `updateSetting` action calls it): optimistic `expectedVersion`, schema validation,
 * version bump and an audit row. System keys skip both bump and audit.
 */
import type { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { settings as settingsTable } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import type { SETTINGS } from "../registry/settings.generated";
import type { SettingKey } from "../registry/types.generated";
import { ConflictError, eq, sql, ValidationError, type Ctx } from "./ctx";
import { reportMessage } from "./logger";

export type SettingDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  key: string;
  schema: S;
  default: z.infer<S>;
  /** Written by the system without a version bump or audit row (`last_tick_at`, `automation_cursor`). */
  isSystem?: boolean;
  description?: string;
};

/** Declares a setting in a module's `config.ts` (keeps the schema type for `SettingValue`). */
export function defineSetting<S extends z.ZodTypeAny>(def: {
  key: string;
  schema: S;
  default: z.infer<S>;
  isSystem?: boolean;
  description?: string;
}): SettingDefinition<S> {
  return def;
}

type Registry = typeof SETTINGS;
export type SettingValue<K extends SettingKey> = K extends keyof Registry
  ? Registry[K] extends { schema: infer S extends z.ZodTypeAny }
    ? z.infer<S>
    : unknown
  : unknown;

export const SYSTEM_SETTING_KEYS = ["last_tick_at", "automation_cursor"] as const;
export type SystemSettingKey = Extract<SettingKey, (typeof SYSTEM_SETTING_KEYS)[number]>;

let registry: Promise<Readonly<Record<string, SettingDefinition | undefined>>> | undefined;
export function loadSettingsRegistry(): Promise<Readonly<Record<string, SettingDefinition | undefined>>> {
  registry ??= import("../registry/settings.generated").then(
    (m) => (m as { SETTINGS?: unknown }).SETTINGS as Readonly<Record<string, SettingDefinition | undefined>>,
  );
  return registry;
}

const clone = <T>(v: T): T => (v === undefined ? v : (structuredClone(v) as T));

async function readRow(tx: DbOrTx, key: string, forUpdate = false): Promise<{ value: unknown; version: number } | null> {
  const q = tx.select({ value: settingsTable.value, version: settingsTable.version }).from(settingsTable).where(eq(settingsTable.key, key));
  const rows = forUpdate ? await q.for("update") : await q;
  return rows[0] ?? null;
}

/** The value of a setting, or its declared default when no row exists (never throws for a missing row). */
export async function getSetting<K extends SettingKey>(tx: DbOrTx, key: K): Promise<SettingValue<K>> {
  const def = (await loadSettingsRegistry())[key];
  const row = await readRow(tx, key);
  if (!def) {
    if (row) return row.value as SettingValue<K>;
    throw new PermanentError(`unknown_setting: ${key}`);
  }
  if (!row) return clone(def.default) as SettingValue<K>;
  const parsed = def.schema.safeParse(row.value);
  if (parsed.success) return parsed.data as SettingValue<K>;
  reportMessage(`setting ${key} does not match its schema; the default is used`, { tags: { setting: key } });
  return clone(def.default) as SettingValue<K>;
}

/** The value and version (0 when no row exists) for the settings editor. */
export async function getSettingWithVersion<K extends SettingKey>(tx: DbOrTx, key: K): Promise<{ value: SettingValue<K>; version: number }> {
  const row = await readRow(tx, key);
  return { value: await getSetting(tx, key), version: row?.version ?? 0 };
}

/** Writes a system key: no version bump, no audit row (PL-41). */
export async function writeSystemSetting<K extends SystemSettingKey>(tx: DbOrTx, key: K, value: SettingValue<K>): Promise<void> {
  await tx
    .insert(settingsTable)
    .values({ key, value: value as unknown })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: value as unknown, updatedAt: sql`now()` } });
}

/**
 * The programmatic setter with the rules of PL-41: the value must pass the key's schema,
 * `expectedVersion` must equal the stored version (0 for a key without a row), the version is
 * bumped and `settings.update` is audited with old and new value. Throws `ConflictError` on a
 * stale version and `ValidationError` on a bad value.
 */
export async function setSetting<K extends SettingKey>(
  ctx: Ctx,
  key: K,
  value: SettingValue<K>,
  expectedVersion: number,
): Promise<{ version: number }> {
  const def = (await loadSettingsRegistry())[key];
  if (!def) throw new ValidationError(`unknown_setting: ${key}`, { key: "unknown" });
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "value"] = issue.message;
    throw new ValidationError(`invalid_setting: ${key}`, fields);
  }
  const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
  const row = await readRow(ctx.tx, key, true);

  if (def.isSystem) {
    await writeSystemSetting(ctx.tx, key as unknown as SystemSettingKey, parsed.data as never);
    return { version: row?.version ?? 1 };
  }

  const current = row?.version ?? 0;
  if (current !== expectedVersion) throw new ConflictError(`stale_version: ${key} is at version ${current}`);
  const oldValue = row ? row.value : def.default;
  let version: number;
  if (!row) {
    await ctx.tx.insert(settingsTable).values({ key, value: parsed.data as unknown, version: 1, updatedByUserId: userId });
    version = 1;
  } else {
    const updated = await ctx.tx
      .update(settingsTable)
      .set({ value: parsed.data as unknown, version: sql`${settingsTable.version} + 1`, updatedByUserId: userId })
      .where(eq(settingsTable.key, key))
      .returning({ version: settingsTable.version });
    version = updated[0]!.version;
  }
  // Through ctx.audit, so `action('settings.update')` does not add a second, automatic row (PL-20).
  await ctx.audit({ action: "settings.update", entityType: "settings", entityId: key, oldValue, newValue: parsed.data });
  return { version };
}
