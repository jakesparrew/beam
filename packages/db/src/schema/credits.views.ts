/**
 * credits views (credits spec section 2 "Views"). Each view is `pgView(name, columns).existing()`
 * with its SQL exported beside it as `<name>Sql`; `pnpm db:views` writes the migration and
 * `createTestDb()` applies the same SQL (DM-1).
 *
 * Contract with finance (cross-module D29): `v_credit_liability`, `v_credit_movements_monthly`
 * and `v_euro_voucher_redemptions` keep their names and columns.
 */
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgView,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { personsStatusOverride } from "./crm";
import {
  creditEntriesKind,
  creditGrantsCreditKind,
  creditGrantsSource,
  creditGrantsStatus,
  creditGrantsVatTreatment,
  membershipsStatus,
  type GrantSharingJson,
} from "./credits";

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** Balance per grant. The only place a balance is computed. */
export const vCreditGrantBalancesSql = `select g.id as grant_id, g.person_id, g.credit_kind, g.source, g.status, g.product_id, g.membership_id,
       g.starts_at, g.expires_at, g.units_granted, g.unit_value_cents, g.vat_treatment, g.sharing,
       coalesce((g.data->>'original_units')::int, g.units_granted) as base_units,
       coalesce(sum(e.quantity), 0)::int as remaining_units,
       coalesce(-sum(e.quantity) filter (where e.kind in ('consume', 'release')), 0)::int as used_units,
       coalesce(-sum(e.quantity) filter (where e.kind in ('consume', 'release')
                 and e.beneficiary_person_id is not null
                 and e.beneficiary_person_id <> e.person_id), 0)::int as guest_units,
       coalesce(-sum(e.quantity) filter (where e.kind = 'expire'), 0)::int as expired_units,
       coalesce(sum(e.quantity) filter (where e.kind = 'adjust'), 0)::int as adjusted_units,
       max(e.created_at) filter (where e.kind = 'consume') as last_used_at,
       (g.status = 'active' and g.starts_at <= now()
          and (g.expires_at is null or g.expires_at > now())
          and coalesce(sum(e.quantity), 0) > 0) as is_usable
from credit_grants g
left join credit_entries e on e.grant_id = g.id
group by g.id`;

export const vCreditGrantBalances = pgView("v_credit_grant_balances", {
  grantId: uuid("grant_id").notNull(),
  personId: uuid("person_id").notNull(),
  creditKind: creditGrantsCreditKind("credit_kind").notNull(),
  source: creditGrantsSource("source").notNull(),
  status: creditGrantsStatus("status").notNull(),
  productId: uuid("product_id"),
  membershipId: uuid("membership_id"),
  startsAt: tz("starts_at").notNull(),
  expiresAt: tz("expires_at"),
  unitsGranted: integer("units_granted").notNull(),
  unitValueCents: integer("unit_value_cents").notNull(),
  vatTreatment: creditGrantsVatTreatment("vat_treatment").notNull(),
  sharing: jsonb("sharing").$type<GrantSharingJson>().notNull(),
  baseUnits: integer("base_units").notNull(),
  remainingUnits: integer("remaining_units").notNull(),
  usedUnits: integer("used_units").notNull(),
  guestUnits: integer("guest_units").notNull(),
  expiredUnits: integer("expired_units").notNull(),
  adjustedUnits: integer("adjusted_units").notNull(),
  lastUsedAt: tz("last_used_at"),
  isUsable: boolean("is_usable").notNull(),
}).existing();

/** Customer-facing totals: the owner's usable grants only (shared grants are listed separately). */
export const vPersonCreditsSql = `select b.person_id, b.credit_kind,
       sum(b.remaining_units)::int as remaining_units,
       sum(b.remaining_units * b.unit_value_cents)::bigint as remaining_value_cents,
       count(*)::int as usable_grants,
       min(b.expires_at) as next_expires_at,
       array_agg(distinct b.product_id) filter (where b.product_id is not null) as product_ids
from v_credit_grant_balances b
where b.is_usable
group by b.person_id, b.credit_kind`;

export const vPersonCredits = pgView("v_person_credits", {
  personId: uuid("person_id").notNull(),
  creditKind: creditGrantsCreditKind("credit_kind").notNull(),
  remainingUnits: integer("remaining_units").notNull(),
  remainingValueCents: bigint("remaining_value_cents", { mode: "number" }).notNull(),
  usableGrants: integer("usable_grants").notNull(),
  nextExpiresAt: tz("next_expires_at"),
  /** The "package type" segment field (blueprint 6); null when no usable grant has a product. */
  productIds: uuid("product_ids").array(),
}).existing();

