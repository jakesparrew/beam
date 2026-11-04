/**
 * The 14-day right of withdrawal (commerce spec rule 54, edge case 32; Belgian Code of Economic
 * Law art. VI.47 and VI.53, 12°; commerce-P6).
 *
 * An online order (`portal`, `site`, `link`) with a package, membership or voucher line can be
 * withdrawn until `withdrawal_until_at` (paid_at + 14 days). Dated services (session, night,
 * ticket lines) are exempt; POS sales have no withdrawal right. The pure `withdrawalPlan` decides
 * per line: unused package units and an unredeemed voucher are refunded at once through
 * `issueRefund` (reason `withdrawal`, no second permission); a membership line becomes a
 * `payment` task for customer service (dedupe `withdrawal:<order_line_id>`), who refund it pro
 * rata to the days elapsed with reason `withdrawal`, which cancels the membership (rule 37).
 */
import { orderLines } from "@beam/db/schema";
import { withdrawalPlan, type WithdrawalLineInput, type WithdrawalPlan } from "@beam/core/commerce";
import { t } from "@beam/core/i18n";
import { asc, eq, ConflictError, NotFoundError, ValidationError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { createTask } from "@/modules/crm/api";
import { commerceSettings, lockOrder, ONLINE_CHANNELS, type OrderRow } from "./paid";
import { issueRefund, loadRefundContext, type RefundContext } from "./refunds";

/** The reason every withdrawal refund carries (rule 54). */
export const WITHDRAWAL_REASON = "withdrawal";

/** Why an order has no withdrawal right at all, or null when it has one. */
export function withdrawalBlocker(order: Pick<OrderRow, "channel" | "status" | "withdrawalUntilAt" | "paidAt">, at: Date): "not_online" | "not_paid" | "not_covered" | "withdrawal_expired" | null {
  if (!(ONLINE_CHANNELS as readonly string[]).includes(order.channel)) return "not_online";
  if (order.status !== "paid" && order.status !== "partially_refunded") return "not_paid";
  if (!order.withdrawalUntilAt || !order.paidAt) return "not_covered";
  if (at.getTime() > order.withdrawalUntilAt.getTime()) return "withdrawal_expired";
  return null;
}

function planInputs(c: RefundContext, lineIds: readonly string[]): WithdrawalLineInput[] {
  return lineIds.map((id) => {
    const input = c.inputs.get(id);
    if (!input) throw new ValidationError("validation", { lineIds: "unknown_line" });
    return {
      orderLineId: id,
      productKind: input.productKind,
      quantity: input.quantity,
      lineTotalCents: input.lineTotalCents,
      refundedCents: input.refundedCents ?? 0,
      ...(input.grants ? { grants: input.grants } : {}),
      ...(input.vouchers ? { vouchers: input.vouchers } : {}),
      ...(input.membershipPeriod ? { membershipPeriod: input.membershipPeriod } : {}),
    };
  });
}

/** The withdrawal plan of an order for the customer page (every line), or null without a right. */
export async function getWithdrawalPreview(db: DbOrTx, order: OrderRow, at: Date = new Date()): Promise<WithdrawalPlan | null> {
  if (withdrawalBlocker(order, at)) return null;
  const c = await loadRefundContext(db, order);
  const settings = await commerceSettings(db);
  return withdrawalPlan({ lines: planInputs(c, c.lines.map((l) => l.id)), paidAt: order.paidAt!, at, withdrawalDays: settings.withdrawal_days });
}

export type WithdrawResult = { refundIds: string[]; taskIds: string[]; amountCents: number };

/**
 * `withdrawOrder` (customer, the order's owner): refunds the withdrawable lines at once and
 * opens a customer-service task per membership line. Past the deadline: `withdrawal_expired`.
 */
export async function withdrawOrder(tx: Tx, ctx: Ctx, input: { orderId: string; lineIds: string[] }, viewer: { personId: string | null }): Promise<WithdrawResult> {
  const order = await lockOrder(tx, input.orderId);
  if (!order || !order.personId || order.personId !== viewer.personId) throw new NotFoundError("order_not_found");
  const blocker = withdrawalBlocker(order, ctx.now);
  if (blocker === "withdrawal_expired") throw new ConflictError("withdrawal_expired");
  if (blocker) throw new ConflictError("not_withdrawable");

  const lineIds = [...new Set(input.lineIds)];
  if (!lineIds.length) throw new ValidationError("validation", { lineIds: "required" });
  const c = await loadRefundContext(tx, order);
  const settings = await commerceSettings(tx);
  const plan = withdrawalPlan({ lines: planInputs(c, lineIds), paidAt: order.paidAt!, at: ctx.now, withdrawalDays: settings.withdrawal_days });
  if (plan.reason === "withdrawal_expired") throw new ConflictError("withdrawal_expired");
  if (!plan.allowed) throw new ConflictError("nothing_to_withdraw");

  const refundLines = plan.lines
    .filter((l) => l.outcome === "refund" && l.amountCents > 0)
    .map((l) => {
      const input = c.inputs.get(l.orderLineId)!;
      const left = input.quantity - (input.refundedQuantity ?? 0);
      const quantity = input.productKind === "package" ? l.grantIds.length : input.productKind === "voucher" ? l.voucherIds.length : left;
      return { orderLineId: l.orderLineId, quantity: Math.max(1, Math.min(quantity, left)), amountCents: l.amountCents };
    });
  let refundIds: string[] = [];
  let amountCents = 0;
  if (refundLines.length) {
    const out = await issueRefund(tx, ctx, { orderId: order.id, lines: refundLines, reason: WITHDRAWAL_REASON, kind: "withdrawal" });
    refundIds = out.refundIds;
    amountCents = out.amountCents;
  }

  const taskIds: string[] = [];
  const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, order.id)).orderBy(asc(orderLines.lineNo));
  for (const l of plan.lines.filter((x) => x.outcome === "task")) {
    const line = lines.find((x) => x.id === l.orderLineId);
    const task = await createTask(tx, ctx, {
      title: t("nl-BE", "commerce.tasks.withdrawal_membership", { reference: order.reference }),
      kind: "payment",
      ownerRole: "customer_service",
      personId: order.personId,
      source: "system",
      ref: { type: "order", id: order.id },
      notes: line ? `${line.sku} · ${l.amountCents}` : undefined,
      dedupeKey: `withdrawal:${l.orderLineId}`,
    });
    taskIds.push(task.taskId);
  }

  await ctx.recordEvent({
    kind: "order.withdrawn",
    personId: order.personId,
    ref: { type: "order", id: order.id },
    dedupeKey: `order:${order.id}:withdrawn`,
    data: { order_id: order.id },
  });
  return { refundIds, taskIds, amountCents };
}
