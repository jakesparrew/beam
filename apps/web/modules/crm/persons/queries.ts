/**
 * Person queries (crm spec 4.3, rule 3.6), crm-P2: the admin list and the staff search. Search
 * accepts `C-000123`, `123`, an email, a phone number in any format (normalised to E.164) or a
 * name prefix (`search_tsv @@ to_tsquery('simple', 'prefix:*')`); merged and erased persons never
 * appear.
 */
import type { DbOrTx } from "@beam/db";
import { formatCustomerNumber, normaliseEmail, normalisePhone, type AcquisitionSource, type PersonStatus } from "@beam/core/crm";
import type { Locale } from "@beam/core/i18n";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export type PersonListRow = {
  id: string;
  customerNumber: string;
  name: string;
  email: string | null;
  status: PersonStatus;
  isOverridden: boolean;
  isMember: boolean;
  tags: string[];
  lastActivityAt: Date | null;
  createdAt: Date;
};

type RawRow = {
  id: string;
  customer_number: string | number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
  status_override: string | null;
  is_member: boolean | null;
  tags: string[] | null;
  last_activity_at: string | Date | null;
  created_at: string | Date;
};

const SELECT = sql`
  select p.id::text as id, p.customer_number, p.first_name, p.last_name, p.email,
         coalesce(s.status, p.status_override::text, 'lead') as status, p.status_override::text as status_override,
         coalesce(s.is_member, false) as is_member,
         coalesce((select array_agg(t.key order by t.key) from person_tags pt join tags t on t.id = pt.tag_id where pt.person_id = p.id), '{}') as tags,
         (select max(e.occurred_at) from activity_events e where e.person_id = p.id) as last_activity_at,
         p.created_at
  from persons p left join v_person_status s on s.person_id = p.id`;

const ACTIVE = sql`p.erased_at is null and p.merged_into_person_id is null`;

/** `Firstname Lastname`, else the email, else the customer number. */
export function displayName(row: { first_name: string | null; last_name: string | null; email: string | null }, customerNumber: string): string {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || row.email || customerNumber;
}

function toRow(r: RawRow): PersonListRow {
  const customerNumber = formatCustomerNumber(r.customer_number);
  return {
    id: r.id,
    customerNumber,
    name: displayName(r, customerNumber),
    email: r.email,
    status: (r.status ?? "lead") as PersonStatus,
    isOverridden: r.status_override !== null,
    isMember: !!r.is_member,
    tags: r.tags ?? [],
    lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at) : null,
    createdAt: new Date(r.created_at),
  };
}

/** The parts of a search string (rule 3.6). */
export function parseSearch(q: string): { customerNumber: number | null; email: string | null; emailPrefix: string | null; phone: string | null; tsQuery: string | null } {
  const text = q.trim();
  const number = /^(?:c-?)?0*(\d{1,12})$/i.exec(text);
  const customerNumber = number && Number(number[1]) > 0 && Number(number[1]) <= Number.MAX_SAFE_INTEGER ? Number(number[1]) : null;
  const email = text.includes("@") ? normaliseEmail(text) : null;
  const emailPrefix = text.length >= 3 && !/\s/.test(text) ? text.toLowerCase() : null;
  const digits = text.replace(/[^\d+]/g, "");
  const phone = digits.length >= 8 ? normalisePhone(text) : null;
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}@._-]/gu, "").replace(/^[._@-]+|[._@-]+$/g, ""))
    .filter((w) => w.length > 0)
    .slice(0, 6);
  const tsQuery = words.length ? words.map((w) => `${w.replace(/[^\p{L}\p{N}]/gu, "")}:*`).filter((w) => w !== ":*").join(" & ") || null : null;
  return { customerNumber, email, emailPrefix, phone, tsQuery };
}

