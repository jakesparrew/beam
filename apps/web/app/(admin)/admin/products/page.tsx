import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { PRODUCT_KINDS, type ProductKind } from "@beam/core/commerce";
import { formatMoney, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { commerceLabels, listProducts } from "@/modules/commerce/queries";
import { ProductActiveToggle } from "@/modules/commerce/ui/product-form";
import { PageHeader, PrimaryAction, Segmented, StatusPill, Surface, Toolbar, td, th } from "@/modules/platform/ui/admin-kit";
import { aboveRow, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";
import { CatalogueSwitch } from "./catalogue-switch";

/**
 * `/admin/products` (`pricing.write`, read-only for `commerce.sell`), commerce spec 5.1: the
 * catalogue of the shop and the till. A search on name or SKU, the kind and active/inactive as
 * tabs, and a switch to Promoties (`pricing.write`); each row opens the product editor.
 */
export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ kind?: string; state?: string; q?: string }> }) {
  const actor = await requireStaff();
  const canEdit = hasPermission(actor, "pricing.write");
  if (!canEdit && !hasPermission(actor, "commerce.sell")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_products.${k}`, p);
  const kind = (PRODUCT_KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as ProductKind) : undefined;
  const state = sp.state === "active" || sp.state === "inactive" ? sp.state : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const all = await listProducts(await getAppDb());
  const nameOf = (r: (typeof all)[number]) => (r.name as LocalizedText)[locale]?.trim() || r.sku;
  const needle = q?.toLowerCase();
  const matching = all.filter((r) => (!state || (state === "active") === r.isActive) && (!needle || r.sku.toLowerCase().includes(needle) || Object.values(r.name as LocalizedText).some((n) => n?.toLowerCase().includes(needle))));
  const rows = matching.filter((r) => !kind || r.kind === kind);
  const filtered = !!(kind || state || q);
  const money = (v: number | null) => (v === null ? "—" : formatMoney(v, locale));
  const labels = commerceLabels(locale, ["common", "admin_products"]);

  const current: Record<string, string | undefined> = { q, kind, state };
  const href = (patch: Record<string, string | undefined>): Route => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/products?${s}` : "/admin/products";
  };

  return (
    <div className="grid gap-4">
      <PageHeader title={c("title")} description={canEdit ? c("subtitle") : c("read_only")} actions={canEdit ? <PrimaryAction href="/admin/products/new">+ {c("create")}</PrimaryAction> : null} />
      <form data-auto-filter="" method="get" role="search">
        {kind ? <input type="hidden" name="kind" value={kind} /> : null}
        {state ? <input type="hidden" name="state" value={state} /> : null}
        <Toolbar>
          <SearchField label={c("search")} placeholder={c("search")} defaultValue={q} />
          <Segmented
            label={c("filter_kind")}
            items={[
              { key: "all", label: tr("commerce.common.all"), href: href({ kind: undefined }), active: !kind, count: matching.length },
              ...PRODUCT_KINDS.filter((k) => matching.some((r) => r.kind === k) || kind === k).map((k) => ({
                key: k,
                label: tr(`commerce.product_kind.${k}`),
                href: href({ kind: k }),
                active: kind === k,
                count: matching.filter((r) => r.kind === k).length,
              })),
            ]}
          />
          <Segmented
            label={c("filter_state")}
            items={[
              { key: "all", label: tr("commerce.common.all"), href: href({ state: undefined }), active: !state },
              { key: "active", label: tr("commerce.common.active"), href: href({ state: "active" }), active: state === "active" },
              { key: "inactive", label: tr("commerce.common.inactive"), href: href({ state: "inactive" }), active: state === "inactive" },
            ]}
          />
          {canEdit ? <CatalogueSwitch active="products" tr={tr} /> : null}
        </Toolbar>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={filtered ? c("none_match") : c("empty")} action={canEdit && !filtered ? <PrimaryAction href="/admin/products/new">+ {c("create")}</PrimaryAction> : undefined} />
      ) : (
        <Surface flush data-testid="products-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-[0.8125rem]">
              <caption className="sr-only">{c("title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{c("col_name")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{c("col_kind")}</th>
                  <th scope="col" className={cn(th, "w-16 text-right")}>{c("col_vat")}</th>
                  <th scope="col" className={cn(th, "w-36 text-right")}>{c("col_public")}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{c("col_member")}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{c("col_b2b")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{c("col_visible")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{c("col_active")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const name = nameOf(r);
                  return (
                    <tr key={r.id} className={canEdit ? rowClass : "border-b border-border last:border-b-0"}>
                      <td className={td}>
                        {canEdit ? (
                          <Link href={`/admin/products/${r.id}`} className={cn(rowLink, "font-semibold hover:underline")}>
                            {name}
                          </Link>
                        ) : (
                          <span className="font-semibold">{name}</span>
                        )}
                        <span className="block text-[0.75rem] text-muted-foreground">{r.sku}</span>
                      </td>
                      <td className={td}>{tr(`commerce.product_kind.${r.kind}`)}</td>
                      <td className={cn(td, "text-right tabular-nums text-muted-foreground")}>{c("vat_value", { rate: Number(r.vatRatePct) })}</td>
                      <td className={cn(td, "text-right font-semibold whitespace-nowrap tabular-nums")}>{r.isCustomAmount ? `${money(r.minAmountCents)} – ${money(r.maxAmountCents)}` : money(r.current.public)}</td>
                      <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>{money(r.current.member)}</td>
                      <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>{money(r.current.b2b)}</td>
                      <td className={td}>
                        <span className="flex flex-wrap gap-1">
                          {r.isShopVisible ? <StatusPill tone="muted">{c("col_shop")}</StatusPill> : null}
                          {r.isPosVisible ? <StatusPill tone="muted">{c("col_pos")}</StatusPill> : null}
                          {!r.isShopVisible && !r.isPosVisible ? <span className="text-muted-foreground">—</span> : null}
                        </span>
                      </td>
                      <td className={td}>
                        <div className="flex items-center gap-2">
                          <StatusPill tone={r.isActive ? "ok" : "muted"}>{r.isActive ? tr("commerce.common.active") : tr("commerce.common.inactive")}</StatusPill>
                          {canEdit ? (
                            <span className={aboveRow}>
                              <ProductActiveToggle productId={r.id} isActive={r.isActive} labels={labels} />
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
