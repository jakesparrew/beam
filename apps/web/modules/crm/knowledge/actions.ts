"use server";
/**
 * Knowledge base actions (crm spec 4.2, rule 3.58), crm-P10. `saveKnowledgeArticle`
 * (`crm.save_knowledge_article`, `settings.write`): key, title and body in all three locales
 * (plain text, at most 5,000 characters per locale); the handler writes its own audit row
 * (`knowledge.save`). Only async functions are exported (OD-18).
 */
import { z } from "zod";
import { LocalizedTextSchema } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { saveKnowledge } from "../inbox/ai-draft";

export const saveKnowledgeArticle = action(
  {
    name: "crm.save_knowledge_article",
    audience: "staff",
    permission: "settings.write",
    input: z.object({
      id: z.uuid().optional(),
      key: z.string().trim().regex(/^[a-z0-9_-]{2,64}$/),
      title: LocalizedTextSchema,
      body: LocalizedTextSchema,
      isActive: z.boolean(),
    }),
    audit: false,
  },
  (ctx, input) => saveKnowledge(ctx, input),
);
