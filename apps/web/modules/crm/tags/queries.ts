/** Tag queries (crm spec 4.3), crm-P2: every tag with its number of active persons. */
import type { DbOrTx } from "@beam/db";
import type { LocalizedText } from "@beam/core/i18n";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export type TagRow = { id: string; key: string; name: LocalizedText; color: string; description: string | null; isSystem: boolean; count: number };

export async function listTags(tx: DbOrTx): Promise<TagRow[]> {
  const rows = rowsOf<{ id: string; key: string; name: LocalizedText; color: string; description: string | null; is_system: boolean; count: number | string }>(
    await tx.execute(sql`
      select t.id::text as id, t.key, t.name, t.color, t.description, t.is_system,
             (select count(*) from person_tags pt join persons p on p.id = pt.person_id
              where pt.tag_id = t.id and p.erased_at is null and p.merged_into_person_id is null)::int as count
      from tags t order by t.is_system desc, t.key`),
  );
  return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, color: r.color, description: r.description, isSystem: r.is_system, count: Number(r.count) }));
}