/**
 * Commercial status (blueprint 3 and 19, scenario 3, crm rule 3.8). A manual override always wins
 * for the classification. "Customer" = paid for a session, night, package, membership or ticket;
 * orders of only items or vouchers never count. `derived_status` is exactly D28; `ever_member`
 * feeds only `member_since_at` (DM-7).
 */
export const vPersonStatusSql = `with paid as (
  select o.person_id, min(o.paid_at) as first_paid_at from orders o
  where o.person_id is not null and o.paid_at is not null and o.total_cents > 0
    and o.status in ('paid', 'partially_refunded', 'refunded')
    and exists (select 1 from order_lines l where l.order_id = o.id
                and l.product_kind in ('session', 'night', 'package', 'membership', 'ticket'))
  group by o.person_id),
legacy as (
  select person_id, min(starts_at) as first_at from credit_grants
  where source in ('purchase', 'import') and credit_kind in ('day', 'night') group by person_id),
ever_member as (
  select person_id, min(started_at) as member_since_at from memberships
  where status in ('active', 'past_due')
     or (status in ('cancelled', 'expired') and ended_at > started_at)
  group by person_id),
cur as (
  select distinct on (person_id) person_id, id as membership_id, status, current_period_end_at, discount_pct
  from memberships
  where status in ('active', 'past_due') and started_at <= now()
  order by person_id, started_at desc)
select p.id as person_id,
       case when cur.membership_id is not null then 'member'
            when paid.person_id is not null or legacy.person_id is not null then 'customer'
            else 'lead' end as derived_status,
       p.status_override,
       coalesce(p.status_override::text,
         case when cur.membership_id is not null then 'member'
              when paid.person_id is not null or legacy.person_id is not null then 'customer'
              else 'lead' end) as status,
       (cur.membership_id is not null) as is_member,
       cur.membership_id, cur.status as membership_status, cur.current_period_end_at as membership_period_end_at,
       coalesce(cur.discount_pct, 0) as member_discount_pct,
       ever_member.member_since_at,
       least(paid.first_paid_at, legacy.first_at) as first_paid_at
from persons p
left join paid on paid.person_id = p.id
left join legacy on legacy.person_id = p.id
left join ever_member on ever_member.person_id = p.id
left join cur on cur.person_id = p.id
where p.erased_at is null and p.merged_into_person_id is null`;

export type PersonCommercialStatus = "lead" | "customer" | "member";

export const vPersonStatus = pgView("v_person_status", {
  personId: uuid("person_id").notNull(),
  derivedStatus: text("derived_status").$type<PersonCommercialStatus>().notNull(),
  statusOverride: personsStatusOverride("status_override"),
  status: text("status").$type<PersonCommercialStatus>().notNull(),
  isMember: boolean("is_member").notNull(),
  membershipId: uuid("membership_id"),
  membershipStatus: membershipsStatus("membership_status"),
  membershipPeriodEndAt: tz("membership_period_end_at"),
  memberDiscountPct: numeric("member_discount_pct", { precision: 5, scale: 2 }).notNull(),
  memberSinceAt: tz("member_since_at"),
  firstPaidAt: tz("first_paid_at"),
}).existing();

/** Outstanding prepaid value for finance (V1; dashboards in R3). Contract with finance (D29). */
export const vCreditLiabilitySql = `select b.credit_kind, b.vat_treatment, g.vat_rate_pct,
       sum(b.remaining_units)::bigint as remaining_units,
       sum(b.remaining_units * b.unit_value_cents)::bigint as remaining_value_cents,
       count(*)::int as grants
from v_credit_grant_balances b join credit_grants g on g.id = b.grant_id
where b.status = 'active' and b.remaining_units > 0
group by b.credit_kind, b.vat_treatment, g.vat_rate_pct`;

export const vCreditLiability = pgView("v_credit_liability", {
  creditKind: creditGrantsCreditKind("credit_kind").notNull(),
  vatTreatment: creditGrantsVatTreatment("vat_treatment").notNull(),
  vatRatePct: numeric("vat_rate_pct", { precision: 4, scale: 2 }),
  remainingUnits: bigint("remaining_units", { mode: "number" }).notNull(),
  remainingValueCents: bigint("remaining_value_cents", { mode: "number" }).notNull(),
  grants: integer("grants").notNull(),
}).existing();

/**
 * Multi-purpose voucher redemptions: VAT is due on the goods at redemption; flagged for the
 * accountant. Contract with finance (D29): exactly these seven columns.
 */
