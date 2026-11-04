import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, buttonVariants, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { PRODUCT_KINDS, type ProductKind } from "@beam/core/commerce";
import { formatMoney, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { commerceLabels, listProducts } from "@/modules/commerce/queries";
import { ProductActiveToggle } from "@/modules/commerce/ui/product-form";

const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** `/admin/products` (`pricing.write`, read-only for `commerce.sell`), commerce spec 5.1. */
export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ kind?: string; state?: string }> }) {
  const actor = await requireStaff();
  const canEdit = hasPermission(actor, "pricing.write");
  if (!canEdit && !hasPermission(actor, "commerce.sell")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_products.${k}`, p);
  const kind = (PRODUCT_KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as ProductKind) : undefined;
  const state = sp.state === "active" || sp.state === "inactive" ? sp.state : undefined;
  const rows = (await listProducts(await getAppDb(), { ...(kind ? { kind } : {}), ...(state === "active" ? { activeOnly: true } : {}) })).filter(
    (r) => state !== "inactive" || !r.isActive,
  );
  const filtered = !!(kind || state);
  const money = (v: number | null) => (v === null ? "—" : formatMoney(v, locale));
  const labels = commerceLabels(locale, ["common", "admin_products"]);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{c("title")}</h1>
        <div className="flex gap-2">
          <Link href="/admin/products/promotions" className={buttonVariants({ variant: "outline" })}>
            {tr("commerce.nav.promotions")}
          </Link>
          {canEdit ? (
            <Link href="/admin/products/new" className={buttonVariants()}>
              {c("create")}
            </Link>
          ) : null}
        </div>
      </header>
      {canEdit ? null : <p className="text-sm text-muted-foreground">{c("read_only")}</p>}
      <form className="flex flex-wrap items-end gap-2" role="search">
        <select name="kind" defaultValue={kind ?? ""} aria-label={c("filter_kind")} className={selectClass}>
          <option value="">{tr("commerce.common.all")}</option>
          {PRODUCT_KINDS.map((k) => (
            <option key={k} value={k}>
              {tr(`commerce.product_kind.${k}`)}
            </option>
          ))}
        </select>
        <select name="state" defaultValue={state ?? ""} aria-label={c("filter_state")} className={selectClass}>
          <option value="">{tr("commerce.common.all")}</option>
          <option value="active">{tr("commerce.common.active")}</option>
          <option value="inactive">{tr("commerce.common.inactive")}</option>
        </select>
        <Button type="submit" variant="outline">
          {tr("commerce.common.filter")}
        </Button>
        {filtered ? (
          <Link href="/admin/products" className={buttonVariants({ variant: "ghost" })}>
            {tr("commerce.common.clear_filters")}
          </Link>
        ) : null}
      </form>
      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? c("none_match") : c("empty")}
          action={
            canEdit && !filtered ? (
              <Link href="/admin/products/new" className={buttonVariants()}>
                {c("create")}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{c("col_name")}</TableHead>
              <TableHead>{c("col_kind")}</TableHead>
              <TableHead>{c("col_sku")}</TableHead>
              <TableHead className="text-right">{c("col_vat")}</TableHead>
              <TableHead className="text-right">{c("col_public")}</TableHead>
              <TableHead className="text-right">{c("col_member")}</TableHead>
              <TableHead className="text-right">{c("col_b2b")}</TableHead>
              <TableHead>{c("col_active")}</TableHead>
              <TableHead>{c("col_shop")}</TableHead>
              <TableHead>{c("col_pos")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const name = (r.name as LocalizedText)[locale]?.trim() || r.sku;
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    {canEdit ? (
                      <Link href={`/admin/products/${r.id}`} className="font-medium underline-offset-4 hover:underline">
                        {name}
                      </Link>
                    ) : (
                      <span className="font-medium">{name}</span>
                    )}
                  </TableCell>
                  <TableCell>{tr(`commerce.product_kind.${r.kind}`)}</TableCell>
                  <TableCell className="font-mono text-sm">{r.sku}</TableCell>
                  <TableCell className="text-right tabular-nums">{c("vat_value", { rate: Number(r.vatRatePct) })}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.isCustomAmount ? `${money(r.minAmountCents)} – ${money(r.maxAmountCents)}` : money(r.current.public)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.current.member)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.current.b2b)}</TableCell>
                  <TableCell>
                    {canEdit ? (
                      <div className="flex items-center gap-2">
                        <Badge variant={r.isActive ? "secondary" : "outline"}>{r.isActive ? tr("commerce.common.active") : tr("commerce.common.inactive")}</Badge>
                        <ProductActiveToggle productId={r.id} isActive={r.isActive} labels={labels} />
                      </div>
                    ) : (
                      <Badge variant={r.isActive ? "secondary" : "outline"}>{r.isActive ? tr("commerce.common.active") : tr("commerce.common.inactive")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>{r.isShopVisible ? tr("commerce.common.yes") : tr("commerce.common.no")}</TableCell>
                  <TableCell>{r.isPosVisible ? tr("commerce.common.yes") : tr("commerce.common.no")}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
