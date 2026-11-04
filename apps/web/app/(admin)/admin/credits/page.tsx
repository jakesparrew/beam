import Link from "next/link";
import { buttonVariants } from "@beam/ui";
import { CREDIT_KINDS, GRANT_SOURCES, GRANT_STATUSES, type CreditKind } from "@beam/core/credits";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getCreditsTiles, listGrants, type GrantSource, type GrantStatus } from "@/modules/credits/queries";
import { TilesView, tilesFor } from "@/modules/credits/ui/credits-dashboard-tiles";
import { GrantsTable } from "@/modules/credits/ui/grants-table";

type Search = { q?: string; kind?: string; status?: string; source?: string; expiring?: string; person?: string; cursor?: string };

const pick = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => ((list as readonly string[]).includes(v ?? "") ? (v as T) : undefined);

/** `/admin/credits` (`credits.read`, credits spec section 5): tiles and the grants table. */
export default async function CreditsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff({ permission: "credits.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const g = (k: string) => tr(`credits.admin.grants.${k}`);
  const db = await getAppDb();
  const kind = pick<CreditKind>(CREDIT_KINDS, sp.kind);
  const status = pick<GrantStatus>(GRANT_STATUSES, sp.status);
  const source = pick<GrantSource>(GRANT_SOURCES, sp.source);
  const expiring = sp.expiring === "30" ? 30 : undefined;
  const q = sp.q?.trim() || undefined;
  const [tiles, list] = await Promise.all([
    getCreditsTiles(db),
    listGrants(db, { q, kind, status, source, expiringWithinDays: expiring, personId: sp.person, cursor: sp.cursor ?? null }),
  ]);
  const canAdjust = hasPermission(actor, "credits.adjust");
  const filtered = !!(q || kind || status || source || expiring || sp.person);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{g("title")}</h1>
        <nav className="flex flex-wrap gap-2" aria-label={g("title")}>
          <Link href="/admin/credits/reconciliation" className={buttonVariants({ variant: "outline" })}>
            {g("reconciliation")}
          </Link>
          {canAdjust ? (
            <>
              <Link href="/admin/credits/bulk-extend" className={buttonVariants({ variant: "outline" })}>
                {g("bulk")}
              </Link>
              <Link href="/admin/credits/new" className={buttonVariants()}>
                {g("new")}
              </Link>
            </>
          ) : null}
        </nav>
      </header>
      <TilesView tiles={tilesFor("credits", tiles, locale)} label={tr("credits.admin.tiles.label")} />
      <GrantsTable rows={list.rows} nextCursor={list.nextCursor} searchParams={sp} locale={locale} filtered={filtered} canCreate={canAdjust} />
    </div>
  );
}
