import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button, Input } from "@beam/ui";
import type { CartItem, Quote } from "@beam/core/commerce";
import { BillingDetailsInput, type BillingDetails } from "@beam/core/finance";
import { formatDate, formatMoney, formatTime, t, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { listBookableSessions } from "@/modules/booking/api";
import { emailReceipt, issueOnAccountInvoice, posCreateWalkIn, posPayOrder, posSell, redeemVoucher, sendPaymentLink } from "@/modules/commerce/actions";
import { getQuote } from "@/modules/commerce/api";
import { ANONYMOUS_KINDS, businessDayOf, findPosBuyers, getPosOrder, isPosDayClosed, listOpenAccounts, listProducts, posTabProducts } from "@/modules/commerce/queries";
import { PosBasket, PosPaymentForm, type PosPaymentText } from "@/modules/commerce/ui/pos-basket";
import { PosBuyerSearch } from "@/modules/commerce/ui/pos-buyer-search";
import { POS_TABS, PosGrid, type PosTab } from "@/modules/commerce/ui/pos-grid";
import { Initials } from "@/modules/commerce/ui/kit";
import { TerminalDialog } from "@/modules/commerce/ui/terminal-dialog";
import { PageHeader, SecondaryAction } from "@/modules/platform/ui/admin-kit";
import { Notice } from "@/modules/platform/ui/admin-list-kit";
import { getEuroBalance } from "@/modules/credits/api";
import { getPerson } from "@/modules/crm/api";

type Search = Record<string, string | undefined>;
type Item = { productId: string; quantity: number; sessionId?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEEP = ["tab", "personId", "anon", "items", "promo", "clientKey"] as const;

/** The basket lives in the URL: `items=<productId>:<qty>[:<sessionId>],...`. */
function parseItems(raw: string | undefined): Item[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.split(":"))
    .filter(([pid, qty]) => pid && UUID.test(pid) && qty)
    .slice(0, 30)
    .map(([pid, qty, sid]) => ({ productId: pid!, quantity: Math.max(1, Math.min(50, Math.floor(Number(qty)) || 1)), ...(sid && UUID.test(sid) ? { sessionId: sid } : {}) }));
}
const encodeItems = (items: Item[]) => items.map((i) => [i.productId, i.quantity, i.sessionId].filter(Boolean).join(":")).join(",");

function href(sp: Search, patch: Record<string, string | null>): string {
  const q = new URLSearchParams();
  for (const k of KEEP) { const v = sp[k]; if (v) q.set(k, v); }
  for (const [k, v] of Object.entries(patch)) if (v === null || v === "") q.delete(k); else q.set(k, v);
  const s = q.toString();
  return s ? `/admin/pos?${s}` : "/admin/pos";
}

const field = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};
const cents = (v: string | undefined) => (v === undefined ? undefined : Math.round(Number(v.replace(/\s/g, "").replace(",", ".")) * 100));

const METHODS = ["terminal", "card_terminal", "cash", "bank_transfer"] as const;

/** The payment fields every POS payment form posts; the "Op rekening" button posts `onAccount=1`. */
function paymentFields(form: FormData) {
  const picked = field(form, "method");
  const method = field(form, "onAccount") === "1" ? "on_account" : (METHODS.find((m) => m === picked) ?? "card_terminal");
  const billing: BillingDetails | undefined = field(form, "companyName")
    ? BillingDetailsInput.safeParse({
        isCompany: true,
        legalName: field(form, "companyName"),
        vatNumber: field(form, "vatNumber"),
        address: { line1: field(form, "line1") ?? "", postal_code: field(form, "postalCode") ?? "", city: field(form, "city") ?? "", country: field(form, "country") ?? "BE" },
        billingEmail: field(form, "billingEmail"),
      }).data
    : undefined;
  return {
    method,
    terminalId: field(form, "terminalId"),
    terminalReference: method === "card_terminal" ? (field(form, "terminalReference") ?? null) : null,
    cashReceivedCents: method === "cash" ? (cents(field(form, "cashReceived")) ?? 0) : undefined,
    useEuroCredit: field(form, "useEuroCredit") === "1",
    ...(billing ? { billingDetails: billing } : {}),
    clientKey: field(form, "clientKey") && UUID.test(field(form, "clientKey")!) ? field(form, "clientKey")! : randomUUID(),
  };
}

