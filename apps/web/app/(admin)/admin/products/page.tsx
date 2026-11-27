import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { cn, EmptyState } from "@beam/ui";
import { FOOD_DRINK_CATEGORIES } from "@beam/core/commerce";
import { formatMoney, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { commerceLabels, listProducts } from "@/modules/commerce/queries";
import { ProductActiveToggle } from "@/modules/commerce/ui/product-form";
import { PageHeader, PrimaryAction, StatusPill, Surface, Toolbar, td, th } from "@/modules/platform/ui/admin-kit";
import { aboveRow, fieldClass, rowClass, rowLink, SearchField } from "@/modules/platform/ui/admin-list-kit";
import { CatalogueSwitch } from "./catalogue-switch";

/** The list's groups in catalogue order: the product kinds, with food and drinks (items) last. */
const GROUPS = ["session", "night", "package", "membership", "ticket", "voucher", "item", "food"] as const;
type Group = (typeof GROUPS)[number];

const groupOf = (r: { kind: string; itemCategory: string | null }): Group =>
  r.kind === "item" && (FOOD_DRINK_CATEGORIES as readonly (string | null)[]).includes(r.itemCategory) ? "food" : (r.kind as Group);

const SHOP_ICON = (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="size-3">
    <path d="M3 5h10l-.8 8.2a1 1 0 0 1-1 .8H4.8a1 1 0 0 1-1-.8z" />
    <path d="M6 7V4a2 2 0 0 1 4 0v3" strokeLinecap="round" />
  </svg>
);
const TILL_ICON = (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="size-3">
    <rect x="2" y="7" width="12" height="7" rx="1" />
    <path d="M4.5 7V3h7v4M5 10h2" strokeLinecap="round" />
  </svg>
);

function Channel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
      {icon}
      {children}
    </span>
  );
}

/**
 * `/admin/products` (`pricing.write`, read-only for `commerce.sell`), commerce spec 5.1: the
 * catalogue of the shop and the till, grouped by kind (food and drinks apart from the other
 * items). One search on name or SKU, the kind and the status as two compact selects (`?kind=`,
 * `?state=`), and the switch to Promoties (`pricing.write`). Each row opens the product editor;
 * its switch activates or deactivates it (inactive rows are muted). Member and business prices
 * show only when they differ from the public price.
 */
