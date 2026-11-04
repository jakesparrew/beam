import Link from "next/link";
import type { Route } from "next";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listWaitlist } from "@/modules/booking/queries";
import { WaitlistTable } from "@/modules/booking/ui/waitlist-table";
import { toTableRows, waitlistTableLabels } from "@/modules/booking/ui/session-waitlist-tab";

/**
 * `/admin/waitlist` (`waitlist.manage`, booking spec 5.1, R48, R49): every entry of future
 * sessions grouped by session and queue, with a "flagged for review" filter that lists the
 * duplicate signals. Offer, move, reorder, release and flag review run the audited
 * `booking.waitlist_*` actions.
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
    <section aria-labelledby="waitlist-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 id="waitlist-title" className="text-2xl font-semibold">
          {tr("booking.waitlist.title")}
        </h1>
        <nav className="flex gap-3 text-sm">
          <Link href={href(false)} aria-current={!flaggedOnly ? "page" : undefined} className={!flaggedOnly ? "font-semibold underline" : "underline"}>
            {tr("booking.common.show_all")}
          </Link>
          <Link href={href(true)} aria-current={flaggedOnly ? "page" : undefined} className={flaggedOnly ? "font-semibold underline" : "underline"}>
            {tr("booking.waitlist.flagged_only")}
          </Link>
        </nav>
      </div>
      <WaitlistTable rows={toTableRows(rows, locale)} labels={waitlistTableLabels(tr)} />
      {hasMore || page > 0 ? (
        <nav className="flex gap-3 text-sm">
          {page > 0 ? <Link href={href(flaggedOnly, page - 1)}>{tr("platform.table.previous")}</Link> : null}
          {hasMore ? <Link href={href(flaggedOnly, page + 1)}>{tr("platform.table.next")}</Link> : null}
        </nav>
      ) : null}
    </section>
  );
}
