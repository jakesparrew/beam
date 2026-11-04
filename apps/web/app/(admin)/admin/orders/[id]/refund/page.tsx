import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button, EmptyState, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { COMMERCE_SETTINGS_DEFAULTS } from "@beam/core/commerce";
import { formatMoney, pick, t, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { refundOrder } from "@/modules/commerce/actions";
import { getRefundPreview } from "@/modules/commerce/queries";

/**
 * `/admin/orders/[id]/refund` (commerce spec 5.1, rules 36 to 40; `commerce.refund`): per line
 * what was paid, what is still refundable and the default amount `refundPlan()` proposes (pro
 * rata to unused units or days); staff may lower an amount, never raise it. The money goes to the
 * credit balance first, then to the card or cash payments. Above € 500 or after 365 days the
 * action also checks `invoices.issue`.
 */
export default async function RefundPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "commerce.refund")) notFound();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const preview = await getRefundPreview(await getAppDb(), id);
  if (!preview) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_refund.${k}`, p);
  const money = (v: number) => formatMoney(v, locale);
  const errorText = (code: string) => (t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error"));
  const { order } = preview;
  const refundable = preview.lines.filter((l) => l.plan.lines[0] && l.plan.lines[0].maxAmountCents > 0);
  const lineIds = refundable.map((l) => l.line.id);

  async function onRefund(form: FormData) {
    "use server";
    const lines = lineIds
      .filter((lineId) => form.get(`include_${lineId}`) === "on")
      .map((lineId) => {
        const quantity = Number(form.get(`quantity_${lineId}`) ?? 1);
        const value = form.get(`amount_${lineId}`);
        const raw = typeof value === "string" ? value.trim() : "";
        return { orderLineId: lineId, quantity, ...(raw ? { amountCents: Number(raw) } : {}) };
      });
    const r = await refundOrder({ orderId: id, lines, reason: typeof form.get("reason") === "string" ? (form.get("reason") as string) : "", kind: form.get("kind") === "withdrawal" ? "withdrawal" : "refund" });
    if (r.ok) redirect(`/admin/orders/${id}?done=1` as never);
    redirect(`/admin/orders/${id}/refund?error=${encodeURIComponent(r.error.message)}` as never);
  }

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <Link href={`/admin/orders/${order.id}`} className="text-sm underline">
          {tr("commerce.admin_orders.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{c("title", { reference: order.reference })}</h1>
        <p className="text-sm">{c("refundable", { amount: money(preview.refundableCents) })}</p>
      </header>
      <div role="status" aria-live="polite">
        {sp.error ? <p className="rounded-md border border-destructive p-3 text-sm">{tr("commerce.admin_orders.failed", { message: errorText(sp.error) })}</p> : null}
      </div>
      {refundable.length === 0 || preview.refundableCents <= 0 ? (
        <EmptyState title={c("nothing")} />
      ) : (
        <form action={onRefund} className="grid gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c("include")}</TableHead>
                <TableHead>{c("col_line")}</TableHead>
                <TableHead className="text-right">{c("col_paid")}</TableHead>
                <TableHead className="text-right">{c("col_left")}</TableHead>
                <TableHead className="text-right">{c("col_default")}</TableHead>
                <TableHead>{c("col_quantity")}</TableHead>
                <TableHead>{c("col_amount")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {refundable.map(({ line, left, plan }) => {
                const p = plan.lines[0];
                if (!p) return null;
                const name = pick(line.description as LocalizedText, locale, "order_lines.description") || line.sku;
                return (
                  <TableRow key={line.id}>
                    <TableCell>
                      <input type="checkbox" name={`include_${line.id}`} id={`include_${line.id}`} aria-label={`${c("include")}: ${name}`} className="size-5" />
                    </TableCell>
                    <TableCell>
                      <label htmlFor={`include_${line.id}`}>{name}</label>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(line.lineTotalCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(p.maxAmountCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(p.defaultAmountCents)}</TableCell>
                    <TableCell>
                      <Input type="number" name={`quantity_${line.id}`} min={1} max={left} defaultValue={left} aria-label={`${c("col_quantity")}: ${name}`} className="w-20" />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        name={`amount_${line.id}`}
                        min={0}
                        max={p.maxAmountCents}
                        placeholder={String(p.defaultAmountCents)}
                        aria-label={`${c("col_amount")}: ${name}`}
                        className="w-32"
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="text-sm text-muted-foreground">{c("where")}</p>
          <p className="text-sm text-muted-foreground">{c("second_permission", { amount: money(COMMERCE_SETTINGS_DEFAULTS.refund_second_permission_above_cents) })}</p>
          <label className="grid gap-1 text-sm">
            <span>{c("reason")}</span>
            <Input name="reason" required minLength={5} maxLength={500} />
          </label>
          <fieldset className="grid gap-1 text-sm">
            <legend>{c("kind")}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="kind" value="refund" defaultChecked /> {c("kind_refund")}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="kind" value="withdrawal" /> {c("kind_withdrawal")}
            </label>
          </fieldset>
          <Button type="submit" className="justify-self-start">
            {c("confirm")}
          </Button>
        </form>
      )}
    </div>
  );
}
