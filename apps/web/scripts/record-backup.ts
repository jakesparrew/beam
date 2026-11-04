/**
 * `pnpm --filter @beam/web exec tsx scripts/record-backup.ts --kind backup|restore_drill --ok true|false [--note <text>]`
 *
 * Runs as the last step of `.github/workflows/backup.yml` and `restore-drill.yml` (platform spec
 * 5, decision 36). It records the run in `settings.security` (`last_backup_at` / `last_backup_ok`
 * or `last_restore_drill_at` / `last_restore_drill_ok`), so `/admin/system/security` shows it, and
 * writes the audit row `backup.completed` or `restore_drill.completed` with `{ ok, note }` that
 * `platform.build_monthly_report` counts (PL-89). Actor `system`; uses `DATABASE_URL_UNPOOLED`
 * when set. The note must not contain personal data (it is a run id or a short message).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Tx } from "@beam/db";
import { createCtx, flushDurableWrites, flushIntegrationLog, type Ctx } from "@/lib/ctx";
import { getSettingWithVersion, setSetting } from "@/lib/settings";

export type BackupKind = "backup" | "restore_drill";

export type RecordBackupInput = { kind: BackupKind; ok: boolean; note?: string; now?: Date };

/** Parses `--kind`, `--ok` and `--note`; throws with a usage line on bad input. */
export function parseArgs(argv: readonly string[]): RecordBackupInput {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const kind = get("kind");
  const ok = get("ok");
  if ((kind !== "backup" && kind !== "restore_drill") || (ok !== "true" && ok !== "false")) {
    throw new Error("usage: record-backup.ts --kind backup|restore_drill --ok true|false [--note <text>]");
  }
  const note = get("note")?.slice(0, 500);
  return { kind, ok: ok === "true", ...(note ? { note } : {}) };
}

/** Writes the result into `settings.security` and the audit log, in one transaction. */
export async function recordBackup(db: Db, input: RecordBackupInput): Promise<void> {
  const now = input.now ?? new Date();
  const requestId = `record-backup:${input.kind}:${now.toISOString()}`;
  let ctx: Ctx | undefined;
  await db.transaction(async (tx: Tx) => {
    ctx = createCtx({ tx, actor: { kind: "system", jobId: requestId }, requestId, now });
    const { value, version } = await getSettingWithVersion(tx, "security");
    const next =
      input.kind === "backup"
        ? { ...value, last_backup_at: now.toISOString(), last_backup_ok: input.ok }
        : { ...value, last_restore_drill_at: now.toISOString(), last_restore_drill_ok: input.ok };
    await setSetting(ctx, "security", next, version);
    await ctx.audit({
      action: input.kind === "backup" ? "backup.completed" : "restore_drill.completed",
      entityType: "settings",
      entityId: "security",
      newValue: { ok: input.ok, ...(input.note ? { note: input.note } : {}) },
    });
  });
  if (ctx) {
    await flushDurableWrites(db, ctx);
    await flushIntegrationLog(db, ctx);
  }
}

async function main(argv: string[]): Promise<number> {
  const { config } = await import("dotenv");
  config({ path: ["../../.env.local", "../../.env", ".env.local"], quiet: true });
  if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
  let input: RecordBackupInput;
  try {
    input = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  const { getDbHandle } = await import("@beam/db");
  const handle = await getDbHandle();
  try {
    await recordBackup(handle.db, input);
    console.log(`record-backup: ${input.kind} ok=${input.ok} recorded`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await handle.close();
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
