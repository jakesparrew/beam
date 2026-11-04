/**
 * The gap-safe evaluator cursor (A-8, edge cases 1 and 2), stored in `settings.automation_cursor`.
 *
 * `activity_events.id` is an identity: a transaction that commits id 105 before id 104 becomes
 * visible would make a plain `id > last` cursor skip 104 for good. The cursor therefore keeps
 * every id below `last_event_id` that was missing when a later id was processed (a gap) and the
 * evaluator re-reads them on every run; a gap older than 10 minutes is dropped (its transaction
 * rolled back, or the id was never used). Re-reading is harmless (`uq_enrolment_trigger`, the
 * A-22 exit guard and the run `dedupe_key`).
 *
 * Decisions:
 * - At most `MAX_GAPS` gaps are kept, oldest dropped first; a jump of more than `MAX_GAP_SPAN`
 *   ids in one step (an identity cache jump) records no gaps for that jump.
 * - The row is locked `FOR UPDATE SKIP LOCKED`: a second evaluator returns at once.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { settings as settingsTable } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { writeSystemSetting } from "@/lib/settings";
import { AutomationCursor, type AutomationCursorValue } from "../config";

export const CURSOR_KEY = "automation_cursor" as const;
/** A gap not seen within this window is dropped (A-8). */
export const GAP_TTL_MS = 10 * 60_000;
export const MAX_GAPS = 1_000;
export const MAX_GAP_SPAN = 200;

export const EMPTY_CURSOR: AutomationCursorValue = { last_event_id: "0", gaps: [] };

/**
 * Locks the cursor row (creating it first when missing) and returns its value, or null when
 * another evaluator holds the lock.
 */
export async function lockCursor(tx: Tx): Promise<AutomationCursorValue | null> {
  await tx
    .insert(settingsTable)
    .values({ key: CURSOR_KEY, value: EMPTY_CURSOR })
    .onConflictDoNothing({ target: settingsTable.key });
  const rows = await tx
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, CURSOR_KEY))
    .for("update", { skipLocked: true });
  const row = rows[0];
  if (!row) return null;
  const parsed = AutomationCursor.safeParse(row.value);
  return parsed.success ? parsed.data : { ...EMPTY_CURSOR };
}

/** Reads the cursor without locking it (health checks, `countAutomationIssues`). */
export async function readCursor(tx: DbOrTx): Promise<AutomationCursorValue> {
  const rows = await tx.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, CURSOR_KEY));
  const parsed = AutomationCursor.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : { ...EMPTY_CURSOR };
}

export async function saveCursor(tx: Tx, value: AutomationCursorValue): Promise<void> {
  await writeSystemSetting(tx, CURSOR_KEY, value);
}

/**
 * The in-memory cursor of one evaluator run: `processed(id)` advances it and records the ids
 * skipped over as gaps; `gapSeen(id)` removes a re-read gap.
 */
export class CursorState {
  last: bigint;
  private gaps: Map<string, string>;

  constructor(
    value: AutomationCursorValue,
    private readonly now: Date,
  ) {
    this.last = BigInt(value.last_event_id);
    this.gaps = new Map(value.gaps.map((g) => [g.id, g.first_seen_at]));
  }

  /** The gap ids still worth re-reading (younger than `GAP_TTL_MS`), dropping the others. */
  liveGaps(): bigint[] {
    const cutoff = this.now.getTime() - GAP_TTL_MS;
    for (const [id, seen] of this.gaps) if (new Date(seen).getTime() < cutoff) this.gaps.delete(id);
    return [...this.gaps.keys()].map((id) => BigInt(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** A gap id was read (processed); it is no longer a gap. */
  gapSeen(id: bigint): void {
    this.gaps.delete(id.toString());
  }

  /** A new id above the cursor was processed: ids skipped between become gaps. */
  processed(id: bigint): void {
    if (id <= this.last) return;
    const span = id - this.last - 1n;
    if (span > 0n && span <= BigInt(MAX_GAP_SPAN) && this.last > 0n) {
      const seen = this.now.toISOString();
      for (let g = this.last + 1n; g < id; g++) this.gaps.set(g.toString(), seen);
    }
    this.last = id;
  }

  value(): AutomationCursorValue {
    let gaps = [...this.gaps.entries()].map(([id, first_seen_at]) => ({ id, first_seen_at }));
    if (gaps.length > MAX_GAPS) {
      gaps.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      gaps = gaps.slice(gaps.length - MAX_GAPS);
    }
    return { last_event_id: this.last.toString(), gaps };
  }
}

/** The age in seconds of the oldest event above the cursor (A-45 lag), 0 when none. */
export async function evaluatorLagSeconds(tx: DbOrTx, now: Date): Promise<number> {
  const cursor = await readCursor(tx);
  const res = await tx.execute(sql`select min(occurred_at) as oldest from activity_events where id > ${cursor.last_event_id}::bigint`);
  const oldest = rowsOf<{ oldest: string | Date | null }>(res)[0]?.oldest;
  if (!oldest) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(oldest).getTime()) / 1000));
}
