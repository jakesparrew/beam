/**
 * The description of the read-only `ai` schema that natural-language questions give Claude
 * (ops rule 77). One entry per view of `packages/db/src/sql/0101_ai_views_ops.sql` (ops' views,
 * webinar's `ai.webinar_performance_daily`, credits' `ai.package_cycles` and finance's
 * `FINANCE_AI_VIEWS`) plus forms' `ai.form_funnel_daily` and `ai.form_outcomes` (forms-P10).
 * The column lists match the SQL; `ro-role.test.ts` reads every listed view as `beam_ai_ro`.
 * Written in English, like the SQL. No view holds email, phone, last name, address, notes,
 * answers or a sensitive column; `first_name` is the only name.
 */
import { AI_SQL_FUNCTIONS } from "../ai/sql-guard";
import type { DpiaKey } from "./types";

export type AiViewDoc = {
  /** Schema-qualified view name (`ai.<name>`). */
  name: `ai.${string}`;
  description: string;
  /** `name type: note` per column, in the view's column order. */
  columns: readonly string[];
  /** The DPIA whose approval a question reading this view needs (rule 70, `DPIA_GATED_AI_RELATIONS`). */
  dpia?: DpiaKey;
};

const MASKED = "uuid, null when the person is erased, merged or under a processing restriction";