export const vEuroVoucherRedemptionsSql = `select e.id as entry_id, e.grant_id, e.person_id, e.ref_id as order_id,
       (-e.quantity)::int as amount_cents, e.created_at as redeemed_at,
       exists (select 1 from credit_entries r where r.reverses_entry_id = e.id) as is_reversed
from credit_entries e join credit_grants g on g.id = e.grant_id
where g.credit_kind = 'euro' and e.kind = 'consume' and e.ref_type = 'order'`;

export const vEuroVoucherRedemptions = pgView("v_euro_voucher_redemptions", {
  entryId: uuid("entry_id").notNull(),
  grantId: uuid("grant_id").notNull(),
  personId: uuid("person_id").notNull(),
  orderId: uuid("order_id"),
  amountCents: integer("amount_cents").notNull(),
  redeemedAt: tz("redeemed_at").notNull(),
  isReversed: boolean("is_reversed").notNull(),
}).existing();

/**
 * Deferred revenue movements per Brussels month (finance and management dashboards; accountant
 * export). Value = units x unit_value_cents (VAT included, as sold). Contract with finance (D29).
 */
export const vCreditMovementsMonthlySql = `select date_trunc('month', e.created_at at time zone 'Europe/Brussels')::date as month_on,
       g.credit_kind, g.vat_treatment, g.vat_rate_pct, e.kind as entry_kind,
       sum(e.quantity)::bigint as units,
       sum(e.quantity * g.unit_value_cents)::bigint as value_cents
from credit_entries e join credit_grants g on g.id = e.grant_id
group by 1, 2, 3, 4, 5`;

export const vCreditMovementsMonthly = pgView("v_credit_movements_monthly", {
  monthOn: date("month_on", { mode: "string" }).notNull(),
  creditKind: creditGrantsCreditKind("credit_kind").notNull(),
  vatTreatment: creditGrantsVatTreatment("vat_treatment").notNull(),
  vatRatePct: numeric("vat_rate_pct", { precision: 4, scale: 2 }),
  entryKind: creditEntriesKind("entry_kind").notNull(),
  units: bigint("units", { mode: "number" }).notNull(),
  valueCents: bigint("value_cents", { mode: "number" }).notNull(),
}).existing();

/**
 * R2 (credits-P8, rule 43): sharing patterns that need a human look, minus those already reviewed
 * with the same or a larger person set. `many_guests`: more than
 * `settings.booking_rules.guest_abuse.distinct_guests_per_30_days` (default 3) distinct guests on
 * one grant in 30 days; `guest_hopping`: one guest used on 3 or more owners' grants in 30 days.
 * `person_ids` are the guests (many_guests) or the owners (guest_hopping). The single abuse list
 * (booking's `listGuestAbuseCandidates`, ops' `shared_package_abuse` card).
 */
export const vSharingReviewSql = `with guest_use as (
  select e.grant_id, e.person_id as owner_person_id, e.beneficiary_person_id as guest_person_id, e.created_at
  from credit_entries e
  where e.kind = 'consume' and e.beneficiary_person_id is not null
    and e.beneficiary_person_id <> e.person_id and e.created_at > now() - interval '30 days'
    and not exists (select 1 from credit_entries r where r.reverses_entry_id = e.id)),
many as (
  select 'many_guests'::text as rule, grant_id, null::uuid as guest_person_id,
         array_agg(distinct guest_person_id) as person_ids, count(distinct guest_person_id)::int as distinct_count,
         max(created_at) as last_at
  from guest_use group by grant_id
  having count(distinct guest_person_id) > coalesce((select (value->'guest_abuse'->>'distinct_guests_per_30_days')::int
                                                   from settings where key = 'booking_rules'), 3)),
hop as (
  select 'guest_hopping'::text, null::uuid, guest_person_id,
         array_agg(distinct owner_person_id), count(distinct owner_person_id)::int, max(created_at)
  from guest_use group by guest_person_id having count(distinct owner_person_id) >= 3),
cand as (select * from many union all select * from hop)
select c.* from cand c
where not exists (
  select 1 from credit_sharing_reviews r
  where r.rule::text = c.rule
    and (r.grant_id = c.grant_id or r.guest_person_id = c.guest_person_id)
    and c.person_ids <@ r.guest_person_ids)`;

export const vSharingReview = pgView("v_sharing_review", {
  rule: text("rule").$type<"many_guests" | "guest_hopping">().notNull(),
  grantId: uuid("grant_id"),
  guestPersonId: uuid("guest_person_id"),
  personIds: uuid("person_ids").array().notNull(),
  distinctCount: integer("distinct_count").notNull(),
  lastAt: tz("last_at").notNull(),
}).existing();
