"use server";
/**
 * site server actions, navigation menus (site spec section 4, rules 24 and section 8; site-P3):
 * `updateNavMenu` saves one menu under an optimistic lock (`expectedVersion`; `0` creates it).
 * Menus serve all three locales, so every label must be complete in nl-BE, fr-BE and en; items
 * whose target page is hidden in a locale are saved and reported back (and on `/admin/site`).
 */
import { z } from "zod";
import { navMenus } from "@beam/db/schema";
import { LOCALES, LocalizedTextSchema, missingLocales } from "@beam/core/i18n";
import { LinkSchema, type NavItem } from "@beam/core/site";
import { action, type ActionResult } from "@/lib/action";
import { ConflictError, eq, ValidationError } from "@/lib/ctx";
import { NAV_TAGS, revalidateSite } from "../server/cache";
import { hiddenNavTargets, type HiddenNavTarget } from "../server/refs";

const MAX_TOP_ITEMS = 8;
const MAX_CHILDREN = 12;

const ChildItem = z.object({ id: z.string().min(1).max(64), label: LocalizedTextSchema, target: LinkSchema }).strict();
const TopItem = z
  .object({ id: z.string().min(1).max(64), label: LocalizedTextSchema, target: LinkSchema, children: z.array(ChildItem).max(MAX_CHILDREN).optional() })
  .strict();

const UpdateNavMenuInput = z.object({
  key: z.enum(["header", "footer", "legal"]),
  items: z.array(TopItem).max(MAX_TOP_ITEMS),
  expectedVersion: z.number().int().min(0),
});

/** `assertComplete(label, LOCALES)` for every item, as field errors `items.<i>[.children.<j>].label`. */
function labelErrors(items: NavItem[]): Record<string, string> {
  const fields: Record<string, string> = {};
  items.forEach((item, i) => {
    const missing = missingLocales(item.label, LOCALES);
    if (missing.length) fields[`items.${i}.label`] = `missing ${missing.join(", ")}`;
    item.children?.forEach((child, j) => {
      const m = missingLocales(child.label, LOCALES);
      if (m.length) fields[`items.${i}.children.${j}.label`] = `missing ${m.join(", ")}`;
    });
  });
  return fields;
}

const impl = action(
  { name: "site.nav.update", audience: "staff", permission: "site.publish", input: UpdateNavMenuInput },
  async (ctx, input): Promise<{ version: number; hidden: HiddenNavTarget[] }> => {
    const items = input.items as NavItem[];
    const errors = labelErrors(items);
    if (Object.keys(errors).length) throw new ValidationError("label_incomplete", errors);
    const ids = items.flatMap((i) => [i.id, ...(i.children ?? []).map((c) => c.id)]);
    if (new Set(ids).size !== ids.length) throw new ValidationError("duplicate_item_id", { items: "duplicate_id" });

    const [row] = await ctx.tx.select().from(navMenus).where(eq(navMenus.key, input.key)).for("update");
    const current = row?.version ?? 0;
    if (current !== input.expectedVersion) throw new ConflictError("menu_changed");
    const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
    let version: number;
    if (row) {
      version = row.version + 1;
      await ctx.tx.update(navMenus).set({ items, version, updatedByUserId: userId, updatedAt: ctx.now }).where(eq(navMenus.id, row.id));
    } else {
      version = 1;
      await ctx.tx.insert(navMenus).values({ key: input.key, items, version, updatedByUserId: userId });
    }
    await ctx.audit({ action: "site.nav.update", entityType: "nav_menu", entityId: input.key, oldValue: { version: current, items: row?.items ?? [] }, newValue: { version, items } });
    return { version, hidden: await hiddenNavTargets(ctx.tx, input.key, items) };
  },
);

/** Saves a menu; `conflict` when someone saved it since `expectedVersion`. */
export async function updateNavMenu(raw: unknown): Promise<ActionResult<{ version: number; hidden: HiddenNavTarget[] }>> {
  const result = await impl(raw);
  if (result.ok) revalidateSite(NAV_TAGS);
  return result;
}
