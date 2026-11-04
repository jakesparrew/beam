/**
 * The POS basket and its payment form (commerce spec 5.1, rules 25, 26b, 43, 56). Server
 * components: the basket lists the lines with their live quote, the payment form posts to the
 * server action the page passes (`posSell` or `posPayOrder` behind it). Every input has a visible
 * label, touch targets are at least 44 px, amounts carry their currency.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { Button, Input } from "@beam/ui";
import { formatMoney, type Locale } from "@beam/core/i18n";

export type PosBasketLine = { key: string; description: string; quantity: number; lineTotalCents: number; discountCents: number; removeHref?: string | null };

export function PosBasket(props: {
  locale: Locale;
  title: string;
  lines: PosBasketLine[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  dueCents?: number | null;
  notes?: string[];
  children?: ReactNode;
  text: { empty: string; remove: (name: string) => string; quantity: string; product: string; amount: string; subtotal: string; discount: string; total: string; due: string };
}) {
  const { locale, text } = props;
  const money = (c: number) => formatMoney(c, locale);
  return (
    <section aria-labelledby="pos-basket-title" className="grid gap-3 rounded-md border p-4">
      <h2 id="pos-basket-title" className="text-lg font-semibold">
        {props.title}
      </h2>
      {props.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{text.empty}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-1">{text.product}</th>
              <th scope="col" className="py-1 text-right">{text.quantity}</th>
              <th scope="col" className="py-1 text-right">{text.amount}</th>
              <th scope="col" className="py-1"><span className="sr-only">{text.remove("")}</span></th>
            </tr>
          </thead>
          <tbody>
            {props.lines.map((l) => (
              <tr key={l.key} className="border-b align-top">
                <td className="py-2">
                  {l.description}
                  {l.discountCents > 0 ? <span className="block text-muted-foreground">{`${text.discount}: - ${money(l.discountCents)}`}</span> : null}
                </td>
                <td className="py-2 text-right tabular-nums">{l.quantity}</td>
                <td className="py-2 text-right tabular-nums">{money(l.lineTotalCents)}</td>
                <td className="py-2 text-right">
                  {l.removeHref ? (
                    <Link href={l.removeHref as never} className="inline-flex min-h-11 min-w-11 items-center justify-center underline" aria-label={text.remove(l.description)}>
                      ×
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.lines.length ? (
        <dl className="grid grid-cols-2 gap-1 text-sm">
          <dt>{text.subtotal}</dt>
          <dd className="text-right tabular-nums">{money(props.subtotalCents)}</dd>
          {props.discountCents > 0 ? (
            <>
              <dt>{text.discount}</dt>
              <dd className="text-right tabular-nums">- {money(props.discountCents)}</dd>
            </>
          ) : null}
          <dt className="font-semibold">{text.total}</dt>
          <dd className="text-right font-semibold tabular-nums">{money(props.totalCents)}</dd>
          {props.dueCents != null && props.dueCents !== props.totalCents ? (
            <>
              <dt>{text.due}</dt>
              <dd className="text-right tabular-nums">{money(props.dueCents)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {props.notes?.length ? (
        <ul className="grid gap-1 text-sm text-muted-foreground">
          {props.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {props.children}
    </section>
  );
}

export type PosPaymentText = {
  method: string;
  terminal: string;
  cash: string;
  bankTransfer: string;
  terminalLabel: string;
  cashReceived: string;
  useEuroCredit: string;
  euroCredit: string | null;
  companyToggle: string;
  companyName: string;
  vatNumber: string;
  line1: string;
  postalCode: string;
  city: string;
  country: string;
  billingEmail: string;
  pay: string;
};

/**
 * Method, cash received, terminal, euro credit and the "Invoice to a company" fields. `hidden`
 * carries the basket (items, buyer, promotion, client key) or the order id.
 */
export function PosPaymentForm(props: {
  action: (form: FormData) => Promise<void>;
  hidden: Record<string, string>;
  terminals: { id: string; name: string }[];
  allowBankTransfer: boolean;
  allowCash: boolean;
  canUseEuroCredit: boolean;
  text: PosPaymentText;
}) {
  const { text } = props;
  const radio = "h-5 w-5";
  return (
    <form action={props.action} className="grid gap-3 border-t pt-3">
      {Object.entries(props.hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{text.method}</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name="method" value="terminal" defaultChecked className={radio} />
          {text.terminal}
        </label>
        {props.allowCash ? (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" name="method" value="cash" className={radio} />
            {text.cash}
          </label>
        ) : null}
        {props.allowBankTransfer ? (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" name="method" value="bank_transfer" className={radio} />
            {text.bankTransfer}
          </label>
        ) : null}
      </fieldset>
      <label className="grid gap-1 text-sm">
        <span>{text.terminalLabel}</span>
        <select name="terminalId" className="h-11 rounded-md border border-input bg-transparent px-3 text-sm" defaultValue={props.terminals[0]?.id ?? ""}>
          {props.terminals.map((term) => (
            <option key={term.id} value={term.id}>
              {term.name}
            </option>
          ))}
        </select>
      </label>
      {props.allowCash ? (
        <label className="grid gap-1 text-sm">
          <span>{text.cashReceived}</span>
          <Input name="cashReceived" inputMode="decimal" className="h-11 w-40" autoComplete="off" />
        </label>
      ) : null}
      {props.canUseEuroCredit ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="useEuroCredit" value="1" className={radio} />
          <span>
            {text.useEuroCredit}
            {text.euroCredit ? <span className="block text-muted-foreground">{text.euroCredit}</span> : null}
          </span>
        </label>
      ) : null}
      <details className="grid gap-2 text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center">{text.companyToggle}</summary>
        {/* The details are sent when the company name is filled in. */}
        <div className="grid gap-2 pt-2">
          {(
            [
              ["companyName", text.companyName, "organization"],
              ["vatNumber", text.vatNumber, "off"],
              ["line1", text.line1, "address-line1"],
              ["postalCode", text.postalCode, "postal-code"],
              ["city", text.city, "address-level2"],
              ["country", text.country, "country"],
              ["billingEmail", text.billingEmail, "email"],
            ] as const
          ).map(([name, label, autoComplete]) => (
            <label key={name} className="grid gap-1">
              <span>{label}</span>
              <Input name={name} autoComplete={autoComplete} className="h-11" defaultValue={name === "country" ? "BE" : undefined} />
            </label>
          ))}
        </div>
      </details>
      <Button type="submit" className="min-h-11 text-base">
        {text.pay}
      </Button>
    </form>
  );
}
