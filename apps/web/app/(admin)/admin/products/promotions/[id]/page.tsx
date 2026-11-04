import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime, formatMoney, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { brusselsInputValue, commerceLabels, getPromotion, listProductOptions, promotionFormOptions } from "@/modules/commerce/queries";
import { PromotionForm } from "@/modules/commerce/ui/promotion-form";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/products/promotions/[id]` (`pricing.write`): edit (locked fields after use, rule 18) and redemptions. */
export default async function PromotionPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "pricing.write" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getAppDb();
  const detail = await getPromotion(db, id);
  if (!detail) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_promotions.${k}`, p);
  const { promotion: p, counts, redemptions, overrun } = detail;
  const e = p.eligibility ?? {};
  const labels = {
    ...commerceLabels(locale, ["common", "admin_promotions"]),
    invalid: tr("commerce.admin_products.invalid"),
    locked: c("locked", { count: p.usesCount }),
  };

  return (
    <div className="grid gap-8">
      <Link href="/admin/products/promotions" className="text-sm underline-offset-4 hover:underline">
        {c("back_to_list")}
      </Link>
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{p.code ?? ((p.name as LocalizedText)[locale]?.trim() || c("automatic"))}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {p.code === null ? <Badge variant="outline">{c("automatic")}</Badge> : null}
          <span>{p.maxUses === null ? c("uses_unlimited", { used: p.usesCount }) : c("uses", { used: p.usesCount, max: p.maxUses })}</span>
          <span>{c("counts", counts)}</span>
        </p>
        {overrun > 0 ? <p className="text-sm text-amber-700 dark:text-amber-400">{c("overrun", { count: overrun })}</p> : null}
      </header>

      <PromotionForm
        initial={{
          id: p.id,
          code: p.code ?? "",
          name: p.name,
          kind: p.kind,
          value: p.kind === "fixed" ? String(p.value / 100) : String(p.value),
          productIds: p.appliesTo.product_ids ?? [],
          productKinds: p.appliesTo.product_kinds ?? [],
          statuses: e.statuses ?? [],
          channels: e.channels ?? [],
          segmentId: e.segment_id ?? "",
          firstOrderOnly: e.first_order_only === true,
          startsAt: brusselsInputValue(p.startsAt),
          endsAt: brusselsInputValue(p.endsAt),
          maxUses: p.maxUses === null ? "" : String(p.maxUses),
          maxUsesPerPerson: p.maxUsesPerPerson === null ? "" : String(p.maxUsesPerPerson),
          isActive: p.isActive,
        }}
        usesCount={p.usesCount}
        options={promotionFormOptions(tr, locale, await listProductOptions(db))}
        labels={labels}
      />

      <section className="grid gap-3" aria-labelledby="redemptions-title">
        <h2 id="redemptions-title" className="text-lg font-semibold">
          {c("redemptions")}
        </h2>
        {redemptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{c("redemptions_empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c("col_order")}</TableHead>
                <TableHead>{c("col_person")}</TableHead>
                <TableHead className="text-right">{c("col_discount")}</TableHead>
                <TableHead>{c("col_status")}</TableHead>
                <TableHead>{c("col_date")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {redemptions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-sm">{r.orderReference}</TableCell>
                  <TableCell>
                    {r.personId ? (
                      <Link href={`/admin/persons/${r.personId}`} className="underline-offset-4 hover:underline">
                        {r.personName ?? "—"}
                      </Link>
                    ) : (
                      c("anonymous")
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.discountCents, locale)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{tr(`commerce.redemption_status.${r.status}`)}</Badge>
                  </TableCell>
                  <TableCell>{formatDateTime(r.createdAt, locale, "short")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