export const AI_VIEWS: readonly AiViewDoc[] = [
  {
    name: "ai.customers",
    description: "One row per active person (leads, customers and members; testers excluded). Indicators are null until the behavioural scoring DPIA is approved.",
    dpia: "ai_customer_ranking",
    columns: [
      "person_id uuid: the person (rendered as a link; never invent names)",
      "first_name text",
      "locale text: nl-BE, fr-BE or en",
      "status text: lead, customer or member",
      "is_member boolean",
      "b2c_stage text: lead, engaged_lead, experienced, first_visit, first_purchase, active, repeat, member, retention, lost",
      "acquisition_source text",
      "acquisition_campaign text",
      "tags text[]: tag keys",
      "created_at timestamptz",
      "visits int: attended visits, lifetime",
      "purchases int: paid orders, lifetime",
      "revenue_cents int: lifetime paid revenue in euro cents",
      "avg_order_cents int",
      "lifetime_value_cents int",
      "is_high_value boolean",
      "events_attended int",
      "no_shows int",
      "first_visit_at timestamptz",
      "last_visit_at timestamptz",
      "first_purchase_at timestamptz",
      "last_purchase_at timestamptz",
      "last_activity_at timestamptz",
      "days_since_activity int",
      "next_booking_at timestamptz",
      "has_future_booking boolean",
      "credits_day_remaining int",
      "credits_night_remaining int",
      "credits_euro_remaining int: euro credit in cents",
      "next_grant_expires_at timestamptz",
      "membership_status text: pending, active, past_due, cancelled, expired or null",
      "membership_period_end_at timestamptz",
      "predicted_value_cents int",
      "churn_probability float8: 0 to 0.99",
      "repurchase_probability float8: 0 to 0.99",
    ],
  },
  {
    name: "ai.products",
    description: "The product catalogue.",
    columns: [
      "product_id uuid",
      "sku text",
      "kind text: session, night, package, membership, ticket, item, voucher",
      "name_en text",
      "credit_kind text: day, night or euro (packages)",
      "credit_units int: sessions in a package (10 for a 10-session package)",
      "validity_days int",
      "recurring_interval text: month or year (memberships)",
      "is_active boolean",
    ],
  },
  {
    name: "ai.orders",
    description: "Every order (testers excluded); revenue counts orders with paid_at set and status paid, partially_refunded or refunded.",
    columns: [
      "order_id uuid",
      `person_id ${MASKED}`,
      "company_id uuid: B2B orders",
      "channel text: portal, site, admin, pos, link, recurring",
      "status text: draft, pending_payment, paid, cancelled, expired, refunded, partially_refunded",
      "created_at timestamptz",
      "paid_at timestamptz",
      "subtotal_cents int",
      "discount_cents int",
      "vat_cents int",
      "total_cents int: incl. VAT, euro cents",
    ],
  },
  {
    name: "ai.order_lines",
    description: "The lines of ai.orders.",
    columns: [
      "order_id uuid",
      "line_no int",
      "product_id uuid",
      "product_kind text",
      "product_sku text",
      "product_name_en text",
      "quantity int",
      "unit_amount_cents int",
      "discount_cents int",
      "line_total_cents int: incl. VAT",
      "vat_rate_pct float8",
      "vat_cents int",
    ],
  },
  {
    name: "ai.revenue",
    description: "Sales per Brussels day, channel and product kind (refunds are rows with product_kind 'refund'). Use it for revenue over time.",
    columns: [
      "day_on date: Brussels day",
      "channel text",
      "product_kind text",
      "orders int",
      "gross_cents int: incl. VAT",
      "vat_cents int",
      "refunds_cents int",
      "refunds_vat_cents int",
    ],
  },
  {
    name: "ai.bookings",
    description: "Bookings of sessions (testers excluded).",
    columns: [
      "booking_id uuid",
      `person_id ${MASKED}`,
      "session_id uuid",
      "session_kind text: day, night or event",
      "starts_at timestamptz",
      "status text: reserved, confirmed, cancelled, late_cancelled, no_show, attended",
      "paid_with text: credit, order, guest, free",
      "source text",
      "booked_at timestamptz",
      "cancelled_at timestamptz",
      "attended_at timestamptz",
      "is_guest boolean",
    ],
  },
  {
    name: "ai.grants",
    description: "Credit grants (packages, membership credits, vouchers) with their balance.",
    columns: [
      "grant_id uuid",
      `person_id ${MASKED}`,
      "product_id uuid",
      "product_sku text",
      "credit_kind text: day, night or euro",
      "source text: purchase, voucher, membership, bonus, import, manual, referral, transfer",
      "status text: active, exhausted, expired, revoked",
      "starts_at timestamptz: when the grant started (its purchase)",
      "expires_at timestamptz",
      "base_units int: units granted",
      "remaining_units int",
      "used_units int",
      "expired_units int",
      "last_used_at timestamptz",
    ],
  },
  {
    name: "ai.package_cycles",
    description: "One row per closed (exhausted or expired) purchased grant: whether the person bought again of the same credit kind.",
    columns: [
      "grant_id uuid",
      `person_id ${MASKED}`,
      "product_id uuid",
      "product_sku text",
      "credit_kind text",
      "closed_at timestamptz",
      "next_purchase_at timestamptz",
      "days_to_repurchase int",
      "repurchased boolean",
    ],
  },
  {
    name: "ai.memberships",
    description: "Memberships.",
    columns: [
      "membership_id uuid",
      `person_id ${MASKED}`,
      "product_id uuid",
      "product_sku text",
      "status text: pending, active, past_due, cancelled, expired",
      "interval text: month or year",
      "source text",
      "started_at timestamptz",
      "current_period_start_at timestamptz",
      "current_period_end_at timestamptz",
      "cancel_at timestamptz",
      "ended_at timestamptz",
      "end_reason text",
      "past_due_since_at timestamptz",
    ],
  },
  {
    name: "ai.retention_candidates",
    description: "People who need attention now, one row per reason, with a 0-100 score (higher is more urgent). Use it for 'who should we contact'.",
    dpia: "ai_customer_ranking",
    columns: [
      "person_id uuid",
      "reason text: visiting_less, package_nearly_finished, package_finished_no_repurchase, package_expiring, high_value_inactive, membership_renewal_due, purchased_never_booked, unused_sessions",
      "score int",
      "ref_type text: person, grant or membership",
      "ref_id uuid",
      "detail jsonb",
    ],
  },
  {
    name: "ai.campaign_attribution",
    description: "Revenue of paid orders credited to marketing campaigns (models first_touch and linear; weights of one order sum to 1 per model).",
    columns: [
      "order_id uuid",
      `person_id ${MASKED}`,
      "model text: first_touch or linear",
      "campaign_key text: source|campaign",
      "source text",
      "medium text",
      "campaign text",
      "weight float8",
      "revenue_cents int: the credited share",
      "paid_at timestamptz",
    ],
  },
  {
    name: "ai.ad_spend_daily",
    description: "Meta and Google Ads spend per campaign and day.",
    columns: [
      "platform text: meta or google",
      "campaign_external_id text",
      "campaign_name text",
      "day_on date",
      "spend_cents int",
      "impressions int",
      "clicks int",
      "leads int",
    ],
  },
  {
    name: "ai.opportunities",
    description: "B2B opportunities with their company. Open ones are those not won and not lost.",
    columns: [
      "opportunity_id uuid",
      "company_id uuid",
      "company_name text",
      "company_status text: target, prospect, customer, partner, ...",
      "stage text: target, prospect_identified, contact_identified, outreach, response, qualified, discovery, proposal, negotiation, won, lost, account_management, renewal",
      "stage_entered_at timestamptz",
      "value_cents int",
      "probability_pct int",
      "expected_close_on date",
      "next_action_at timestamptz: an overdue or missing next action needs attention",
      "won_at timestamptz",
      "lost_at timestamptz",
      "created_at timestamptz",
      "updated_at timestamptz",
    ],
  },
  {
    name: "ai.webinar_performance_daily",
    description: "Webinar performance per webinar and Brussels day.",
    columns: [
      "webinar_id uuid",
      "day_on date",
      "registrations int",
      "live_attendees int",
      "replay_viewers int",
      "on_demand_viewers int",
      "live_watchers int",
      "live_watch_sec int",
      "avg_live_watch_min float8",
      "replay_watchers int",
      "replay_watch_sec int",
      "avg_replay_watch_min float8",
      "on_demand_watchers int",
      "on_demand_watch_sec int",
      "avg_on_demand_watch_min float8",
      "poll_answers int",
      "cta_clicks int",
      "conversions_30d int",
    ],
  },
  {
    name: "ai.finance_revenue_daily",
    description:
      "Invoice-based revenue per Brussels issue day, document kind (invoice or credit_note), product category, payment method and VAT rate; credit notes are negative; category 'voucher' is a liability, not revenue.",
    columns: ["day date", "kind text", "category text", "payment_method text", "vat_rate_pct numeric", "net_cents int", "vat_cents int", "gross_cents int", "document_count int"],
  },
  {
    name: "ai.finance_vat_summary",
    description: "VAT per month, quarter, fiscal year, document kind and VAT rate; credit notes are negative.",
    columns: ["month text", "quarter text", "fiscal_year int", "kind text", "vat_rate_pct numeric", "net_cents int", "vat_cents int", "gross_cents int"],
  },
  {
    name: "ai.finance_failed_payments",
    description: "Failed and expired payments per Brussels day, provider and method; past_due_memberships is the number of memberships past due now.",
    columns: ["day date", "provider text", "method text", "failed_count int", "amount_cents int", "past_due_memberships int"],
  },
  {
    name: "ai.finance_recurring_monthly",
    description: "Documents of membership renewal orders per month; active_memberships is the number of active memberships now.",
    columns: ["month text", "invoice_count int", "net_cents int", "gross_cents int", "active_memberships int"],
  },
  {
    name: "ai.form_funnel_daily",
    description: "Form funnel per form and Brussels day (submissions count on the day they started).",
    columns: ["form_id uuid", "form_slug text", "form_kind text", "day_on date", "views int", "started int", "engaged int", "completed int", "abandoned int"],
  },
  {
    name: "ai.form_outcomes",
    description: "Completed submissions per form, version, Brussels day and outcome key (small groups merged).",
    columns: ["form_id uuid", "form_slug text", "form_version int", "day_on date", "outcome_key text", "completions int"],
  },
];

/** The view names without the schema (`customers`, `orders`, ...). */
export const AI_VIEW_NAMES: readonly string[] = AI_VIEWS.map((v) => v.name.slice(3));

/** The schema description sent as the system prompt of NL questions (stable, so it is cached). */
export function describeAiSchema(): string {
  const views = AI_VIEWS.map((v) => [`${v.name}: ${v.description}`, ...v.columns.map((c) => `  - ${c}`)].join("\n"));
  return [
    "You answer questions about BEAM Vitality Center's data by writing one read-only PostgreSQL query over the schema `ai` below.",
    "Rules: one `select` (or `with ... select`) statement, no semicolon, no comments; qualify every relation as ai.<view>;",
    `use only these functions: ${AI_SQL_FUNCTIONS.join(", ")} (casts with :: are fine).`,
    "Money is in euro cents (integers); timestamps are UTC, convert with `at time zone 'Europe/Brussels'` for days; return at most 200 rows.",
    "When rows are about people, include person_id (the screen turns it into a link) and first_name; never ask for emails, phone numbers or last names.",
    "If the question cannot be answered from these views, or asks for personal contact data or health data, set `refusal` to a short reason and `sql` to an empty string.",
    "",
    ...views,
  ].join("\n");
}
