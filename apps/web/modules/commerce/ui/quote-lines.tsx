import { formatMoney, type Locale } from "@beam/core/i18n";
import type { Quote } from "@beam/core/commerce";
import { translator } from "@/lib/i18n";
import type { CheckoutLineView } from "../server/checkouts";

/**
 * The quote of a basket or an order (rule 56): a table with a caption, the discount reason per
 * line as text (never colour alone), amounts read with their currency, the euro credit to use
 * and the total incl. VAT. With `editable`, every line gets a labelled quantity field
 * (`qty_<i>`) and a remove button posting `remove=<i>` to `updateAction`.
 */
export function QuoteLines({
  locale,
  lines,
  quote,
  editable,
  updateAction,
}: {
  locale: Locale;
  lines: CheckoutLineView[];
  quote: Pick<Quote, "subtotalCents" | "discountCents" | "vatCents" | "totalCents">;
  editable?: boolean;
  updateAction?: (fd: FormData) => Promise<void>;
}) {
  const tr = translator(locale);
  const money = (cents: number) => formatMoney(cents, locale);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{tr("commerce.checkout.basket")}</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-2 pr-2 font-medium">
              {tr("commerce.checkout.product")}
            </th>
            <th scope="col" className="py-2 pr-2 font-medium">
              {tr("commerce.checkout.quantity")}
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              {tr("commerce.checkout.unit_price")}
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              {tr("commerce.checkout.line_total")}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={`${line.productId}-${i}`} className="border-b align-top">
              <td className="py-3 pr-2">
                <span className="font-medium">{line.name}</span>
                {line.reason ? <span className="block text-xs text-muted-foreground">{tr(`commerce.checkout.reason_${line.reason}`)}</span> : null}
                {line.kind === "package" || line.kind === "membership" || line.kind === "voucher" ? (
                  <span className="block text-xs text-muted-foreground">{tr("commerce.checkout.withdrawal_line")}</span>
                ) : null}
              </td>
              <td className="py-3 pr-2">
                {editable ? (
                  <span className="flex items-center gap-2">
                    <label htmlFor={`qty_${i}`} className="sr-only">
                      {tr("commerce.checkout.quantity_of", { name: line.name })}
                    </label>
                    <input
                      id={`qty_${i}`}
                      name={`qty_${i}`}
                      type="number"
                      min={1}
                      max={line.kind === "membership" ? 1 : 50}
                      defaultValue={line.quantity}
                      inputMode="numeric"
                      className="h-11 w-20 rounded-md border px-2"
                    />
                    <button type="submit" name="remove" value={String(i)} formAction={updateAction} className="min-h-11 rounded-md px-2 text-sm underline">
                      {tr("commerce.checkout.remove", { name: line.name })}
                    </button>
                  </span>
                ) : (
                  line.quantity
                )}
              </td>
              <td className="py-3 pr-2 text-right tabular-nums">{money(line.unitCents)}</td>
              <td className="py-3 text-right tabular-nums">{money(line.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt>{tr("commerce.checkout.subtotal")}</dt>
        <dd className="text-right tabular-nums">{money(quote.subtotalCents)}</dd>
        {quote.discountCents > 0 ? (
          <>
            <dt>{tr("commerce.checkout.discount")}</dt>
            <dd className="text-right tabular-nums">−{money(quote.discountCents)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{tr("commerce.checkout.vat")}</dt>
        <dd className="text-right tabular-nums text-muted-foreground">{money(quote.vatCents)}</dd>
        <dt className="text-base font-semibold">{tr("commerce.checkout.total")}</dt>
        <dd className="text-right text-base font-semibold tabular-nums">{money(quote.totalCents)}</dd>
      </dl>
    </div>
  );
}

/** Order lines (pay page, order detail) in the same table shape, read-only. */
export function OrderLinesTable({ locale, lines, totalCents }: { locale: Locale; lines: { id: string; description: string; quantity: number; lineTotalCents: number }[]; totalCents: number }) {
  const tr = translator(locale);
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{tr("commerce.my_orders.lines")}</caption>
      <thead>
        <tr className="border-b text-left">
          <th scope="col" className="py-2 pr-2 font-medium">
            {tr("commerce.checkout.product")}
          </th>
          <th scope="col" className="py-2 pr-2 font-medium">
            {tr("commerce.checkout.quantity")}
          </th>
          <th scope="col" className="py-2 text-right font-medium">
            {tr("commerce.checkout.line_total")}
          </th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id} className="border-b">
            <td className="py-2 pr-2">{l.description}</td>
            <td className="py-2 pr-2">{l.quantity}</td>
            <td className="py-2 text-right tabular-nums">{formatMoney(l.lineTotalCents, locale)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={2} className="py-2 text-left font-semibold">
            {tr("commerce.checkout.total")}
          </th>
          <td className="py-2 text-right font-semibold tabular-nums">{formatMoney(totalCents, locale)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
