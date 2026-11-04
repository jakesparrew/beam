/**
 * `getPageKindByPath`, kept apart from `refs.ts` so site's `api.ts` barrel can re-export it
 * without loading forms and webinar (refs imports their api barrels). Pulling those into site's
 * barrel closes an import cycle (forms and commerce import site's api) that defeats other
 * modules' `vi.mock("@/modules/site/api", ...)` factories.
 */
import type { DbOrTx } from "@beam/db";
import { pageRoutes, pages } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { localePath, type PageKind } from "@beam/core/site";
import { and, eq } from "@/lib/ctx";

/**
 * The kind of the live page at `path` in `locale` (forms rule A2 branch 7: a form on a BEAM
 * landing page). `path` is the site path with or without the locale prefix (`/nl/actie`,
 * `actie`, `''` for home); null when no published page holds it.
 */
export async function getPageKindByPath(db: DbOrTx, locale: Locale, path: string): Promise<PageKind | null> {
  const prefix = localePath(locale, "");
  let clean = path.split("?")[0]!.split("#")[0]!.toLowerCase();
  if (clean === prefix || clean.startsWith(`${prefix}/`)) clean = clean.slice(prefix.length);
  clean = clean.replace(/^\/+|\/+$/g, "");
  const [row] = await db
    .select({ kind: pages.kind })
    .from(pageRoutes)
    .innerJoin(pages, eq(pages.id, pageRoutes.pageId))
    .where(and(eq(pageRoutes.locale, locale), eq(pageRoutes.path, clean), eq(pages.status, "published")))
    .limit(1);
  return (row?.kind) ?? null;
}
