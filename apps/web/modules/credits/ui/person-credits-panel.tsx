/**
 * `PersonCreditsPanel` for crm's person page (credits spec section 5, rule 39): totals per kind
 * with the next expiry, the active packages with quick links, the membership badge and, with
 * `credits.adjust`, "New grant". Async server component; needs `credits.read`, renders nothing
 * otherwise.
 */
import Link from "next/link";
import type { Route } from "next";
import { Badge, buttonVariants, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { formatDate, type Locale } from "@beam/core/i18n";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getPersonCredits } from "../queries";
import { grantName, statusVariant, unitsText } from "./grants-table";

export async function PersonCreditsPanel({ personId, locale }: { personId: string; locale: Locale }) {
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff" || !hasPermission(actor, "credits.read")) return null;
  const data = await getPersonCredits(await getAppDb(), personId).catch(() => null);
  if (!data) return null;
  const tr = translator(locale);
  const p = (k: string, params?: Record<string, string | number>) => tr(`credits.admin.panel.${k}`, params);
  const usable = data.byKind.filter((k) => k.remainingUnits > 0);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{p("title")}</CardTitle>
        {data.membership ? (
          <Badge variant={data.membership.status === "past_due" ? "destructive" : "success"}>
            {data.membership.status === "past_due" ? tr("credits.enum.membership_status.past_due") : p("member_until", { date: formatDate(data.membership.periodEndAt, locale, "medium") })}
          </Badge>
        ) : (
          <Badge variant="outline">{p("not_member")}</Badge>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <section aria-label={p("totals")}>
          {usable.length === 0 ? (
            <p className="text-sm text-muted-foreground">{p("none")}</p>
          ) : (
            <ul className="grid gap-1">
              {usable.map((k) => (
                <li key={k.kind} className="text-sm">
                  <span className="font-medium">{tr(`credits.enum.kind.${k.kind}`)}</span>: {unitsText(k.kind, k.remainingUnits, locale)}
                  {k.nextExpiresAt ? <span className="text-muted-foreground"> ({p("next_expiry", { date: formatDate(k.nextExpiresAt, locale, "medium") })})</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        {data.activeGrants.length ? (
          <section aria-label={p("active_grants")}>
            <ul className="grid gap-1">
              {data.activeGrants.slice(0, 10).map((g) => (
                <li key={g.grantId} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link href={`/admin/credits/grants/${g.grantId}`} className="font-medium hover:underline">
                    {grantName({ productName: g.productName, label: g.label, source: g.source }, locale, tr("credits.admin.grants.untitled"))}
                  </Link>
                  <span className="tabular-nums">{tr("credits.admin.units.remaining_of", { remaining: g.remainingUnits, base: g.baseUnits })}</span>
                  <Badge variant={statusVariant(g.status)}>{tr(`credits.enum.grant_status.${g.status}`)}</Badge>
                  {g.expiresAt ? <span className="text-muted-foreground">{formatDate(g.expiresAt, locale, "medium")}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Link href={`/admin/credits?person=${personId}` as Route} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {p("all")}
          </Link>
          {hasPermission(actor, "credits.adjust") ? (
            <Link href={`/admin/credits/new?personId=${personId}` as Route} className={buttonVariants({ size: "sm" })}>
              {p("new")}
            </Link>
          ) : null}
          {data.membership ? (
            <Link href={`/admin/memberships/${data.membership.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              {p("open_membership")}
            </Link>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