/** The matching conditions and a rank (customer number, email, phone, then name) for a search string. */
function searchClause(q: string): { where: SQL; rank: SQL } | null {
  const s = parseSearch(q);
  const parts: SQL[] = [];
  const ranks: SQL[] = [];
  if (s.customerNumber !== null) {
    parts.push(sql`p.customer_number = ${s.customerNumber}`);
    ranks.push(sql`when p.customer_number = ${s.customerNumber} then 0`);
  }
  if (s.email) {
    parts.push(sql`lower(p.email) = ${s.email}`);
    ranks.push(sql`when lower(p.email) = ${s.email} then 1`);
  }
  if (s.emailPrefix) parts.push(sql`lower(p.email) like ${`${s.emailPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`);
  if (s.phone) {
    parts.push(sql`p.phone_e164 = ${s.phone}`);
    ranks.push(sql`when p.phone_e164 = ${s.phone} then 2`);
  }
  if (s.tsQuery) parts.push(sql`p.search_tsv @@ to_tsquery('simple', ${s.tsQuery})`);
  if (!parts.length) return null;
  const rank = ranks.length ? sql`case ${sql.join(ranks, sql` `)} else 3 end` : sql`3`;
  return { where: sql`(${sql.join(parts, sql` or `)})`, rank };
}

/** Command palette and pickers: best matches first, at most `limit` (default 10). */
export async function searchPersons(tx: DbOrTx, q: string, limit = 10): Promise<PersonListRow[]> {
  return searchPersonRows(tx, q, limit);
}

export async function searchPersonRows(tx: DbOrTx, q: string, limit = 10): Promise<PersonListRow[]> {
  const clause = searchClause(q ?? "");
  if (!clause) return [];
  const rows = rowsOf<RawRow>(
    await tx.execute(sql`${SELECT} where ${ACTIVE} and ${clause.where}
      order by ${clause.rank}, lower(p.last_name) nulls last, lower(p.first_name) nulls last, p.customer_number
      limit ${Math.min(100, Math.max(1, Math.floor(limit)))}`),
  );
  return rows.map(toRow);
}

/** `/admin/persons`: filters, sort and page (1-based, `pageSize` at most 100). */
export async function listPersons(
  tx: DbOrTx,
  input: {
    q?: string;
    status?: PersonStatus;
    tagIds?: string[];
    segmentId?: string;
    locale?: Locale;
    source?: AcquisitionSource;
    isTester?: boolean;
    page: number;
    pageSize: number;
    sort: "created_at" | "last_name" | "last_activity_at";
  },
): Promise<{ rows: PersonListRow[]; total: number }> {
  const where: SQL[] = [ACTIVE];
  const q = input.q?.trim();
  if (q) {
    const clause = searchClause(q);
    if (!clause) return { rows: [], total: 0 };
    where.push(clause.where);
  }
  if (input.status) where.push(sql`coalesce(s.status, p.status_override::text, 'lead') = ${input.status}`);
  if (input.tagIds?.length) {
    where.push(sql`exists (select 1 from person_tags pt where pt.person_id = p.id and pt.tag_id in (${sql.join(input.tagIds.map((id) => sql`${id}::uuid`), sql`, `)}))`);
  }
  if (input.segmentId) where.push(sql`exists (select 1 from segment_members sm where sm.person_id = p.id and sm.segment_id = ${input.segmentId}::uuid)`);
  if (input.locale) where.push(sql`p.locale = ${input.locale}`);
  if (input.source) where.push(sql`p.acquisition->>'source' = ${input.source}`);
  if (input.isTester !== undefined) where.push(sql`p.is_tester = ${input.isTester}`);
  const filter = sql.join(where, sql` and `);
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)));
  const page = Math.max(1, Math.floor(input.page));
  const order =
    input.sort === "last_name"
      ? sql`lower(p.last_name) asc nulls last, lower(p.first_name) asc nulls last, p.customer_number`
      : input.sort === "last_activity_at"
        ? sql`last_activity_at desc nulls last, p.customer_number desc`
        : sql`p.created_at desc, p.customer_number desc`;
  const rows = rowsOf<RawRow>(await tx.execute(sql`${SELECT} where ${filter} order by ${order} limit ${pageSize} offset ${(page - 1) * pageSize}`));
  const [count] = rowsOf<{ n: number | string }>(await tx.execute(sql`select count(*)::int as n from persons p left join v_person_status s on s.person_id = p.id where ${filter}`));
  return { rows: rows.map(toRow), total: Number(count?.n ?? 0) };
}

