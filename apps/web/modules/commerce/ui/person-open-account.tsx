/**
 * `PersonOpenAccount` for crm's person page (owner decision November 2026, "Op rekening"): the
 * "Openstaand" line with the total still due on account and its open orders, each linked to the
 * order page where it is settled. Async server component; needs `commerce.sell`, `commerce.refund`
 * or `invoices.read`, renders nothing otherwise or when nothing is open.
 */
import Link from "next/link";
import { formatDate, formatMoney, type Locale } from "@beam/core/i18n";
import { actorFromSession, getSession, hasPermission } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getPersonOpenAccount } from "../server/on-account";

export async function PersonOpenAccount({ personId, locale }: { personId: string; locale: Locale }) {
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff" || !(["commerce.sell", "commerce.refund", "invoices.read"] as const).some((p) => hasPermission(actor, p))) return null;
  const open = await getPersonOpenAccount(await getAppDb(), personId).catch(() => null);
  if (!open?.orders.length) return null;
  const tr = translator(locale);
  const money = (n: number) => formatMoney(n, locale);
  return (
    <div className="grid gap-1 rounded-lg border border-border bg-card px-3.5 py-2 text-[0.8125rem]" data-testid="panel-open-account">
      <p className="font-semibold">{tr("commerce.open_account.line", { amount: money(open.dueCents), count: open.orders.length })}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {open.orders.map((o) => (
          <li key={o.orderId}>
            <Link href={`/admin/orders/${o.orderId}` as never} className="underline">
              {tr("commerce.pos.open_account_row", { reference: o.reference, amount: money(o.dueCents), date: formatDate(o.since, locale, "short") })}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
