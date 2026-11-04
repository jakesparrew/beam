/**
 * The person merge transaction (crm rules 3.30 to 3.34), crm-P4. `executeMerge` runs inside the
 * caller's transaction: it locks both persons (lower id first), refuses the blocking conflicts of
 * rule 3.31, calls the owner merge hooks (webinar, then credits), repoints every foreign key to
 * `persons.id` it discovers in `information_schema.key_column_usage` according to
 * `MERGE_STRATEGIES`, copies consent, flattens merge chains, applies the field choices, writes
 * `person_merges`, closes the pair's duplicate candidates, moves the portal login, exits the
 * loser's automations, and writes the audit row and the `person.merged` events.
 */
import { randomUUID } from "node:crypto";
import { APPEND_ONLY_TABLES, type DbOrTx, type Tx } from "@beam/db";
import { consentRecords, personMerges, persons } from "@beam/db/schema";
import {
  emailHash,
  MERGE_STRATEGIES,
  mergeStrategyFor,
  normalisePhone,
  pickMergedFields,
  planConsentCopy,
  type ConsentRecordLike,
  type MergeField,
  type MergePerson,
  type MergeStrategy,
} from "@beam/core/crm";
import { ForbiddenError } from "@beam/core/errors";
import { AppError, actorJson, ConflictError, eq, inArray, NotFoundError, sql, type Ctx, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { exitPersonEnrolments } from "@/modules/automation/api";
import { onPersonsMerged } from "@/modules/credits/api";
import { requestStatsRefresh } from "@/modules/ops/api";
import { reassignCustomerAccount } from "@/modules/platform/api";
import { mergePersons as webinarMergePersons } from "@/modules/webinar/api";

export type PersonRow = typeof persons.$inferSelect;
export type MergeConflict = "membership" | "booking" | "waitlist";
export type MergeRepointed = Record<string, number>;

/** The columns an owner hook or platform handles; `merge-coverage.test.ts` asserts each is `skip`. */
export const HOOK_HANDLED_COLUMNS = [
  "webinar_registrations.person_id",
  "credit_grants.person_id",
  "memberships.person_id",
  "package_shares.shared_with_person_id",
  "referral_codes.person_id",
  "referral_attributions.*",
  "users.person_id",
] as const;

const APPEND_ONLY = new Set<string>(APPEND_ONLY_TABLES);
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const ident = (name: string): SQL => sql.raw(quote(name));

// ---------------------------------------------------------------------------
// Schema discovery
// ---------------------------------------------------------------------------

export type PersonForeignKey = { table: string; column: string };
export type UniqueKey = { name: string; columns: string[]; predicate: string | null };

/** Every `<table>.<column>` in `public` with a foreign key to `persons.id`, sorted. */
export async function listPersonForeignKeys(tx: DbOrTx): Promise<PersonForeignKey[]> {
  const rows = rowsOf<{ table_name: string; column_name: string }>(
    await tx.execute(sql`
      select distinct kcu.table_name, kcu.column_name
      from information_schema.referential_constraints rc
      join information_schema.key_column_usage kcu
        on kcu.constraint_schema = rc.constraint_schema and kcu.constraint_name = rc.constraint_name
      join information_schema.key_column_usage ref
        on ref.constraint_schema = rc.unique_constraint_schema and ref.constraint_name = rc.unique_constraint_name
       and ref.ordinal_position = kcu.position_in_unique_constraint
      where rc.constraint_schema = 'public' and ref.table_name = 'persons' and ref.column_name = 'id'
      order by kcu.table_name, kcu.column_name
    `),
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

/** The unique indexes of a table on plain columns (expression indexes are left out), with their predicate. */
export async function listUniqueKeys(tx: DbOrTx, table: string): Promise<UniqueKey[]> {
  const rows = rowsOf<{ name: string; columns: string[] | string; predicate: string | null; has_expr: boolean }>(
    await tx.execute(sql`
      select c.relname as name,
             array(
               select a.attname::text from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
               order by k.ord
             ) as columns,
             pg_get_expr(i.indpred, i.indrelid) as predicate,
             (0 = any(i.indkey::int2[])) as has_expr
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass(${`public.${table}`}) and i.indisunique
      order by c.relname
    `),
  );
  return rows
    .filter((r) => !r.has_expr)
    .map((r) => ({
      name: r.name,
      columns: Array.isArray(r.columns) ? r.columns : String(r.columns).replace(/^\{|\}$/g, "").split(",").filter(Boolean),
      predicate: r.predicate,
    }));
}

/**
 * Strategies for referencing columns with a person-including unique key that `MERGE_STRATEGIES`
 * in `@beam/core/crm` does not list yet (requested from its owner; an entry there wins).
 * `automation_enrolments`: automation's `exitPersonEnrolments` ends the loser's enrolments, which
 * stay on the loser as history. The others move unless the winner holds a row with the same key.
 */
export const MERGE_STRATEGY_ADDITIONS: Record<string, MergeStrategy> = {
  "automation_enrolments.person_id": "skip",
  "privacy_requests.person_id": "repoint",
  "provider_customers.person_id": "repoint",
  "retention_list_items.person_id": "keep_winner",
};

/** The strategy for one referencing column: append-only tables and `persons` itself are always `skip`. */
export function strategyOf(fk: PersonForeignKey): MergeStrategy {
  if (APPEND_ONLY.has(fk.table)) return "skip";
  if (fk.table === "persons") return "skip";
  const exact = `${fk.table}.${fk.column}`;
  if (exact in MERGE_STRATEGIES) return MERGE_STRATEGIES[exact]!;
  if (exact in MERGE_STRATEGY_ADDITIONS) return MERGE_STRATEGY_ADDITIONS[exact]!;
  return mergeStrategyFor(fk.table, fk.column);
}

// ---------------------------------------------------------------------------
// Locks and conflicts
// ---------------------------------------------------------------------------

/** Locks both persons `FOR UPDATE`, lower id first; `not_found` when one is missing. */
export async function lockPair(tx: DbOrTx, winnerId: string, loserId: string): Promise<{ winner: PersonRow; loser: PersonRow }> {
  if (winnerId === loserId) throw new AppError("validation", "same_person", { loserId: "same_person" });
  const rows = await tx
    .select()
    .from(persons)
    .where(inArray(persons.id, [winnerId, loserId]))
    .orderBy(persons.id)
    .for("update");
  const winner = rows.find((r) => r.id === winnerId);
  const loser = rows.find((r) => r.id === loserId);
  if (!winner || !loser) throw new NotFoundError("person_not_found");
  return { winner, loser };
}

async function tableExists(tx: DbOrTx, table: string): Promise<boolean> {
  const rows = rowsOf<{ ok: boolean }>(await tx.execute(sql`select to_regclass(${`public.${table}`}) is not null as ok`));
  return !!rows[0]?.ok;
}

async function any(tx: DbOrTx, query: SQL): Promise<boolean> {
  return rowsOf(await tx.execute(query)).length > 0;
}

/**
 * The blocking conflicts of rule 3.31: both persons hold an active or past-due membership, both
 * hold an active booking for one session, or both are on one waiting list.
 */
export async function findMergeConflicts(tx: DbOrTx, winnerId: string, loserId: string): Promise<MergeConflict[]> {
  const out: MergeConflict[] = [];
  if (
    (await tableExists(tx, "memberships")) &&
    (await any(
      tx,
      sql`select 1 from memberships w join memberships l on l.person_id = ${loserId} and l.status in ('active', 'past_due')
          where w.person_id = ${winnerId} and w.status in ('active', 'past_due') limit 1`,
    ))
  ) {
    out.push("membership");
  }
  if (
    (await tableExists(tx, "bookings")) &&
    (await any(
      tx,
      sql`select 1 from bookings w join bookings l on l.session_id = w.session_id and l.person_id = ${loserId} and l.status in ('reserved', 'confirmed')
          where w.person_id = ${winnerId} and w.status in ('reserved', 'confirmed') limit 1`,
    ))
  ) {
    out.push("booking");
  }
  if (
    (await tableExists(tx, "waitlist_entries")) &&
    (await any(
      tx,
      sql`select 1 from waitlist_entries w join waitlist_entries l on l.session_id = w.session_id and l.person_id = ${loserId} and l.state in ('waiting', 'offered')
          where w.person_id = ${winnerId} and w.state in ('waiting', 'offered') limit 1`,
    ))
  ) {
    out.push("waitlist");
  }
  return out;
}

/** The loser's row count per referencing column that the generic repoint would touch (merge preview). */
export async function countLoserReferences(tx: DbOrTx, loserId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const fk of await listPersonForeignKeys(tx)) {
    if (strategyOf(fk) === "skip") continue;
    const rows = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*)::int as n from ${ident(fk.table)} where ${ident(fk.column)} = ${loserId}`));
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) counts[`${fk.table}.${fk.column}`] = n;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Generic repoint
// ---------------------------------------------------------------------------

/**
 * The `ctid`s of the loser's rows that would collide with a winner row under one of the table's
 * unique keys that include the column (both rows inside the key's predicate).
 */
function collidingRows(table: string, column: string, keys: readonly UniqueKey[], winnerId: string, loserId: string): SQL | null {
  const parts = keys
    .filter((k) => k.columns.includes(column))
    .map((k) => {
      const others = k.columns.filter((c) => c !== column);
      const match = others.map((c) => `w.${quote(c)} = l.${quote(c)}`).join(" and ");
      const pred = k.predicate ? ` and l.ctid in (select ctid from ${quote(table)} where ${k.predicate}) and w.ctid in (select ctid from ${quote(table)} where ${k.predicate})` : "";
      return sql`select l.ctid from ${ident(table)} l where l.${ident(column)} = ${loserId} and exists (
        select 1 from ${ident(table)} w where w.${ident(column)} = ${winnerId}${sql.raw(match ? ` and ${match}` : "")}${sql.raw(pred)})`;
    });
  if (!parts.length) return null;
  return sql.join(parts, sql` union `);
}

async function affected(tx: DbOrTx, query: SQL): Promise<number> {
  return rowsOf(await tx.execute(query)).length;
}

/**
 * Applies one column's strategy. `repoint` and `refuse_if_both` move every loser row that does not
 * collide with a winner row (colliding rows stay on the loser and are counted under `:kept`;
 * reads resolve the merge); `keep_winner` deletes the colliding loser rows (counted under
 * `:deleted`) and moves the rest.
 */
async function repointColumn(tx: DbOrTx, fk: PersonForeignKey, strategy: MergeStrategy, winnerId: string, loserId: string, out: MergeRepointed): Promise<void> {
  const key = `${fk.table}.${fk.column}`;
  const t = ident(fk.table);
  const c = ident(fk.column);
  const colliding = collidingRows(fk.table, fk.column, await listUniqueKeys(tx, fk.table), winnerId, loserId);
  if (colliding && strategy === "keep_winner") {
    const deleted = await affected(tx, sql`delete from ${t} where ctid in (${colliding}) returning 1`);
    if (deleted) out[`${key}:deleted`] = deleted;
  } else if (colliding) {
    const kept = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*)::int as n from (${colliding}) x`));
    const n = Number(kept[0]?.n ?? 0);
    if (n) out[`${key}:kept`] = n;
  }
  const moved = await affected(
    tx,
    sql`update ${t} set ${c} = ${winnerId} where ${c} = ${loserId}${colliding ? sql` and ctid not in (${colliding})` : sql``} returning 1`,
  );
  if (moved) out[key] = moved;
}

