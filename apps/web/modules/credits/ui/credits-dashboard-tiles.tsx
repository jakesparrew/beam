/**
 * Credits figures as tiles (credits spec section 5). `variant="credits"` is the top of
 * `/admin/credits` (active packages, units outstanding per kind, expiring in 30 days, value
 * outstanding from `v_credit_liability`); `variant="dashboard"` is ops' action dashboard
 * (expiring in 30 days, nearly used up at 80 % or more, memberships renewing in 30 days, past-due
 * memberships). Async server component: renders nothing for a viewer without `credits.read`.
 * The R2 sharing-review tile joins with credits-P8.
 */
import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { formatMoney, formatNumber, type Locale } from "@beam/core/i18n";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getCreditsTiles, type CreditsTiles } from "../queries";

type Tile = { key: string; title: string; value: string; detail?: string; href?: Route };

export function tilesFor(variant: "credits" | "dashboard", t: CreditsTiles, locale: Locale): Tile[] {
  const tr = translator(locale);
  const k = (s: string) => tr(`credits.admin.tiles.${s}`);
  const n = (v: number) => formatNumber(v, locale);
  if (variant === "credits") {
    return [
      { key: "active", title: k("active_grants"), value: n(t.activeGrants) },
      {
        key: "outstanding",
        title: k("outstanding"),
        value: t.outstanding
          .filter((o) => o.kind !== "euro")
          .map((o) => `${tr(`credits.enum.kind.${o.kind}`)}: ${n(o.units)}`)
          .join(" · "),
        detail: `${tr("credits.enum.kind.euro")}: ${formatMoney(t.outstanding.find((o) => o.kind === "euro")?.units ?? 0, locale)}`,
      },
      { key: "expiring", title: k("expiring"), value: n(t.expiringIn30Days), href: "/admin/credits?expiring=30" },
      { key: "value", title: k("value"), value: formatMoney(t.outstandingValueCents, locale) },
    ];
  }
  return [
    { key: "expiring", title: k("expiring"), value: n(t.expiringIn30Days), href: "/admin/credits?expiring=30" },
    { key: "nearly", title: k("nearly_finished"), value: n(t.nearlyFinished), href: "/admin/credits?status=active" },
    { key: "renewing", title: k("renewing"), value: n(t.membershipsRenewingIn30Days), href: "/admin/memberships?renewing=30" },
    { key: "past_due", title: k("past_due"), value: n(t.pastDueMemberships), href: "/admin/memberships?status=past_due" },
  ];
}

export function TilesView({ tiles, label }: { tiles: Tile[]; label: string }) {
  return (
    <section aria-label={label} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.key} className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {tile.href ? (
                <Link href={tile.href} className="hover:underline">
                  {tile.title}
                </Link>
              ) : (
                tile.title
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <p className="text-2xl font-semibold tabular-nums">{tile.value}</p>
            {tile.detail ? <p className="text-sm text-muted-foreground">{tile.detail}</p> : null}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

export async function CreditsDashboardTiles({ locale, variant = "dashboard", now }: { locale: Locale; variant?: "credits" | "dashboard"; now?: Date }) {
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff" || !hasPermission(actor, "credits.read")) return null;
  const tiles = await getCreditsTiles(await getAppDb(), { now });
  return <TilesView tiles={tilesFor(variant, tiles, locale)} label={translator(locale)("credits.admin.tiles.label")} />;
}
