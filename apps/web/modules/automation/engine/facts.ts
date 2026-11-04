/**
 * Fresh person facts at step time (A-27, A-30). `loadFacts` runs inside the step job's
 * transaction and reads only what the step's conditions need (`FactNeeds`), never values copied
 * at entry. Reads only (section 2.9): `v_person_status`, `persons`, `person_tags`, `tags`,
 * `segment_members`, `memberships`, `v_credit_grant_balances`, `v_person_bookings`, `bookings`,
 * `form_submissions`/`forms`, `activity_events`, `tasks`, `email_messages`; published forms come
 * from `forms.getPublishedFormMeta`.
 *
 * Decision: while forms' `getPublishedFormMeta` is still a stub (`NotImplementedError`), a form
 * counts as not available, which is the state the seed expects until staff publish it (DM-15).
 */
import type { Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import { conditionPredicates, type Condition, type ConditionPredicate, type PersonFacts, type PersonStatus } from "@beam/core/automation";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getPublishedFormMeta } from "@/modules/forms/api";

export type FactNeeds = {
  /** Leaf predicates the conditions use (`conditionPredicates`); facts of other predicates stay empty. */
  predicates: ReadonlySet<ConditionPredicate> | readonly ConditionPredicate[];
  now: Date;
  /** The enrolment (for `event_since_enrolment`, `task_open`, `booking_status_in`). */
  enrolment?: { id: string; enteredAt: Date; subjectKey: string };
  /** Slugs for `form_available` (looked up one by one through forms' api). */
  formSlugs?: readonly string[];
};

/** The needs of a set of conditions (undefined entries ignored). */
export function needsOf(conditions: readonly (Condition | undefined)[], base: Omit<FactNeeds, "predicates" | "formSlugs">): FactNeeds {
  const predicates = new Set<ConditionPredicate>();
  const formSlugs = new Set<string>();
  const visit = (c: Condition): void => {
    if ("all" in c) c.all.forEach(visit);
    else if ("any" in c) c.any.forEach(visit);
    else if ("not" in c) visit(c.not);
    else if ("form_available" in c) formSlugs.add(c.form_available);
  };
  for (const c of conditions) {
    if (!c) continue;
    conditionPredicates(c, predicates);
    visit(c);
  }
  return { ...base, predicates, formSlugs: [...formSlugs] };
}

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));

async function availableForms(tx: Tx, slugs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const slug of slugs) {
    try {
      if (await getPublishedFormMeta(tx, slug)) out.push(slug);
    } catch (error) {
      if (!(error instanceof NotImplementedError)) throw error;
    }
  }
  return out;
}

