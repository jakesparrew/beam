import Link from "next/link";
import { Badge, buttonVariants, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDate, formatMoney, type LocalizedText } from "@beam/core/i18n";
import { cn } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listPromotions, type PromotionState } from "@/modules/commerce/queries";

const STATES: readonly PromotionState[] = ["active", "scheduled", "ended"];

/** `/admin/products/promotions` (`pricing.write`): tabs active, scheduled, ended (commerce spec 5.1). */
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
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{c("title")}</h1>
        <div className="flex gap-2">
          <Link href="/admin/products" className={buttonVariants({ variant: "outline" })}>
            {tr("commerce.nav.products")}
          </Link>
          <Link href="/admin/products/promotions/new" className={buttonVariants()}>
            {c("create")}
          </Link>
        </div>
      </header>
      <nav aria-label={c("title")} className="flex gap-1 border-b">
        {STATES.map((s) => (
          <Link
            key={s}
            href={`/admin/products/promotions?state=${s}`}
            aria-current={s === state ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", s === state ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {c(`tab_${s}`)}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState
          title={c("empty")}
          action={
            <Link href="/admin/products/promotions/new" className={buttonVariants()}>
              {c("create")}
            </Link>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{c("col_code")}</TableHead>
              <TableHead>{c("col_name")}</TableHead>
              <TableHead>{c("col_value")}</TableHead>
              <TableHead>{c("col_dates")}</TableHead>
              <TableHead className="text-right">{c("col_uses")}</TableHead>
              <TableHead className="text-right">{c("col_per_person")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link href={`/admin/products/promotions/${p.id}`} className="font-mono font-medium underline-offset-4 hover:underline">
                    {p.code ?? c("automatic")}
                  </Link>
                  {p.code === null ? (
                    <Badge variant="outline" className="ml-2">
                      {c("automatic")}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{(p.name as LocalizedText)[locale]?.trim() || "—"}</TableCell>
                <TableCell>{p.kind === "percent" ? c("value_percent", { value: p.value }) : c("value_fixed", { amount: formatMoney(p.value, locale) })}</TableCell>
                <TableCell>{p.endsAt ? c("dates_closed", { from: date(p.startsAt), until: date(p.endsAt) }) : c("dates_open", { from: date(p.startsAt) })}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.maxUses === null ? c("uses_unlimited", { used: p.usesCount }) : c("uses", { used: p.usesCount, max: p.maxUses })}
                </TableCell>
                <TableCell className="text-right tabular-nums">{p.maxUsesPerPerson ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
