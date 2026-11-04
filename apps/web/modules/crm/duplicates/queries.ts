/** Duplicate queue queries (crm spec 4.3, screen `/admin/persons/duplicates`), crm-P4. */
import type { DbOrTx } from "@beam/db";
import { DUPLICATE_MIN_SCORE, formatCustomerNumber, type DuplicateReason } from "@beam/core/crm";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export type DuplicateCandidateRow = {
  id: string;
  score: number;
  reasons: DuplicateReason[];
  status: "open" | "merged" | "dismissed";
  personA: { id: string; customerNumber: string; name: string; email: string | null; createdAt: Date };
  personB: { id: string; customerNumber: string; name: string; email: string | null; createdAt: Date };
};

type Row = {
  id: string;
  score: number;
  reasons: DuplicateReason[];
  status: DuplicateCandidateRow["status"];
  a_id: string;
  a_number: string | number;
  a_first: string | null;
  a_last: string | null;
  a_email: string | null;
  a_created: Date | string;
  b_id: string;
  b_number: string | number;
  b_first: string | null;
  b_last: string | null;
  b_email: string | null;
  b_created: Date | string;
};

const name = (first: string | null, last: string | null) => [first, last].filter(Boolean).join(" ").trim();

/**
 * Candidates by score (highest first, then oldest pair first), at most 200. `open` pairs are
 * listed only while both persons are still active (neither merged nor erased).
 */
export async function listDuplicateCandidates(
  tx: DbOrTx,
  input: { status?: "open" | "merged" | "dismissed"; minScore?: number } = {},
): Promise<DuplicateCandidateRow[]> {
  const status = input.status ?? "open";
  const minScore = input.minScore ?? DUPLICATE_MIN_SCORE;
  const rows = rowsOf<Row>(
    await tx.execute(sql`
      select c.id, c.score, c.reasons, c.status,
             a.id as a_id, a.customer_number as a_number, a.first_name as a_first, a.last_name as a_last, a.email as a_email, a.created_at as a_created,
             b.id as b_id, b.customer_number as b_number, b.first_name as b_first, b.last_name as b_last, b.email as b_email, b.created_at as b_created
      from person_duplicate_candidates c
      join persons a on a.id = c.person_a_id
      join persons b on b.id = c.person_b_id
      where c.status = ${status} and c.score >= ${minScore}
        ${status === "open" ? sql`and a.erased_at is null and a.merged_into_person_id is null and b.erased_at is null and b.merged_into_person_id is null` : sql``}
      order by c.score desc, c.created_at asc, c.id asc
      limit 200
    `),
  );
  return rows.map((r) => ({
    id: r.id,
    score: Number(r.score),
    reasons: r.reasons,
    status: r.status,
    personA: { id: r.a_id, customerNumber: formatCustomerNumber(Number(r.a_number)), name: name(r.a_first, r.a_last), email: r.a_email, createdAt: new Date(r.a_created) },
    personB: { id: r.b_id, customerNumber: formatCustomerNumber(Number(r.b_number)), name: name(r.b_first, r.b_last), email: r.b_email, createdAt: new Date(r.b_created) },
  }));
}
