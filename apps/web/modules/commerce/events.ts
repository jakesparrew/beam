/**
 * commerce timeline events (`defineEvent`, commerce spec section 4.7, 02-data-model section 4.3).
 * Facade read by `pnpm gen:indexes`. commerce-P4a declares every V1 kind of the module at once,
 * so later commerce packages (expiry, refunds, checkouts, vouchers, payment links) record them
 * without touching this list; R2's `checkout.recovered` is declared too (no V1 writer).
 *
 * `data` keys are snake_case ids and amounts only (Convention 2). Dedupe keys are
 * `<noun>:<id>:<kind suffix>`, for example `order:<id>:paid`. Events for an order without a
 * person are recorded on its company or skipped (`activity_events` needs a subject).
 */
import { z } from "zod";
import { PRODUCT_KINDS } from "@beam/core/commerce";
import { defineEvent } from "@/lib/events";

const uuid = z.uuid();
const cents = z.number().int();
const channel = z.enum(["portal", "site", "admin", "pos", "link", "recurring"]);
const productKind = z.enum(PRODUCT_KINDS);

export const events = [
  defineEvent({ kind: "checkout.started", subject: "person", data: z.object({ checkout_id: uuid, channel: z.enum(["portal", "site"]) }) }),
  defineEvent({
    kind: "checkout.abandoned",
    subject: "person",
    data: z.object({
      checkout_id: uuid,
      total_cents: cents.nullable(),
      product_ids: z.array(uuid),
      channel: z.enum(["portal", "site"]),
      reason: z.enum(["left", "payment_failed", "payment_expired"]),
    }),
  }),
  defineEvent({ kind: "checkout.completed", subject: "person", data: z.object({ checkout_id: uuid, order_id: uuid }) }),
  defineEvent({ kind: "checkout.recovered", subject: "person", data: z.object({ checkout_id: uuid, order_id: uuid }) }),
  defineEvent({
    kind: "order.paid",
    subject: "either",
    data: z.object({
      order_id: uuid,
      reference: z.string(),
      total_cents: cents,
      channel,
      product_kinds: z.array(productKind),
      lines: z.array(z.object({ product_id: uuid, kind: productKind, quantity: z.number().int().positive() })),
    }),
  }),
  defineEvent({ kind: "order.expired", subject: "either", data: z.object({ order_id: uuid }) }),
  defineEvent({ kind: "order.cancelled", subject: "either", data: z.object({ order_id: uuid }) }),
  defineEvent({ kind: "order.withdrawn", subject: "person", data: z.object({ order_id: uuid }) }),
  defineEvent({ kind: "order.refunded", subject: "either", data: z.object({ order_id: uuid, amount_cents: cents, reason: z.string() }) }),
  defineEvent({ kind: "payment.failed", subject: "either", data: z.object({ order_id: uuid, reason: z.string() }) }),
  defineEvent({ kind: "payment.charged_back", subject: "either", data: z.object({ order_id: uuid, amount_cents: cents }) }),
  defineEvent({
    kind: "promotion.redeemed",
    subject: "either",
    data: z.object({ promotion_id: uuid, code: z.string().nullable(), discount_cents: cents }),
  }),
  defineEvent({ kind: "voucher.redeemed", subject: "person", data: z.object({ voucher_id: uuid }) }),
  defineEvent({ kind: "voucher.expired", subject: "person", data: z.object({ voucher_id: uuid }) }),
  defineEvent({ kind: "voucher.expiring", subject: "person", data: z.object({ voucher_id: uuid, days: z.number().int().positive() }) }),
  defineEvent({ kind: "payment_link.sent", subject: "either", data: z.object({ order_id: uuid }) }),
  defineEvent({ kind: "person_price.set", subject: "person", data: z.object({ product_id: uuid }) }),
];
