/**
 * Knowledge base reads (crm spec 4.3), crm-P10: `listKnowledgeArticles({ includeInactive })`
 * for `/admin/inbox/knowledge`. Articles are BEAM policy and hold no person data.
 */
import type { DbOrTx } from "@beam/db";
import { supportKnowledgeArticles, users } from "@beam/db/schema";
import type { LocalizedText } from "@beam/core/i18n";
import { asc, eq, sql } from "@/lib/ctx";

export type KnowledgeArticleRow = {
  id: string;
  key: string;
  title: LocalizedText;
  body: LocalizedText;
  isActive: boolean;
  updatedAt: Date;
  updatedByName: string | null;
};

/** Articles by key; active only unless `includeInactive`. */
export async function listKnowledgeArticles(db: DbOrTx, opts: { includeInactive?: boolean } = {}): Promise<KnowledgeArticleRow[]> {
  return db
    .select({
      id: supportKnowledgeArticles.id,
      key: supportKnowledgeArticles.key,
      title: supportKnowledgeArticles.title,
      body: supportKnowledgeArticles.body,
      isActive: supportKnowledgeArticles.isActive,
      updatedAt: supportKnowledgeArticles.updatedAt,
      updatedByName: sql<string | null>`coalesce(${users.name}, ${users.email})`,
    })
    .from(supportKnowledgeArticles)
    .leftJoin(users, eq(users.id, supportKnowledgeArticles.updatedByUserId))
    .where(opts.includeInactive ? undefined : eq(supportKnowledgeArticles.isActive, true))
    .orderBy(asc(supportKnowledgeArticles.key));
}