// ---------------------------------------------------------------------------
// executeMerge
// ---------------------------------------------------------------------------

const toMergePerson = (p: PersonRow): MergePerson => ({
  email: p.email,
  phone: p.phone,
  firstName: p.firstName,
  lastName: p.lastName,
  locale: p.locale,
  address: (p.address ?? null) as MergePerson["address"],
  birthOn: p.birthOn,
  preferredChannel: p.preferredChannel,
  linkedinUrl: p.linkedinUrl,
  emergencyContact: (p.emergencyContact ?? null) as MergePerson["emergencyContact"],
  acquisition: (p.acquisition ?? {}) as MergePerson["acquisition"],
  statusOverride: p.statusOverride,
  statusOverrideReason: p.statusOverrideReason,
  statusOverrideByUserId: p.statusOverrideByUserId,
  statusOverrideAt: p.statusOverrideAt,
  isTester: p.isTester,
  externalIds: (p.externalIds ?? {}) as Record<string, string>,
  processingRestrictedAt: p.processingRestrictedAt,
  createdAt: p.createdAt,
});

/** The loser's row for `person_merges.loser_snapshot` (persons hold no sensitive values). */
function snapshot(p: PersonRow): Record<string, unknown> {
  const { searchTsv: _tsv, ...rest } = p;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

const MESSAGES: Record<MergeConflict, string> = {
  membership: "both_active_membership",
  booking: "both_booked_same_session",
  waitlist: "both_on_same_waitlist",
};

async function copyConsent(tx: Tx, ctx: Ctx, winnerId: string, loserId: string): Promise<number> {
  const rows = await tx.select().from(consentRecords).where(inArray(consentRecords.personId, [winnerId, loserId]));
  const like = (r: (typeof rows)[number]): ConsentRecordLike => r as unknown as ConsentRecordLike;
  const copies = planConsentCopy(rows.filter((r) => r.personId === winnerId).map(like), rows.filter((r) => r.personId === loserId).map(like));
  if (!copies.length) return 0;
  await tx.insert(consentRecords).values(
    copies.map((c) => ({
      personId: winnerId,
      purpose: c.purpose,
      status: c.status,
      method: c.method,
      source: c.source,
      wordingVersion: c.wordingVersion,
      ...(c.lawfulBasis ? { lawfulBasis: c.lawfulBasis } : {}),
      recordedAt: c.recordedAt,
      actor: actorJson(ctx.actor),
      copiedFromRecordId: c.copiedFromRecordId,
    })),
  );
  return copies.length;
}

/**
 * Merges `loserId` into `winnerId` in `tx` (the caller's transaction). Needs a staff actor (the
 * merge is recorded with `merged_by_user_id`). `conflict` when either person is erased or already
 * merged, or on a blocking conflict of rule 3.31 (`message` names the first, `fields.conflicts`
 * lists all).
 */
export async function executeMerge(
  tx: Tx,
  ctx: Ctx,
  input: { winnerId: string; loserId: string; fieldChoices: Partial<Record<MergeField, "winner" | "loser">> },
): Promise<{ mergeId: string; repointed: MergeRepointed }> {
  if (ctx.actor.kind !== "staff") throw new ForbiddenError("forbidden: merge needs a staff actor");
  const userId = ctx.actor.userId;
  const { winnerId, loserId } = input;
  const { winner, loser } = await lockPair(tx, winnerId, loserId);
  for (const p of [winner, loser]) {
    if (p.erasedAt) throw new ConflictError("person_erased");
    if (p.mergedIntoPersonId) throw new ConflictError("person_already_merged");
  }
  const conflicts = await findMergeConflicts(tx, winnerId, loserId);
  if (conflicts.length) throw new AppError("conflict", MESSAGES[conflicts[0]!], { conflicts: conflicts.join(",") });

  const mergeId = randomUUID();
  const repointed: MergeRepointed = {};

  // Owner hooks, in this order, before the generic repoint (rule 3.30).
  const webinar = await webinarMergePersons(tx, winnerId, loserId);
  repointed["hook:webinar.moved"] = webinar.moved;
  repointed["hook:webinar.collapsed"] = webinar.collapsed;
  await onPersonsMerged(tx, ctx, { winnerPersonId: winnerId, loserPersonId: loserId });
  repointed["hook:credits"] = 1;

  // ops' person_stats: the loser's row goes, the winner's is recomputed (rule 3.31).
  if (await tableExists(tx, "person_stats")) {
    const gone = await affected(tx, sql`delete from person_stats where person_id = ${loserId} returning 1`);
    if (gone) repointed["person_stats.person_id:deleted"] = gone;
    await requestStatsRefresh(tx, winnerId);
  }

  // The generic repoint of every non-append foreign key to persons.id (rules 3.30 to 3.32).
  for (const fk of await listPersonForeignKeys(tx)) {
    const strategy = strategyOf(fk);
    if (strategy === "skip") continue;
    await repointColumn(tx, fk, strategy, winnerId, loserId, repointed);
  }

  const copied = await copyConsent(tx, ctx, winnerId, loserId);
  if (copied) repointed["consent_records.copied"] = copied;

  // The loser and everyone already merged into it now point at the winner (chains stay one level).
  const chained = await affected(
    tx,
    sql`update persons set merged_into_person_id = ${winnerId}, version = version + 1, updated_at = now()
        where merged_into_person_id = ${loserId} returning 1`,
  );
  if (chained) repointed["persons.merged_into_person_id"] = chained;
  await tx.update(persons).set({ mergedIntoPersonId: winnerId, version: sql`${persons.version} + 1`, updatedAt: ctx.now }).where(eq(persons.id, loserId));

  // Field choices and the merged attributes of rule 3.34 (after the loser left the active email index).
  const patch = pickMergedFields(toMergePerson(winner), toMergePerson(loser), input.fieldChoices);
  const email = patch.email ?? null;
  const phone = patch.phone ?? null;
  await tx
    .update(persons)
    .set({
      email,
      emailHash: email ? emailHash(email) : null,
      phone,
      phoneE164: phone ? normalisePhone(phone) : null,
      firstName: patch.firstName ?? null,
      lastName: patch.lastName ?? null,
      locale: (patch.locale ?? winner.locale) as PersonRow["locale"],
      address: (patch.address ?? null) as PersonRow["address"],
      birthOn: patch.birthOn ?? null,
      preferredChannel: patch.preferredChannel ?? null,
      linkedinUrl: patch.linkedinUrl ?? null,
      emergencyContact: (patch.emergencyContact ?? null) as PersonRow["emergencyContact"],
      acquisition: (patch.acquisition ?? {}) as PersonRow["acquisition"],
      statusOverride: patch.statusOverride ?? null,
      statusOverrideReason: patch.statusOverrideReason ?? null,
      statusOverrideByUserId: patch.statusOverrideByUserId ?? null,
      statusOverrideAt: patch.statusOverrideAt ?? null,
      isTester: patch.isTester ?? winner.isTester,
      externalIds: (patch.externalIds ?? {}) as PersonRow["externalIds"],
      processingRestrictedAt: patch.processingRestrictedAt ?? null,
      version: sql`${persons.version} + 1`,
      updatedAt: ctx.now,
    })
    .where(eq(persons.id, winnerId));

  await tx.insert(personMerges).values({
    id: mergeId,
    winnerPersonId: winnerId,
    loserPersonId: loserId,
    loserSnapshot: snapshot(loser),
    fieldChoices: input.fieldChoices as Record<string, "winner" | "loser">,
    repointed,
    mergedByUserId: userId,
  });

  await tx.execute(sql`
    update person_duplicate_candidates
    set status = 'merged', reviewed_by_user_id = ${userId}, reviewed_at = ${ctx.now}, updated_at = now()
    where person_a_id = least(${winnerId}::uuid, ${loserId}::uuid) and person_b_id = greatest(${winnerId}::uuid, ${loserId}::uuid)
  `);

  await reassignCustomerAccount(ctx, { fromPersonId: loserId, toPersonId: winnerId });
  await exitPersonEnrolments(tx, { personId: loserId, reason: "merged", actor: ctx.actor });

  await ctx.audit({
    action: "person.merge",
    entityType: "person",
    entityId: winnerId,
    personId: winnerId,
    oldValue: { winner: { id: winnerId, version: winner.version }, loser: { id: loserId, version: loser.version } },
    newValue: { winner_person_id: winnerId, loser_person_id: loserId, merge_id: mergeId, field_choices: input.fieldChoices, repointed },
  });
  await ctx.recordEvent({ kind: "person.merged", personId: winnerId, data: { merge_id: mergeId, role: "winner", other_person_id: loserId }, ref: { type: "person_merge", id: mergeId }, dedupeKey: `merge:${mergeId}:winner` });
  await ctx.recordEvent({ kind: "person.merged", personId: loserId, data: { merge_id: mergeId, role: "loser", other_person_id: winnerId }, ref: { type: "person_merge", id: mergeId }, dedupeKey: `merge:${mergeId}:loser` });

  return { mergeId, repointed };
}
