import type { Route } from "next";
import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import { formatDate, formatMoney, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listPromotions, type PromotionState } from "@/modules/commerce/queries";
import { PageHeader, PrimaryAction, Segmented, StatusPill, Surface, Toolbar, td, th } from "@/modules/platform/ui/admin-kit";
import { rowClass, rowLink } from "@/modules/platform/ui/admin-list-kit";
import { CatalogueSwitch } from "../catalogue-switch";

const STATES: readonly PromotionState[] = ["active", "scheduled", "ended"];

/** `/admin/products/promotions` (`pricing.write`): tabs active, scheduled, ended (commerce spec 5.1); a switch back to Producten. */
export default async function PromotionsPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  await requireStaff({ permission: "pricing.write" });
  const sp = await searchParams;
  const state: PromotionState = (STATES as readonly string[]).includes(sp.state ?? "") ? (sp.state as PromotionState) : "active";
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_promotions.${k}`, p);
  const rows = await listPromotions(await getAppDb(), { state });
  const date = (d: Date) => formatDate(d, locale, "medium");

  return (
    <div className="grid gap-4">
      <PageHeader title={c("title")} description={c("subtitle")} actions={<PrimaryAction href="/admin/products/promotions/new">+ {c("create")}</PrimaryAction>} />
      <Toolbar>
        <Segmented label={c("title")} items={STATES.map((s) => ({ key: s, label: c(`tab_${s}`), href: `/admin/products/promotions?state=${s}` as Route, active: s === state }))} />
        <CatalogueSwitch active="promotions" tr={tr} />
      </Toolbar>
      {rows.length === 0 ? (
        <EmptyState title={c("empty")} action={<PrimaryAction href="/admin/products/promotions/new">+ {c("create")}</PrimaryAction>} />
      ) : (
        <Surface flush data-testid="promotions-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-[0.8125rem]">
              <caption className="sr-only">{c("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={cn(th, "w-44")}>{c("col_code")}</th>
                  <th scope="col" className={th}>{c("col_name")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{c("col_value")}</th>
                  <th scope="col" className={cn(th, "w-56")}>{c("col_dates")}</th>
                  <th scope="col" className={cn(th, "w-32 text-right")}>{c("col_uses")}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{c("col_per_person")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={rowClass}>
                    <td className={cn(td, "font-semibold whitespace-nowrap")}>
                      <Link href={`/admin/products/promotions/${p.id}`} className={cn(rowLink, "hover:underline")}>
                        {p.code ?? c("automatic")}
                      </Link>
                    </td>
                    <td className={td}>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{(p.name as LocalizedText)[locale]?.trim() || "—"}</span>
                        {p.code === null ? <StatusPill tone="gold">{c("automatic")}</StatusPill> : null}
                      </span>
                    </td>
                    <td className={cn(td, "font-semibold tabular-nums")}>{p.kind === "percent" ? c("value_percent", { value: p.value }) : c("value_fixed", { amount: formatMoney(p.value, locale) })}</td>
                    <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{p.endsAt ? c("dates_closed", { from: date(p.startsAt), until: date(p.endsAt) }) : c("dates_open", { from: date(p.startsAt) })}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{p.maxUses === null ? c("uses_unlimited", { used: p.usesCount }) : c("uses", { used: p.usesCount, max: p.maxUses })}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{p.maxUsesPerPerson ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
