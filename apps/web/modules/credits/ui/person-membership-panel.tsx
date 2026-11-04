/**
 * `PersonMembershipPanel` for crm's person page (credits spec section 5): the live membership
 * (plan, status, period end, cancel date) with a link to `/admin/memberships/[id]`, or "Not a
 * member". Async server component; needs `credits.read`, renders nothing otherwise.
 */
import Link from "next/link";
import { Badge, buttonVariants, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { formatDate, type Locale } from "@beam/core/i18n";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getMembership, getPersonCredits } from "../queries";

export async function PersonMembershipPanel({ personId, locale }: { personId: string; locale: Locale }) {
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff" || !hasPermission(actor, "credits.read")) return null;
  const db = await getAppDb();
  const summary = await getPersonCredits(db, personId).catch(() => null);
  if (!summary) return null;
  const tr = translator(locale);
  const p = (k: string, params?: Record<string, string | number>) => tr(`credits.admin.panel.${k}`, params);
  const detail = summary.membership ? await getMembership(db, summary.membership.id).catch(() => null) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{p("membership")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {detail ? (
          <>
            <p className="font-medium">{detail.planName[locale] ?? detail.planName.en}</p>
            <p className="flex flex-wrap items-center gap-2">
              <Badge variant={detail.membership.status === "past_due" ? "destructive" : "success"}>{tr(`credits.enum.membership_status.${detail.membership.status}`)}</Badge>
              <span>{p("member_until", { date: formatDate(detail.membership.currentPeriodEndAt, locale, "medium") })}</span>
            </p>
            {detail.membership.cancelAt ? (
              <p>
                {tr("credits.admin.membership.cancel_at")}: {formatDate(detail.membership.cancelAt, locale, "medium")}
              </p>
            ) : null}
            <div>
              <Link href={`/admin/memberships/${detail.membership.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                {p("open_membership")}
              </Link>
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">{p("not_member")}</p>
        )}
        <p className="text-muted-foreground">{p("status", { status: tr(`credits.enum.person_status.${summary.status}`) })}</p>
      </CardContent>
    </Card>
  );
}
