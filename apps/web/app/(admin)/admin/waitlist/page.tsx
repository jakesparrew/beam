import type { Route } from "next";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listWaitlist } from "@/modules/booking/queries";
import { WaitlistTable } from "@/modules/booking/ui/waitlist-table";
import { toTableRows, waitlistTableLabels } from "@/modules/booking/ui/session-waitlist-tab";
import { PageHeader, SecondaryAction, Segmented, Toolbar } from "@/modules/platform/ui/admin-kit";

/**
 * `/admin/waitlist` (`waitlist.manage`, booking spec 5.1, R48, R49), in the back-office kit
 * (owner review, November 2026): every entry of future sessions in one table grouped by date and
 * session (product type as a pill), with a segmented "All / To review" switch whose second
 * option lists the duplicate signals. Offer, move, reorder, release and flag review run the
 * audited `booking.waitlist_*` actions.
 */
export default async function WaitlistPage({ searchParams }: { searchParams: Promise<{ flagged?: string; page?: string }> }) {
  await requireStaff({ permission: "waitlist.manage" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const flaggedOnly = sp.flagged === "1";
  const page = Math.max(0, Number.parseInt(sp.page ?? "0", 10) || 0);
  const { rows, hasMore } = await listWaitlist(await getAppDb(), { flaggedOnly, offset: page * 100 });
  const href = (flagged: boolean, p = 0) => `/admin/waitlist?${new URLSearchParams({ ...(flagged ? { flagged: "1" } : {}), ...(p ? { page: String(p) } : {}) })}` as Route;

  return (
    <div className="grid gap-5">
      <PageHeader title={tr("booking.waitlist.title")} description={tr("booking.waitlist.subtitle")} />
      <Toolbar>
        <Segmented
          label={tr("booking.waitlist.title")}
          items={[
            { key: "all", label: tr("booking.common.show_all"), href: href(false), active: !flaggedOnly },
            { key: "flagged", label: tr("booking.waitlist.flagged_only"), href: href(true), active: flaggedOnly },
          ]}
        />
      </Toolbar>
      <WaitlistTable rows={toTableRows(rows, locale)} labels={waitlistTableLabels(tr)} />
      {hasMore || page > 0 ? (
        <nav className="flex justify-end gap-2">
          {page > 0 ? <SecondaryAction href={href(flaggedOnly, page - 1)}>← {tr("platform.table.previous")}</SecondaryAction> : null}
          {hasMore ? <SecondaryAction href={href(flaggedOnly, page + 1)}>{tr("platform.table.next")} →</SecondaryAction> : null}
        </nav>
      ) : null}
    </div>
  );
}
