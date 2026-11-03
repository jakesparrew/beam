/**
 * Commercial status (credits rules 58 and 59, crm rule 3.8, cross-module D28). The database
 * computes it in `v_person_status`; these are the same rules as pure predicates, so the view
 * test and the screens that explain a status share one definition.
 */

export type CommercialStatus = "lead" | "customer" | "member";

/** Order line kinds that make a buyer a customer; `item` and `voucher` lines never do. */
export const CUSTOMER_PRODUCT_KINDS = ["session", "night", "package", "membership", "ticket"] as const;

/** Order statuses that count as paid; a later refund never undoes the customer status. */
export const PAID_ORDER_STATUSES = ["paid", "partially_refunded", "refunded"] as const;

/**
 * `member` with a current membership (`active` or `past_due`, started), else `customer` with a
 * paid transaction, else `lead`; `status` is the staff override when set (it wins for the
 * classification), else the derived value. A derived change never writes the override.
 */
export function deriveStatus(i: {
  override: CommercialStatus | null;
  hasCurrentMembership: boolean;
  hasPaid: boolean;
}): { derived: CommercialStatus; status: CommercialStatus } {
  const derived: CommercialStatus = i.hasCurrentMembership ? "member" : i.hasPaid ? "customer" : "lead";
  return { derived, status: i.override ?? derived };
}

/** An order that makes its buyer a customer: paid above € 0 with at least one customer line kind. */
export function isCustomerOrder(o: { status: string; paidAt: Date | null; totalCents: number; lineKinds: readonly string[] }): boolean {
  return (
    o.paidAt !== null &&
    o.totalCents > 0 &&
    (PAID_ORDER_STATUSES as readonly string[]).includes(o.status) &&
    o.lineKinds.some((k) => (CUSTOMER_PRODUCT_KINDS as readonly string[]).includes(k))
  );
}

/** A grant that makes its owner a customer: a `purchase` or `import` of day or night units. */
export function isCustomerGrant(g: { source: string; creditKind: string }): boolean {
  return (g.source === "purchase" || g.source === "import") && (g.creditKind === "day" || g.creditKind === "night");
}

/** A membership that counts as current for `member` (and for `is_member`, member pricing). */
export function isCurrentMembership(m: { status: string; startedAt: Date }, now: Date): boolean {
  return (m.status === "active" || m.status === "past_due") && m.startedAt.getTime() <= now.getTime();
}

/** A membership that was ever running (`member_since_at`); one cancelled while `pending` was not. */
export function wasEverMember(m: { status: string; startedAt: Date; endedAt: Date | null }): boolean {
  if (m.status === "active" || m.status === "past_due") return true;
  if (m.status === "cancelled" || m.status === "expired") return m.endedAt !== null && m.endedAt.getTime() > m.startedAt.getTime();
  return false;
}

/** The status of a person from their facts, as `v_person_status` computes it. */
export function statusFromFacts(i: {
  override: CommercialStatus | null;
  orders: { status: string; paidAt: Date | null; totalCents: number; lineKinds: readonly string[] }[];
  grants: { source: string; creditKind: string }[];
  memberships: { status: string; startedAt: Date }[];
  now: Date;
}): { derived: CommercialStatus; status: CommercialStatus; isMember: boolean } {
  const hasCurrentMembership = i.memberships.some((m) => isCurrentMembership(m, i.now));
  const hasPaid = i.orders.some(isCustomerOrder) || i.grants.some(isCustomerGrant);
  return { ...deriveStatus({ override: i.override, hasCurrentMembership, hasPaid }), isMember: hasCurrentMembership };
}
