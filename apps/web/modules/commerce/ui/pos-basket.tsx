/**
 * The POS basket (commerce spec 5.1, rules 25, 26b, 43, 56), a server component: the lines with
 * their live quote and the total. Its payment form (`./pos-payment-form`, a client component)
 * posts to the server action the page passes (`posSell` or `posPayOrder` behind it). Every input
 * has a visible label, touch targets are at least 44 px, amounts carry their currency.
 */
import type { ReactNode } from "react";
import Link from "next/link";
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
    <section aria-labelledby="pos-basket-title" className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <h2 id="pos-basket-title" className="text-[0.9375rem] font-semibold">
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

export { PosPaymentForm, type PosPaymentText } from "./pos-payment-form";
