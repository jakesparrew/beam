/**
 * `PersonMembershipPanel` for crm's person page (credits spec section 5, owner's membership
 * requirements): the membership (plan, status, valid until, cancel date) with what the member
 * sees in the portal (free sessions and the either/or choice, member discounts) and a link to
 * `/admin/memberships/[id]`, or "Not a member". Async server component; needs `credits.read`,
 * renders nothing otherwise.
 */
import Link from "next/link";
import { buttonVariants, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { formatDate, type Locale } from "@beam/core/i18n";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getMyMembership } from "../queries";
import { MembershipStatusBadge } from "./membership-card";
import { MembershipUsage } from "./membership-usage";

export async function PersonMembershipPanel({ personId, locale }: { personId: string; locale: Locale }) {
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff" || !hasPermission(actor, "credits.read")) return null;
  const m = await getMyMembership(await getAppDb(), personId).catch(() => null);
  const tr = translator(locale);
  const p = (k: string, params?: Record<string, string | number>) => tr(`credits.admin.panel.${k}`, params);
  const live = m?.status === "active" || m?.status === "past_due";
  return (
    <Card data-testid="panel-membership">
      <CardHeader>
        <CardTitle>{p("membership")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {m ? (
          <>
            <div className="grid gap-1">
              <p className="font-medium">{m.planName[locale] ?? m.planName.en}</p>
              <p className="flex flex-wrap items-center gap-2">
                <MembershipStatusBadge status={m.status} locale={locale} />
                {live || m.status === "pending" ? <span>{p("member_until", { date: formatDate(m.currentPeriodEndAt, locale, "medium") })}</span> : null}
              </p>
              {m.cancelAt ? (
                <p>
                  {tr("credits.admin.membership.cancel_at")}: {formatDate(m.cancelAt, locale, "medium")}
                </p>
              ) : null}
            </div>
            {live ? <MembershipUsage membership={m} locale={locale} /> : null}
            <div>
              <Link href={`/admin/memberships/${m.membershipId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                {p("open_membership")}
              </Link>
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">{p("not_member")}</p>
        )}
      </CardContent>
    </Card>
  );
}
