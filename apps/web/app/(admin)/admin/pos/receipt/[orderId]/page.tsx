import Link from "next/link";
import { notFound } from "next/navigation";
import { files, orders } from "@beam/db/schema";
import { hasPermission, requireStaff } from "@/lib/auth";
import { and, eq, getAppDb } from "@/lib/ctx";
import { signFileUrl } from "@/lib/files";
import { adminLocale, translator } from "@/lib/i18n";
import { loadReceiptInput, receiptModel } from "@/modules/commerce/ui/receipt-pdf";
import { PrintButton } from "@/modules/commerce/ui/terminal-dialog";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAID = new Set(["paid", "partially_refunded", "refunded"]);

/**
 * `/admin/pos/receipt/[orderId]` (commerce spec 5.1, rule 44; `commerce.sell`): the 80 mm print
 * layout of a paid order's receipt in the order's locale (company data from `settings.company`,
 * lines, VAT per rate, payment method, reference), with Print and, once `commerce.render_receipt`
 * has stored it, the PDF download.
 */
export default async function PosReceiptPage({ params }: { params: Promise<{ orderId: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "commerce.sell")) notFound();
  const { orderId } = await params;
  if (!UUID.test(orderId)) notFound();
  const tr = translator(await adminLocale());
  const db = await getAppDb();
  const [order] = await db.select({ status: orders.status, reference: orders.reference }).from(orders).where(eq(orders.id, orderId));
  if (!order) notFound();
  if (!PAID.has(order.status)) {
    return (
      <div className="grid gap-4">
        <p>{tr("commerce.receipt.not_paid")}</p>
        <Link href={`/admin/pos?order=${orderId}` as never} className="underline">{tr("commerce.receipt.back_to_pos")}</Link>
      </div>
    );
  }
  const input = await loadReceiptInput(db, orderId);
  if (!input) notFound();
  const model = receiptModel(input);
  const [file] = await db.select({ id: files.id }).from(files).where(and(eq(files.kind, "receipt"), eq(files.name, `receipt-${order.reference}.pdf`)));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2 print:hidden">
        <PrintButton label={tr("commerce.receipt.print")} />
        {file ? (
          <a href={signFileUrl(file.id, 3600)} className="inline-flex min-h-11 items-center rounded-md border px-4">
            {tr("commerce.receipt.download")}
          </a>
        ) : null}
        <Link href="/admin/pos" className="inline-flex min-h-11 items-center underline">{tr("commerce.receipt.back_to_pos")}</Link>
      </div>
      <article lang={input.locale} aria-labelledby="receipt-title" className="mx-auto w-[80mm] max-w-full bg-white p-3 font-mono text-xs leading-snug text-black print:m-0 print:p-0">
        <h1 id="receipt-title" className="text-center text-base font-bold">{model.title}</h1>
        <div className="mt-1 text-center">
          {model.header.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-2">
          {model.meta.map((m) => (
            <div key={m.label} className="contents">
              <dt>{m.label}</dt>
              <dd className="text-right">{m.value}</dd>
            </div>
          ))}
        </dl>
        <table className="mt-2 w-full border-t border-dashed border-black">
          <thead>
            <tr>
              <th scope="col" className="text-left">{model.columns.description}</th>
              <th scope="col" className="text-right">{model.columns.quantity}</th>
              <th scope="col" className="text-right">{model.columns.amount}</th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((r, i) => (
              <tr key={i} className="align-top">
                <td>
                  {r.description}
                  <span className="block">{r.vat}</span>
                  {r.discount ? <span className="block">{r.discount}</span> : null}
                </td>
                <td className="text-right">{r.quantity}</td>
                <td className="text-right">{r.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-2 grid grid-cols-2 gap-x-2 border-t border-dashed border-black pt-1">
          {model.totals.map((x) => (
            <div key={x.label} className="contents">
              <dt>{x.label}</dt>
              <dd className="text-right">{x.value}</dd>
            </div>
          ))}
        </dl>
        <table className="mt-2 w-full border-t border-dashed border-black">
          <caption className="text-left font-bold">{model.vatTitle}</caption>
          <thead>
            <tr>
              <th scope="col" className="text-left">{model.vatColumns.rate}</th>
              <th scope="col" className="text-right">{model.vatColumns.net}</th>
              <th scope="col" className="text-right">{model.vatColumns.vat}</th>
              <th scope="col" className="text-right">{model.vatColumns.gross}</th>
            </tr>
          </thead>
          <tbody>
            {model.vatRows.map((v) => (
              <tr key={v.rate}>
                <td>{v.rate}</td>
                <td className="text-right">{v.net}</td>
                <td className="text-right">{v.vat}</td>
                <td className="text-right">{v.gross}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {model.paidWith.length ? (
          <section className="mt-2 border-t border-dashed border-black pt-1" aria-label={model.paidWithTitle}>
            <p className="font-bold">{model.paidWithTitle}</p>
            {model.paidWith.map((p, i) => (
              <p key={i} className="flex justify-between">
                <span>{p.label}</span>
                <span>{p.value}</span>
              </p>
            ))}
          </section>
        ) : null}
        {model.withdrawal ? <p className="mt-2">{model.withdrawal}</p> : null}
        <p className="mt-3 text-center">{model.footer}</p>
      </article>
    </div>
  );
}