/** The error code a failed action shows: the first field code, else the message. */
function errorCode(error: { message: string; fields?: Record<string, string> }): string {
  const [name, code] = Object.entries(error.fields ?? {})[0] ?? [];
  if (code === "too_low") return "cash_too_low";
  if (name === "note" && code === "required") return "note_required";
  return code && !code.includes(" ") && code !== "required" ? code : error.message;
}

function afterPayment(out: { orderId: string; status: string; changeCents?: number; paymentId?: string; dueOn?: string }, method: string): never {
  if (out.status === "pending_payment" && method === "terminal" && out.paymentId) redirect(`/admin/pos?order=${out.orderId}&payment=${out.paymentId}` as never);
  const q = new URLSearchParams({ done: out.orderId });
  if (out.changeCents) q.set("change", String(out.changeCents));
  if (out.dueOn) q.set("dueOn", out.dueOn);
  redirect(`/admin/pos?${q.toString()}` as never);
}

/**
 * `/admin/pos` (commerce spec 5.1, rules 21, 25, 26b, 42 to 45, 56; `commerce.sell`): the
 * reception screen. Left the product grid by kind with today's sessions and the food and drinks
 * (BEAM's till replaces Lightspeed); right the buyer (a live search with a dropdown, `persons.read`,
 * the walk-in quick-create, or anonymous), the basket with the live quote, euro credit, voucher
 * redemption and the payment, always shown (pay buttons disabled with one prompt to the buyer
 * search while a client is needed) (Kaart (terminal), cash, bank transfer, the integrated terminal when configured) or "Op
 * rekening" (needs a client; the order stays open on that person). `?order=<id>` opens a
 * `pending_payment` order read-only and pays it through `posPayOrder`; `?done=<id>` shows the
 * result with print and email receipt, or for an on-account order the three ways to settle it
 * (payment link, open invoice with `invoices.issue`, later at the till). A selected client's open
 * on-account orders are listed in the buyer panel to be paid here.
 */
