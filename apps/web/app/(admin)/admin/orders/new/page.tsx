import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button, Combobox, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { CartItem, Quote } from "@beam/core/commerce";
import { formatMoney, t, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { createStaffOrder, findOrderPersons } from "@/modules/commerce/actions";
import { getQuote } from "@/modules/commerce/api";
import { listProductOptions } from "@/modules/commerce/queries";
import { getPerson } from "@/modules/crm/api";

const ROWS = [0, 1, 2] as const;
const UUID = /^[0-9a-f-]{36}$/i;
/** Staff orders sell what has no session: sessions, nights and tickets are booked in booking's screens. */
const STAFF_KINDS = new Set(["package", "membership", "voucher", "item"]);

type Search = Record<string, string | undefined>;

/** "Ann Peeters · ann@example.com" for the person picker. */
function personLabel(p: { name?: string | null; firstName?: string | null; lastName?: string | null; email: string | null }): string {
  return [p.name ?? [p.firstName, p.lastName].filter(Boolean).join(" "), p.email].filter(Boolean).join(" · ");
}

function itemsFrom(get: (key: string) => string | undefined): CartItem[] {
  const items: CartItem[] = [];
  for (const i of ROWS) {
    const productId = get(`product_${i}`);
    if (!productId || !UUID.test(productId)) continue;
    const quantity = Math.max(1, Math.min(50, Math.floor(Number(get(`qty_${i}`) ?? 1)) || 1));
    items.push({ productId, quantity });
  }
  return items;
}

/**
 * `/admin/orders/new` (commerce spec 5.1, rule 22a; `commerce.sell`): pick the person (or a
 * company id for B2B prices) and up to three products; "Show the price" re-renders with the quote
 * and the price each line uses (`pricing_trace` winner, "member discount 10 % beat promo"); "Create
 * draft order" writes the draft and opens it, where the payment path is chosen.
 */
export default async function NewOrderPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "commerce.sell")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_orders.${k}`, p);
  const errorText = (code: string) => (t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error"));
  const db = await getAppDb();
  const personId = sp.personId && UUID.test(sp.personId) ? sp.personId : undefined;
  const person = personId ? await getPerson(db, personId) : null;
  const companyId = sp.companyId && UUID.test(sp.companyId) ? sp.companyId : undefined;
  const products = (await listProductOptions(db)).filter((p) => p.isActive && STAFF_KINDS.has(p.kind));
  const items = itemsFrom((k) => sp[k]);
  const promo = sp.promo?.trim().slice(0, 40) || null;
  let quote: Quote | null = null;
  if ((personId || companyId) && items.length) {
    quote = await getQuote(db, { personId: personId ?? null, companyId: companyId ?? null, items, promoCode: promo, channel: "admin" }).catch(() => null);
  }
  const pickerLabels = (placeholder: string) => ({
    placeholder,
    search: tr("commerce.common.picker_search"),
    noMatch: tr("commerce.common.picker_no_match"),
    more: tr("commerce.common.picker_more", { count: "{count}" }),
  });
  const none = { value: "", label: tr("commerce.common.none") };
  const productOptions = [none, ...products.map((p) => ({ value: p.id, label: nameOf(p.id), hint: p.sku }))];

  /** The person picker searches as staff type (up to 8 matches, `commerce.find_order_persons`). */
  async function searchPeople(term: string) {
    "use server";
    const r = await findOrderPersons({ q: term });
    return r.ok ? r.data.map((p) => ({ value: p.id, label: personLabel(p), hint: p.customerNumber })) : [];
  }

  function nameOf(id: string) {
    const p = products.find((x) => x.id === id);
    return p ? (p.name as LocalizedText)[locale]?.trim() || p.sku : id;
  }

  async function onCreate(form: FormData) {
    "use server";
    const get = (key: string) => {
      const v = form.get(key);
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const pid = get("personId");
    const cid = get("companyId");
    const r = await createStaffOrder({
      personId: pid && UUID.test(pid) ? pid : null,
      companyId: cid && UUID.test(cid) ? cid : null,
      items: itemsFrom(get),
      promoCode: get("promo") ?? null,
      note: get("note") ?? null,
      clientKey: get("clientKey"),
    });
    if (r.ok) redirect(`/admin/orders/${r.data.orderId}` as never);
    redirect(`/admin/orders/new?error=${encodeURIComponent(r.error.message)}` as never);
  }

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <Link href="/admin/orders" className="text-sm underline">
          {c("back")}
        </Link>
        <h1 className="text-2xl font-semibold">{c("new_title")}</h1>
        <p className="text-sm text-muted-foreground">{c("new_intro")}</p>
      </header>
      <div role="status" aria-live="polite">
        {sp.error ? <p className="rounded-md border border-destructive p-3 text-sm">{c("failed", { message: errorText(sp.error) })}</p> : null}
      </div>

      <form method="get" className="grid gap-4">
        <input type="hidden" name="clientKey" value={sp.clientKey && UUID.test(sp.clientKey) ? sp.clientKey : randomUUID()} />
        <div className="grid w-96 max-w-full gap-1 text-sm">
          <span id="order-person-label">{c("person")}</span>
          <Combobox
            name="personId"
            defaultValue={personId ?? ""}
            options={person ? [{ value: person.id, label: personLabel(person), hint: person.customerNumber }] : []}
            onSearch={searchPeople}
            labels={{ ...pickerLabels(c("person_search")), search: c("person_search_hint") }}
            aria-labelledby="order-person-label"
          />
        </div>
        <label className="grid gap-1 text-sm">
          <span>{c("company_id")}</span>
          <Input name="companyId" defaultValue={companyId ?? ""} className="w-96" />
        </label>
        {ROWS.map((i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <div className="grid w-96 max-w-full gap-1 text-sm">
              <span id={`order-product-${i}`}>{c("product")}</span>
              <Combobox name={`product_${i}`} defaultValue={sp[`product_${i}`] ?? ""} options={productOptions} labels={pickerLabels(tr("commerce.common.none"))} aria-labelledby={`order-product-${i}`} />
            </div>
            <label className="grid gap-1 text-sm">
              <span>{c("quantity")}</span>
              <Input type="number" name={`qty_${i}`} min={1} max={50} defaultValue={sp[`qty_${i}`] ?? "1"} className="w-20" />
            </label>
          </div>
        ))}
        <label className="grid gap-1 text-sm">
          <span>{c("promo")}</span>
          <Input name="promo" defaultValue={promo ?? ""} className="w-48" />
        </label>
        <label className="grid gap-1 text-sm">
          <span>{c("note")}</span>
          <Input name="note" maxLength={1000} className="w-96" />
        </label>

        {quote ? (
          <section aria-labelledby="quote-title" className="grid gap-2">
            <h2 id="quote-title" className="text-lg font-semibold">{c("quote_title")}</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{c("col_description")}</TableHead>
                  <TableHead className="text-right">{c("col_quantity")}</TableHead>
                  <TableHead className="text-right">{c("col_unit")}</TableHead>
                  <TableHead className="text-right">{c("col_discount")}</TableHead>
                  <TableHead className="text-right">{c("col_line_total")}</TableHead>
                  <TableHead>{c("col_price")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quote.lines.map((l, i) => (
                  <TableRow key={`${l.productId}-${i}`}>
                    <TableCell>{nameOf(l.productId)}</TableCell>
                    <TableCell className="text-right">{l.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(l.unitAmountCents, locale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.discountCents ? formatMoney(l.discountCents, locale) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(l.lineTotalCents, locale)}</TableCell>
                    <TableCell>
                      {c(`winner_${l.trace.winner}`)}
                      {l.trace.candidates.length > 1 ? ` (${l.trace.candidates.map((x) => c(`winner_${x.source}`)).join(", ")})` : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-sm font-medium tabular-nums">
              {c("col_total")}: {formatMoney(quote.totalCents, locale)}
            </p>
            {quote.warnings.length ? <p className="text-sm text-muted-foreground">{quote.warnings.map((w) => errorText(w.code)).join(" ")}</p> : null}
          </section>
        ) : !personId && !companyId && items.length ? (
          <p className="text-sm">{c("choose_person")}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline">
            {c("preview")}
          </Button>
          <Button type="submit" formAction={onCreate} formMethod="post">
            {c("create")}
          </Button>
        </div>
      </form>
    </div>
  );
}