export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ kind?: string; state?: string; q?: string }> }) {
  const actor = await requireStaff();
  const canEdit = hasPermission(actor, "pricing.write");
  if (!canEdit && !hasPermission(actor, "commerce.sell")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_products.${k}`, p);
  const kind = (GROUPS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as Group) : undefined;
  const state = sp.state === "active" || sp.state === "inactive" ? sp.state : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const all = await listProducts(await getAppDb());
  const nameOf = (r: (typeof all)[number]) => (r.name as LocalizedText)[locale]?.trim() || r.sku;
  const needle = q?.toLowerCase();
  const matching = all.filter((r) => (!state || (state === "active") === r.isActive) && (!needle || r.sku.toLowerCase().includes(needle) || Object.values(r.name as LocalizedText).some((n) => n?.toLowerCase().includes(needle))));
  const rows = matching.filter((r) => !kind || groupOf(r) === kind);
  const groups = GROUPS.map((g) => ({ group: g, rows: rows.filter((r) => groupOf(r) === g) })).filter((g) => g.rows.length);
  const filtered = !!(kind || state || q);
  const money = (v: number | null) => (v === null ? "—" : formatMoney(v, locale));
  const labels = commerceLabels(locale, ["common", "admin_products"]);
  const COLS = 7;

  const create: Route = "/admin/products/new";
  /** Member or business price: shown only when it differs from the public price. */
  const otherPrice = (v: number | null, pub: number | null) =>
    v === null || v === pub ? (
      <span className="text-muted-foreground/70" title={c("same_price")}>
        —
      </span>
    ) : (
      money(v)
    );

  return (
    <div className="grid gap-4">
      <PageHeader title={c("title")} description={canEdit ? undefined : c("read_only")} actions={canEdit ? <PrimaryAction href={create}>+ {c("create")}</PrimaryAction> : null} />
      <form data-auto-filter="" method="get" role="search">
        <Toolbar>
          <SearchField label={c("search")} placeholder={c("search")} defaultValue={q} />
          <label className="flex items-center">
            <span className="sr-only">{c("filter_kind")}</span>
            <select name="kind" defaultValue={kind ?? ""} className={cn(fieldClass, "w-auto pr-7")}>
              <option value="">{`${c("kind_all")} (${matching.length})`}</option>
              {GROUPS.filter((g) => kind === g || matching.some((r) => groupOf(r) === g)).map((g) => (
                <option key={g} value={g}>{`${c(`group_${g}`)} (${matching.filter((r) => groupOf(r) === g).length})`}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center">
            <span className="sr-only">{c("filter_state")}</span>
            <select name="state" defaultValue={state ?? ""} className={cn(fieldClass, "w-auto pr-7")}>
              <option value="">{`${c("filter_state")}: ${tr("commerce.common.all")}`}</option>
              <option value="active">{tr("commerce.common.active")}</option>
              <option value="inactive">{tr("commerce.common.inactive")}</option>
            </select>
          </label>
          {canEdit ? <CatalogueSwitch active="products" tr={tr} /> : null}
        </Toolbar>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={filtered ? c("none_match") : c("empty")} action={canEdit && !filtered ? <PrimaryAction href={create}>+ {c("create")}</PrimaryAction> : undefined} />
      ) : (
        <Surface flush data-testid="products-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-[0.8125rem]">
              <caption className="sr-only">{c("title")}</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{c("col_name")}</th>
                  <th scope="col" className={cn(th, "w-14 text-right")}>{c("col_vat")}</th>
                  <th scope="col" className={cn(th, "w-32 text-right")}>{c("col_public")}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{c("col_member")}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{c("col_b2b")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{c("col_visible")}</th>
                  <th scope="col" className={cn(th, "w-20")}>{c("col_active")}</th>
                </tr>
              </thead>
              {groups.map(({ group, rows: list }) => (
                <tbody key={group} data-group={group}>
                  <tr className="border-b border-border bg-[#faf9f6]">
                    <th scope="colgroup" colSpan={COLS} className="px-5 py-1.5 text-left text-[0.6875rem] font-semibold tracking-wide text-muted-foreground uppercase">
                      {c(`group_${group}`)} <span className="ml-1 font-normal tabular-nums">{list.length}</span>
                    </th>
                  </tr>
                  {list.map((r) => {
                    const name = nameOf(r);
                    return (
                      <tr key={r.id} className={cn(canEdit ? rowClass : "border-b border-border last:border-b-0", !r.isActive && "[&>td:not(:last-child)]:opacity-55")} data-active={r.isActive ? "true" : "false"}>
                        <td className={td}>
                          {canEdit ? (
                            <Link href={`/admin/products/${r.id}`} className={cn(rowLink, "font-semibold hover:underline")}>
                              {name}
                            </Link>
                          ) : (
                            <span className="font-semibold">{name}</span>
                          )}
                          <span className="block text-[0.6875rem] text-muted-foreground">{r.sku}</span>
                        </td>
                        <td className={cn(td, "text-right tabular-nums text-muted-foreground")}>{c("vat_value", { rate: Number(r.vatRatePct) })}</td>
                        <td className={cn(td, "text-right font-semibold whitespace-nowrap tabular-nums")}>{r.isCustomAmount ? `${money(r.minAmountCents)} – ${money(r.maxAmountCents)}` : money(r.current.public)}</td>
                        <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>{otherPrice(r.current.member, r.current.public)}</td>
                        <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>{otherPrice(r.current.b2b, r.current.public)}</td>
                        <td className={td}>
                          <span className="flex flex-wrap gap-1">
                            {r.isShopVisible ? <Channel icon={SHOP_ICON}>{c("col_shop")}</Channel> : null}
                            {r.isPosVisible ? <Channel icon={TILL_ICON}>{c("col_pos")}</Channel> : null}
                            {!r.isShopVisible && !r.isPosVisible ? <span className="text-muted-foreground/70">—</span> : null}
                          </span>
                        </td>
                        <td className={td}>
                          {canEdit ? (
                            <span className={aboveRow}>
                              <ProductActiveToggle productId={r.id} isActive={r.isActive} labels={labels} switchLabel={c("active_named", { name })} />
                            </span>
                          ) : (
                            <StatusPill tone={r.isActive ? "ok" : "muted"}>{r.isActive ? tr("commerce.common.active") : tr("commerce.common.inactive")}</StatusPill>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