export default async function PosPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "commerce.sell")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.pos.${k}`, p);
  const errorText = (code: string) => (t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error"));
  const db = await getAppDb();
  const settings = await getSetting(db, "commerce");
  const today = businessDayOf(new Date());
  const dayClosed = await isPosDayClosed(db, today);
  const money = (n: number) => formatMoney(n, locale);
  const name = (text: LocalizedText, fallback: string) => text[locale]?.trim() || fallback;

  const basketText = { empty: c("basket_empty"), remove: (n: string) => c("remove_named", { name: n }), quantity: c("quantity"), product: c("col_product"), amount: c("col_amount"), subtotal: c("subtotal"), discount: c("discount"), total: c("total"), due: c("due") };
  const paymentText = (euroCents: number | null): PosPaymentText => ({
    method: c("method"), cardTerminal: c("method_card_terminal"), terminalReference: c("terminal_reference"), onAccount: c("on_account"), onAccountNeedsPerson: c("on_account_needs_person"), terminal: c("method_terminal"), cash: c("method_cash"), bankTransfer: c("method_bank_transfer"), terminalLabel: c("terminal"), cashReceived: c("cash_received"),
    useEuroCredit: c("use_euro_credit"), euroCredit: euroCents !== null ? c("euro_credit", { amount: money(euroCents) }) : null, companyToggle: c("company_toggle"), companyName: c("company_name"),
    vatNumber: c("vat_number"), line1: c("address_line1"), postalCode: c("postal_code"), city: c("city"), country: c("country"), billingEmail: c("billing_email"), pay: c("pay"),
  });
  const header = (
    <div className="grid gap-2">
      <PageHeader title={tr("commerce.nav.pos")} actions={<SecondaryAction href="/admin/pos/day">{c("day_link")}</SecondaryAction>} />
      {dayClosed ? <Notice tone="warn">{c("day_closed_banner")}</Notice> : null}
      <div role="status" aria-live="polite" className="grid gap-2 empty:hidden">
        {sp.error ? <Notice tone="bad">{c("failed", { message: errorText(sp.error) })}</Notice> : null}
        {sp.msg === "voucher_redeemed" ? <Notice tone="ok">{c("voucher_redeemed", { amount: money(Number(sp.amount ?? 0)) })}</Notice> : null}
        {sp.msg === "receipt_sent" ? <Notice tone="ok">{c("receipt_sent")}</Notice> : null}
        {sp.msg === "link_sent" ? <Notice tone="ok">{c("link_sent")}</Notice> : null}
      </div>
    </div>
  );

  // -- The result of a payment ------------------------------------------------
  if (sp.done && UUID.test(sp.done)) {
    const view = await getPosOrder(db, sp.done);
    if (!view) notFound();
    const orderId = view.orderId;
    async function onEmail(form: FormData) {
      "use server";
      const r = await emailReceipt({ orderId, email: field(form, "email") });
      redirect(`/admin/pos?done=${orderId}&${r.ok ? "msg=receipt_sent" : `error=${encodeURIComponent(errorCode(r.error))}`}` as never);
    }
    const isPaid = view.status === "paid";
    const onAccount = view.status === "pending_payment" && !!view.onAccountAt;
    const canInvoice = hasPermission(actor, "invoices.issue");
    async function onLink() {
      "use server";
      const r = await sendPaymentLink({ orderId });
      redirect(`/admin/pos?done=${orderId}&${r.ok ? "msg=link_sent" : `error=${encodeURIComponent(errorCode(r.error))}`}` as never);
    }
    async function onInvoice() {
      "use server";
      const r = await issueOnAccountInvoice({ orderId });
      redirect(`/admin/pos?done=${orderId}&${r.ok ? `dueOn=${r.data.dueOn}` : `error=${encodeURIComponent(errorCode(r.error))}`}` as never);
    }
    return (
      <div className="grid gap-4">
        {header}
        <section aria-labelledby="pos-done-title" className="grid max-w-xl gap-3 rounded-xl border border-border bg-card p-5" data-pos-result={view.status}>
          <h2 id="pos-done-title" className="text-[1.125rem] font-semibold">{isPaid ? c("paid_title") : onAccount ? c("on_account_title") : c("order_title", { reference: view.reference })}</h2>
          {isPaid ? <p>{c("paid_body", { reference: view.reference })}</p> : null}
          {onAccount ? <p>{c("on_account_body", { reference: view.reference, amount: money(view.dueCents), name: view.personName ?? "" })}</p> : null}
          {isPaid && sp.change ? <p className="text-lg font-semibold">{c("change", { amount: money(Number(sp.change)) })}</p> : null}
          {sp.dueOn ? <p>{c("bank_transfer_open", { reference: view.reference, date: formatDate(sp.dueOn, locale, "long") })}</p> : null}
          {!isPaid && !sp.dueOn && !onAccount ? <p>{c("order_state", { status: tr(`commerce.order_status.${view.status}`) })}</p> : null}
          {onAccount ? (
            <div className="grid gap-2 border-t pt-3">
              <p className="text-sm font-medium">{c("settle_intro")}</p>
              <div className="flex flex-wrap gap-2">
                <form action={onLink}>
                  <Button type="submit" variant="outline" className="min-h-11" disabled={!view.personEmail}>{c("settle_link")}</Button>
                </form>
                {canInvoice && !sp.dueOn ? (
                  <form action={onInvoice}>
                    <Button type="submit" variant="outline" className="min-h-11">{c("settle_invoice")}</Button>
                  </form>
                ) : null}
                <Link href={`/admin/orders/${orderId}` as never} className="inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-4 font-semibold hover:bg-muted">{c("settle_desk")}</Link>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {isPaid ? <Link href={`/admin/pos/receipt/${orderId}` as never} className="inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-4 font-semibold hover:bg-muted">{c("print_receipt")}</Link> : null}
            <Link href="/admin/pos" className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 font-semibold text-primary-foreground hover:opacity-90">{c("new_sale")}</Link>
          </div>
          {isPaid ? (
            <form action={onEmail} className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1 text-sm">
                <span>{c("email_to")}</span>
                <Input name="email" type="email" defaultValue={view.personEmail ?? ""} className="h-11 w-72" />
              </label>
              <Button type="submit" variant="outline" className="min-h-11">{c("email_receipt")}</Button>
            </form>
          ) : null}
        </section>
      </div>
    );
  }

  // -- An existing order (`?order=`) -----------------------------------------
  if (sp.order && UUID.test(sp.order)) {
    const view = await getPosOrder(db, sp.order);
    if (!view) notFound();
    const orderId = view.orderId;
    async function onPayOrder(form: FormData) {
      "use server";
      const fields = paymentFields(form);
      const r = await posPayOrder({ orderId, ...fields });
      if (!r.ok) redirect(`/admin/pos?order=${orderId}&error=${encodeURIComponent(errorCode(r.error))}` as never);
      afterPayment(r.data, fields.method);
    }
    const euro = view.personId ? (await getEuroBalance(db, view.personId)).remainingCents : null;
    const terminalPaymentId = sp.payment && UUID.test(sp.payment) && view.liveTerminalPaymentId === sp.payment ? sp.payment : view.liveTerminalPaymentId;
    return (
      <div className="grid gap-4">
        {header}
        <div className="grid max-w-2xl gap-4">
          <PosBasket
            locale={locale}
            title={c("order_title", { reference: view.reference })}
            lines={view.lines.map((l) => ({ key: l.lineId, description: name(l.description, ""), quantity: l.quantity, lineTotalCents: l.lineTotalCents, discountCents: 0 }))}
            subtotalCents={view.totalCents}
            discountCents={0}
            totalCents={view.totalCents}
            dueCents={view.dueCents}
            notes={[
              ...(view.personName ? [c("selected_person", { name: view.personName })] : []),
              ...(view.expiresAt && view.status === "pending_payment" ? [c("order_expires", { time: formatTime(view.expiresAt, locale) })] : []),
              ...(view.onAccountAt && view.status === "pending_payment" ? [c("on_account_since", { date: formatDate(view.onAccountAt, locale, "long") })] : []),
              ...(view.status !== "pending_payment" ? [c("order_state", { status: tr(`commerce.order_status.${view.status}`) })] : []),
            ]}
            text={basketText}
          >
            {view.status !== "pending_payment" ? (
              <Link href={`/admin/orders/${orderId}` as never} className="inline-flex min-h-11 items-center underline">{c("open_order")}</Link>
            ) : terminalPaymentId ? (
              <TerminalDialog
                paymentId={terminalPaymentId}
                orderId={orderId}
                paidHref={`/admin/pos?done=${orderId}`}
                otherHref={`/admin/pos?order=${orderId}&payment=none`}
                text={{ title: c("terminal_title"), waiting: c("terminal_waiting"), paid: c("terminal_paid"), failed: (status) => c("terminal_failed", { status: tr(`commerce.payment_status.${status}`) }), timeout: c("terminal_timeout"), cancel: c("terminal_cancel"), cancelled: c("terminal_cancelled"), chooseOther: c("choose_other"), error: tr("commerce.common.error") }}
              />
            ) : (
              <PosPaymentForm action={onPayOrder} hidden={{ clientKey: randomUUID() }} terminals={settings.pos_terminals} allowBankTransfer={!view.hasDatedLines || !!view.onAccountAt} allowCash={!dayClosed} canUseEuroCredit={!!euro} onAccount={view.onAccountAt ? null : { allowed: !!view.personId }} text={paymentText(euro)} />
            )}
          </PosBasket>
        </div>
      </div>
    );
  }

  // -- A new sale -------------------------------------------------------------
  const tab: PosTab = (POS_TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as PosTab) : "sessions";
  const items = parseItems(sp.items);
  const personId = sp.personId && UUID.test(sp.personId) ? sp.personId : null;
  const person = personId ? await getPerson(db, personId) : null;
  const q = sp.q?.trim().slice(0, 100) ?? "";
  const canSearch = hasPermission(actor, "persons.read");
  const matches = canSearch && !person && q.length >= 2 ? await findPosBuyers(db, q) : [];
  const products = await listProducts(db, { activeOnly: true });
  const byId = new Map(products.map((p) => [p.id, p]));
  const sessions = tab === "sessions" ? await listBookableSessions(db, { fromOn: today, toOn: today }).catch(() => []) : [];
  const withItem = (item: Item) => {
    const list = [...items];
    const same = list.findIndex((i) => i.productId === item.productId && !i.sessionId && !item.sessionId);
    if (same >= 0) list[same] = { ...list[same]!, quantity: Math.min(50, list[same]!.quantity + 1) };
    else list.push(item);
    return href(sp, { items: encodeItems(list) });
  };
  const promo = sp.promo?.trim().slice(0, 40) || null;
  const cart: CartItem[] = items.filter((i) => byId.has(i.productId)).map((i) => ({ productId: i.productId, quantity: i.quantity, ...(i.sessionId ? { sessionId: i.sessionId } : {}) }));
  const quote: Quote | null = cart.length ? await getQuote(db, { personId, companyId: null, items: cart, promoCode: promo, channel: "pos" }).catch(() => null) : null;
  const euro = personId ? (await getEuroBalance(db, personId)).remainingCents : null;
  const openAccounts = personId ? await listOpenAccounts(db, { personId, limit: 20 }) : [];
  const kinds = cart.map((i) => byId.get(i.productId)!.kind);
  const needsPerson = !personId && kinds.some((k) => !(ANONYMOUS_KINDS as readonly string[]).includes(k));
  const hasDated = cart.some((i) => !!i.sessionId);
  const clientKey = sp.clientKey && UUID.test(sp.clientKey) ? sp.clientKey : randomUUID();
  const basketState = { items: encodeItems(items), personId: personId ?? "", promo: promo ?? "", clientKey, tab };

  async function onSell(form: FormData) {
    "use server";
    const fields = paymentFields(form);
    const pid = field(form, "personId");
    const r = await posSell({ personId: pid && UUID.test(pid) ? pid : null, items: parseItems(field(form, "items")), promoCode: field(form, "promo") ?? null, ...fields });
    if (!r.ok) {
      const back = new URLSearchParams({ items: field(form, "items") ?? "", ...(pid ? { personId: pid } : {}), tab: field(form, "tab") ?? "sessions", error: errorCode(r.error) });
      redirect(`/admin/pos?${back.toString()}` as never);
    }
    afterPayment(r.data, fields.method);
  }
  async function onWalkIn(form: FormData) {
    "use server";
    const r = await posCreateWalkIn({ firstName: field(form, "firstName") ?? "", lastName: field(form, "lastName"), phone: field(form, "phone") });
    const keep = new URLSearchParams({ items: field(form, "items") ?? "", tab: field(form, "tab") ?? "sessions" });
    if (r.ok) keep.set("personId", r.data.personId);
    else keep.set("error", errorCode(r.error));
    redirect(`/admin/pos?${keep.toString()}` as never);
  }
  const BUYER_SEARCH_ID = "pos-buyer-search";
  const inBasket = (productId: string) => items.filter((i) => i.productId === productId && !i.sessionId).reduce((n, i) => n + i.quantity, 0);
  const personName = person ? [person.firstName, person.lastName].filter(Boolean).join(" ") || person.customerNumber : "";

  async function onRedeem(form: FormData) {
    "use server";
    const pid = field(form, "personId");
    const keep = new URLSearchParams({ items: field(form, "items") ?? "", tab: field(form, "tab") ?? "sessions", ...(pid ? { personId: pid } : {}) });
    if (!pid) keep.set("error", "validation");
    else {
      const r = await redeemVoucher({ code: field(form, "code") ?? "", personId: pid });
      if (r.ok) {
        keep.set("msg", "voucher_redeemed");
        keep.set("amount", String(r.data.amountCents));
      } else keep.set("error", errorCode(r.error));
    }
    redirect(`/admin/pos?${keep.toString()}` as never);
  }

  const hidden = (extra: Record<string, string> = {}) => ({ ...basketState, ...extra });
  return (
    <div className="grid gap-4">
      {header}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <PosGrid
          locale={locale}
          active={tab}
          tabHref={(next) => href(sp, { tab: next })}
          products={posTabProducts(products, tab).map((p) => ({ id: p.id, name: name(p.name, p.sku), sku: p.sku, priceCents: p.current.public, href: withItem({ productId: p.id, quantity: 1 }), quantity: inBasket(p.id), tag: tab === "food" && p.itemCategory ? tr(`commerce.item_category.${p.itemCategory}`) : null }))}
          sessions={sessions
            .filter((s) => s.free > 0)
            .map((s) => ({ sessionId: s.sessionId, title: name(s.title, ""), startsAt: s.startsAt, free: s.free, priceCents: s.productId ? (byId.get(s.productId)?.current.public ?? null) : null, href: s.productId && byId.has(s.productId) ? withItem({ productId: s.productId, quantity: 1, sessionId: s.sessionId }) : null }))}
          text={{ tabsLabel: c("tabs_label"), tab: (x) => c(`tab_${x}`), add: (n) => c("add_named", { name: n }), seatsFree: (n) => c("seats_free", { count: n }), noSessions: c("no_sessions"), noProducts: c("no_products"), noPrice: c("no_price"), inBasket: (n) => c("in_basket", { count: n }) }}
        />
        <div className="grid content-start gap-4">
          <section aria-labelledby="pos-buyer-title" className="grid gap-2 rounded-xl border border-border bg-card p-4">
            <h2 id="pos-buyer-title" className="text-[0.75rem] font-semibold tracking-wide text-muted-foreground uppercase">{c("buyer_title")}</h2>
            {person ? (
              <div className="flex items-center gap-3" data-testid="pos-buyer">
                <Initials id={person.id} name={personName} className="size-10 text-[0.8125rem]" />
                <div className="grid min-w-0 flex-1">
                  <span className="flex items-center gap-2 truncate font-semibold">
                    {personName}
                    {person.status === "member" ? <span className="rounded-full bg-[#f7eedc] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#8a5a14]">{c("member")}</span> : null}
                  </span>
                  <span className="truncate text-[0.75rem] text-muted-foreground">{[person.email ?? person.phone, person.customerNumber].filter(Boolean).join(" · ")}</span>
                </div>
                <Link href={href(sp, { personId: null }) as never} scroll={false} className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-[#8a5a14] underline-offset-2 hover:underline" aria-label={c("change_person_named", { name: personName })}>
                  {c("change_person")}
                </Link>
              </div>
            ) : (
              <PosBuyerSearch
                id={BUYER_SEARCH_ID}
                canSearch={canSearch}
                initialQuery={q}
                initialMatches={matches}
                keep={{ tab, items: basketState.items, promo: basketState.promo, clientKey }}
                walkIn={onWalkIn}
                text={{ label: c("person_search"), searching: c("searching"), noMatch: c("no_match"), newClient: c("new_client"), member: c("member"), days: c("credits_days"), nights: c("credits_nights"), walkInTitle: c("walk_in_title"), firstName: c("first_name"), lastName: c("last_name"), phone: c("phone"), create: c("create_walk_in") }}
              />
            )}
            {openAccounts.length ? (
              <div className="grid gap-1 border-t pt-2 text-sm" data-testid="pos-open-accounts">
                <p className="font-medium">{c("open_accounts_title", { amount: money(openAccounts.reduce((n, o) => n + o.dueCents, 0)) })}</p>
                <ul className="grid gap-1">
                  {openAccounts.map((o) => (
                    <li key={o.orderId}>
                      <Link href={`/admin/pos?order=${o.orderId}` as never} className="inline-flex min-h-11 items-center underline">
                        {c("open_account_row", { reference: o.reference, amount: money(o.dueCents), date: formatDate(o.since, locale, "short") })}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {person ? (
              <form action={onRedeem} className="flex flex-wrap items-end gap-2 border-t pt-2">
                <input type="hidden" name="personId" value={person.id} />
                <input type="hidden" name="items" value={basketState.items} />
                <input type="hidden" name="tab" value={tab} />
                <label className="grid gap-1 text-sm">
                  <span>{c("voucher_code")}</span>
                  <Input name="code" autoComplete="off" className="h-11 w-56" />
                </label>
                <Button type="submit" variant="outline" className="min-h-11">{c("voucher_redeem")}</Button>
              </form>
            ) : null}
          </section>
          <PosBasket
            locale={locale}
            title={c("basket_title")}
            lines={(quote?.lines ?? []).map((l, i) => {
              const it = cart[i]!;
              const p = byId.get(l.productId);
              return { key: `${l.productId}-${i}`, description: p ? name(p.name, p.sku) : l.productId, quantity: l.quantity, lineTotalCents: l.lineTotalCents, discountCents: l.discountCents, removeHref: href(sp, { items: encodeItems(items.filter((x) => !(x.productId === it.productId && x.sessionId === it.sessionId))) }) };
            })}
            subtotalCents={quote?.subtotalCents ?? 0}
            discountCents={quote?.discountCents ?? 0}
            totalCents={quote?.totalCents ?? 0}
            notes={(quote?.warnings ?? []).map((w) => errorText(w.code))}
            text={basketText}
          >
            {cart.length ? (
              <div className="flex flex-wrap items-end justify-between gap-2">
                <form method="get" className="flex items-end gap-2">
                  {Object.entries(hidden()).map(([k, v]) => (k === "promo" ? null : <input key={k} type="hidden" name={k} value={v} />))}
                  <label className="grid gap-1 text-sm">
                    <span className="text-muted-foreground">{c("promo")}</span>
                    <Input name="promo" defaultValue={promo ?? ""} className="h-11 w-40" autoComplete="off" />
                  </label>
                  <Button type="submit" variant="outline" className="min-h-11">{c("apply")}</Button>
                </form>
                <Link href={href(sp, { items: null, promo: null, clientKey: null }) as never} scroll={false} className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline">{c("clear_basket")}</Link>
              </div>
            ) : null}
            <PosPaymentForm
              action={onSell}
              hidden={hidden()}
              terminals={settings.pos_terminals}
              allowBankTransfer={!hasDated}
              allowCash={!dayClosed}
              canUseEuroCredit={!!euro}
              onAccount={{ allowed: !!personId }}
              blocked={cart.length && needsPerson ? { message: c("needs_buyer"), focusId: BUYER_SEARCH_ID } : null}
              disabled={!quote}
              buyerSearchId={personId ? undefined : BUYER_SEARCH_ID}
              text={paymentText(euro)}
            />
          </PosBasket>
        </div>
      </div>
    </div>
  );
}