/** Loads the facts of `personId` that `needs` asks for (see the file header). */
export async function loadFacts(tx: Tx, personId: string, needs: FactNeeds): Promise<PersonFacts> {
  const want = new Set(needs.predicates);
  const has = (...p: ConditionPredicate[]) => p.some((x) => want.has(x));
  const now = needs.now;
  const e = needs.enrolment;
  const facts: PersonFacts = {
    now,
    status: "lead",
    tags: [],
    segmentIds: [],
    processingRestricted: false,
    hasActiveMembership: false,
    membershipCancelling: false,
    activeGrants: [],
    bookings: [],
    formSubmissions: [],
    availableForms: [],
    eventKindsSinceEnrolment: [],
    triggerBookingStatus: null,
    openTaskStepKeys: [],
    sentTemplates: [],
  };

  if (has("status_in")) {
    const [row] = rowsOf<{ status: PersonStatus }>(await tx.execute(sql`select status from v_person_status where person_id = ${personId}::uuid`));
    if (row) facts.status = row.status;
  }
  if (has("has_tag")) {
    facts.tags = rowsOf<{ key: string }>(
      await tx.execute(sql`select t.key from person_tags pt join tags t on t.id = pt.tag_id where pt.person_id = ${personId}::uuid`),
    ).map((r) => r.key);
  }
  if (has("in_segment")) {
    facts.segmentIds = rowsOf<{ id: string }>(
      await tx.execute(sql`select segment_id::text as id from segment_members where person_id = ${personId}::uuid`),
    ).map((r) => r.id);
  }
  if (has("processing_restricted")) {
    const [row] = rowsOf<{ restricted: boolean }>(
      await tx.execute(sql`select processing_restricted_at is not null as restricted from persons where id = ${personId}::uuid`),
    );
    facts.processingRestricted = row?.restricted === true;
  }
  if (has("has_active_membership", "membership_cancelling")) {
    const rows = rowsOf<{ cancelling: boolean }>(
      await tx.execute(sql`select cancel_at is not null as cancelling from memberships
        where person_id = ${personId}::uuid and status in ('active', 'past_due')`),
    );
    facts.hasActiveMembership = rows.length > 0;
    facts.membershipCancelling = rows.some((r) => r.cancelling);
  }
  if (has("has_other_active_grant")) {
    facts.activeGrants = rowsOf<{ grant_id: string; credit_kind: "day" | "night" | "euro" }>(
      await tx.execute(sql`select grant_id::text as grant_id, credit_kind::text as credit_kind from v_credit_grant_balances
        where person_id = ${personId}::uuid and is_usable`),
    ).map((r) => ({ grantId: r.grant_id, creditKind: r.credit_kind }));
  }
  if (has("has_future_booking")) {
    facts.bookings = rowsOf<{ status: string; kind: "day" | "night" | "event"; starts_at: string | Date }>(
      await tx.execute(sql`select status::text as status, kind::text as kind, starts_at from v_person_bookings
        where person_id = ${personId}::uuid and status in ('reserved', 'confirmed') and starts_at > ${now.toISOString()}::timestamptz`),
    ).map((r) => ({ status: r.status, kind: r.kind, startsAt: toDate(r.starts_at) }));
  }
  if (has("form_completed")) {
    facts.formSubmissions = rowsOf<{ slug: string; completed_at: string | Date }>(
      await tx.execute(sql`select f.slug, s.completed_at from form_submissions s join forms f on f.id = s.form_id
        where s.person_id = ${personId}::uuid and s.status = 'completed'`),
    ).map((r) => ({ slug: r.slug, completedAt: toDate(r.completed_at) }));
  }
  if (has("form_available")) facts.availableForms = await availableForms(tx, needs.formSlugs ?? []);
  if (has("event_since_enrolment") && e) {
    facts.eventKindsSinceEnrolment = rowsOf<{ kind: string }>(
      await tx.execute(sql`select distinct kind from activity_events
        where person_id = ${personId}::uuid and occurred_at >= ${e.enteredAt.toISOString()}::timestamptz and not is_sensitive`),
    ).map((r) => r.kind);
  }
  if (has("booking_status_in") && e?.subjectKey.startsWith("booking:")) {
    const [row] = rowsOf<{ status: string }>(
      await tx.execute(sql`select status::text as status from bookings where id::text = ${e.subjectKey.slice("booking:".length)}`),
    );
    facts.triggerBookingStatus = row?.status ?? null;
  }
  if (has("task_open") && e) {
    const prefix = `automation:${e.id}:`;
    facts.openTaskStepKeys = rowsOf<{ dedupe_key: string }>(
      await tx.execute(sql`select dedupe_key from tasks where status = 'open' and person_id = ${personId}::uuid and starts_with(dedupe_key, ${prefix})`),
    ).map((r) => r.dedupe_key.slice(prefix.length));
  }
  if (has("sent_within_days")) {
    facts.sentTemplates = rowsOf<{ slug: string; sent_at: string | Date }>(
      await tx.execute(sql`select t.slug, coalesce(m.sent_at, m.queued_at) as sent_at from email_messages m
        join email_template_versions v on v.id = m.template_version_id join email_templates t on t.id = v.template_id
        where m.person_id = ${personId}::uuid and m.status in ('queued', 'sent', 'delivered')`),
    ).map((r) => ({ template: r.slug, sentAt: toDate(r.sent_at) }));
  }
  return facts;
}
