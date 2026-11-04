/**
 * Duplicate detection (crm rules 3.28, 3.29), crm-P4. One set-based query finds the persons that
 * share a legacy external id, a canonical (gmail) email, a phone number or a full name with each
 * person of a batch; `scorePair` from `@beam/core/crm` scores each pair (the highest reason
 * counts, scores never add up). Merged and erased persons are never candidates.
 */
import type { DbOrTx } from "@beam/db";
import { DUPLICATE_MIN_SCORE, orderPair, scorePair, type DupInput, type DuplicateReason } from "@beam/core/crm";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export type DuplicateMatch = { personId: string; score: number; reasons: DuplicateReason[] };
export type DuplicatePair = { personAId: string; personBId: string; score: number; reasons: DuplicateReason[] };

type PairRow = {
  p_id: string;
  p_email: string | null;
  p_phone: string | null;
  p_first: string | null;
  p_last: string | null;
  p_birth: string | null;
  p_postal: string | null;
  p_ext: Record<string, string> | null;
  q_id: string;
  q_email: string | null;
  q_phone: string | null;
  q_first: string | null;
  q_last: string | null;
  q_birth: string | null;
  q_postal: string | null;
  q_ext: Record<string, string> | null;
  dismissed: boolean;
};

/** The canonical email of rule 3.28 in SQL (same result as `gmailCanonical`). */
const canonicalEmail = (alias: string): SQL =>
  sql.raw(
    `(case when split_part(lower(${alias}.email), '@', 2) in ('gmail.com', 'googlemail.com')
       then regexp_replace(split_part(split_part(lower(${alias}.email), '@', 1), '+', 1), '\\.', '', 'g') || '@gmail.com'
       else lower(${alias}.email) end)`,
  );

const toDate = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v.slice(0, 10) : null);

const input = (r: PairRow, side: "p" | "q"): DupInput => ({
  id: side === "p" ? r.p_id : r.q_id,
  email: side === "p" ? r.p_email : r.q_email,
  phoneE164: side === "p" ? r.p_phone : r.q_phone,
  firstName: side === "p" ? r.p_first : r.q_first,
  lastName: side === "p" ? r.p_last : r.q_last,
  birthOn: toDate(side === "p" ? r.p_birth : r.q_birth),
  postalCode: side === "p" ? r.p_postal : r.q_postal,
  externalIds: side === "p" ? r.p_ext : r.q_ext,
});

/**
 * Every scored pair between the persons `p` selected by `where` (active only) and any other active
 * person `q`, with whether the pair was dismissed before. Pairs are returned once per `(p, q)`.
 */
async function matchPairs(tx: DbOrTx, where: SQL): Promise<Array<DuplicatePair & { dismissed: boolean; pId: string; qId: string }>> {
  const rows = rowsOf<PairRow>(
    await tx.execute(sql`
      with p as (
        select * from persons x
        where x.erased_at is null and x.merged_into_person_id is null and (${where})
      )
      select p.id as p_id, p.email as p_email, p.phone_e164 as p_phone, p.first_name as p_first, p.last_name as p_last,
             p.birth_on as p_birth, p.address->>'postal_code' as p_postal, p.external_ids as p_ext,
             q.id as q_id, q.email as q_email, q.phone_e164 as q_phone, q.first_name as q_first, q.last_name as q_last,
             q.birth_on as q_birth, q.address->>'postal_code' as q_postal, q.external_ids as q_ext,
             exists (
               select 1 from person_duplicate_candidates c
               where c.person_a_id = least(p.id, q.id) and c.person_b_id = greatest(p.id, q.id) and c.status = 'dismissed'
             ) as dismissed
      from p
      join persons q on q.id <> p.id and q.erased_at is null and q.merged_into_person_id is null and (
        (p.phone_e164 is not null and q.phone_e164 = p.phone_e164)
        or (p.first_name is not null and p.last_name is not null
            and lower(q.first_name) = lower(p.first_name) and lower(q.last_name) = lower(p.last_name))
        or (p.email is not null and q.email is not null and ${canonicalEmail("q")} = ${canonicalEmail("p")})
        or (p.external_ids <> '{}'::jsonb and exists (
              select 1 from jsonb_each_text(p.external_ids) e
              where e.value <> '' and q.external_ids @> jsonb_build_object(e.key, e.value)))
      )
    `),
  );
  const out: Array<DuplicatePair & { dismissed: boolean; pId: string; qId: string }> = [];
  for (const r of rows) {
    const { score, reasons } = scorePair(input(r, "p"), input(r, "q"));
    if (score <= 0) continue;
    const [personAId, personBId] = orderPair(r.p_id, r.q_id);
    out.push({ personAId, personBId, score, reasons, dismissed: !!r.dismissed, pId: r.p_id, qId: r.q_id });
  }
  return out;
}

/**
 * The likely duplicates of one person, highest score first (booking's waitlist duplicate flags,
 * the duplicate job). A pair staff dismissed is never proposed again (rule 3.28). A merged or
 * erased person has none.
 */
export async function findLikelyDuplicates(tx: DbOrTx, personId: string, minScore: number = DUPLICATE_MIN_SCORE): Promise<DuplicateMatch[]> {
  const pairs = await matchPairs(tx, sql`x.id = ${personId}`);
  return pairs
    .filter((p) => !p.dismissed && p.score >= minScore)
    .map((p) => ({ personId: p.qId, score: p.score, reasons: p.reasons }))
    .sort((a, b) => b.score - a.score || a.personId.localeCompare(b.personId));
}

/**
 * The pairs (each once, `person_a_id < person_b_id`) scoring at least `minScore` between the
 * persons selected by `where` and every other active person; dismissed pairs are left out.
 */
export async function findDuplicatePairs(tx: DbOrTx, where: SQL, minScore: number = DUPLICATE_MIN_SCORE): Promise<DuplicatePair[]> {
  const byPair = new Map<string, DuplicatePair>();
  for (const p of await matchPairs(tx, where)) {
    if (p.dismissed || p.score < minScore) continue;
    byPair.set(`${p.personAId}:${p.personBId}`, { personAId: p.personAId, personBId: p.personBId, score: p.score, reasons: p.reasons });
  }
  return [...byPair.values()];
}

/**
 * Stores pairs as `open` candidates (rule 3.28): a new pair is inserted, an `open` pair gets the
 * new score and reasons only when they changed, and a `dismissed` or `merged` pair is never
 * re-opened. Returns the number of pairs inserted or changed.
 */
export async function upsertCandidates(tx: DbOrTx, pairs: readonly DuplicatePair[]): Promise<number> {
  let written = 0;
  for (const p of pairs) {
    const reasons = sql`array[${sql.join(
      p.reasons.map((r) => sql`${r}`),
      sql`, `,
    )}]::text[]`;
    const res = rowsOf<{ id: string }>(
      await tx.execute(sql`
        insert into person_duplicate_candidates (person_a_id, person_b_id, score, reasons)
        values (${p.personAId}, ${p.personBId}, ${p.score}, ${reasons})
        on conflict (person_a_id, person_b_id) do update
          set score = excluded.score, reasons = excluded.reasons, updated_at = now()
          where person_duplicate_candidates.status = 'open'
            and (person_duplicate_candidates.score, person_duplicate_candidates.reasons) is distinct from (excluded.score, excluded.reasons)
        returning id
      `),
    );
    written += res.length;
  }
  return written;
}
