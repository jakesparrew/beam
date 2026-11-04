import Link from "next/link";
import { formatDateTime } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { creditsLabels, listSharingReview } from "@/modules/credits/queries";
import { SharingReviewTable, type SharingReviewView } from "@/modules/credits/ui/sharing-review-table";

/**
 * `/admin/credits/sharing-review` (credits spec section 5, rule 43, R2; `credits.read`, decisions
 * need `credits.adjust`): grants with more than 3 distinct guests in 30 days and guests used on 3
 * or more owners' grants, with the people's full names (rule 38) and the last use.
 */
export default async function SharingReviewPage() {
  const actor = await requireStaff({ permission: "credits.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const r = (k: string, p?: Record<string, string | number>) => tr(`credits.admin.sharing_review.${k}`, p);
  const items = await listSharingReview(await getAppDb(), { limit: 200 });
  const rows: SharingReviewView[] = items.map((it) => {
    const pkg = it.productName?.[locale] || it.grantLabel?.[locale] || "";
    const subjectText =
      it.rule === "many_guests"
        ? [r("package_of", { name: it.subjectName }), pkg].filter(Boolean).join(" · ")
        : r("guest", { name: it.subjectName });
    return {
      key: `${it.rule}:${it.grantId ?? it.guestPersonId}`,
      rule: it.rule,
      grantId: it.grantId,
      guestPersonId: it.guestPersonId,
      subjectText,
      count: it.distinctCount,
      people: it.people,
      lastText: formatDateTime(it.lastAt, locale, "short"),
    };
  });
  const labels = creditsLabels(locale, ["admin.common", "admin.sharing_review", "errors"]);
  const canDecide = hasPermission(actor, "credits.adjust");
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/credits" className="text-sm text-muted-foreground hover:underline">
          {tr("credits.admin.grant.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{r("title")}</h1>
        <p className="max-w-prose text-muted-foreground">{r("intro")}</p>
        {!canDecide && rows.length > 0 ? <p className="text-sm text-muted-foreground">{r("read_only")}</p> : null}
      </header>
      <SharingReviewTable rows={rows} canDecide={canDecide} labels={labels} />
    </div>
  );
}
