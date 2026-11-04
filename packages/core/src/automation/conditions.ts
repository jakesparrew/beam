/**
 * Condition evaluation (A-27, A-30): pure, over facts the step job loads fresh inside its
 * transaction (`loadFacts`, automation-P3). Nothing here reads the database.
 */
import { TRIGGER_CREDIT_KIND, type Condition, type ConditionPredicate, type PersonStatus } from "./definition";
import { matchesFilter } from "./filter";
import { DAY_MS } from "./time";

/** The person's current facts at step time. */
export type PersonFacts = {
  now: Date;
  /** `v_person_status` (computed status, override applied). */
  status: PersonStatus;
  /** `tags.key` of the person's tags. */
  tags: readonly string[];
  /** Segment ids the person is a member of. */
  segmentIds: readonly string[];
  /** `persons.processing_restricted_at is not null`. */
  processingRestricted: boolean;
  hasActiveMembership: boolean;
  /** An active membership with `cancel_at` set (ending at the period end). */
  membershipCancelling: boolean;
  /** Active, non-exhausted, non-expired grants. */
  activeGrants: readonly { grantId: string; creditKind: "day" | "night" | "euro" }[];
  /** The person's bookings with session start (`v_person_bookings`). */
  bookings: readonly { status: string; kind: "day" | "night" | "event"; startsAt: Date }[];
  /** Completed submissions (`form_submissions` status `completed`) by form slug. */
  formSubmissions: readonly { slug: string; completedAt: Date }[];
  /** Slugs of forms with a published version (`forms.getPublishedFormMeta` not null). */
  availableForms: readonly string[];
  /** Kinds of the person's events since `entered_at` of the enrolment. */
  eventKindsSinceEnrolment: readonly string[];
  /** Current status of the trigger booking (subject `booking:<id>`), else null. */
  triggerBookingStatus: string | null;
  /** Step keys of this enrolment whose task is still open. */
  openTaskStepKeys: readonly string[];
  /** Emails sent to the person by template slug. */
  sentTemplates: readonly { template: string; sentAt: Date }[];
};

/** What the condition is evaluated against besides the person: the enrolment's trigger. */
export type ConditionScope = {
  trigger: {
    kind: string;
    ref_type?: string | null;
    ref_id?: string | null;
    mode?: string | null;
    data: Record<string, unknown>;
  } | null;
  subjectKey: string;
};

export type ConditionResult = { result: boolean; predicate: string };

/** The grant id the enrolment's trigger is about (`credit_grant:<id>` subject or `data.grant_id`). */
function triggerGrantId(scope: ConditionScope): string | null {
  const t = scope.trigger;
  if (t?.ref_type === "credit_grant" && t.ref_id) return t.ref_id;
  if (typeof t?.data.grant_id === "string") return t.data.grant_id;
  if (scope.subjectKey.startsWith("credit_grant:")) return scope.subjectKey.slice("credit_grant:".length);
  return null;
}

const leafKey = (c: Condition): ConditionPredicate => Object.keys(c)[0] as ConditionPredicate;

const withinDays = (at: Date, now: Date, days: number | undefined) =>
  days === undefined || now.getTime() - at.getTime() <= days * DAY_MS;

function leaf(c: Condition, f: PersonFacts, scope: ConditionScope): boolean {
  if ("has_future_booking" in c) {
    const opts = c.has_future_booking === true ? {} : c.has_future_booking;
    const until = opts.within_days === undefined ? Infinity : f.now.getTime() + opts.within_days * DAY_MS;
    return f.bookings.some(
      (b) =>
        (b.status === "reserved" || b.status === "confirmed") &&
        b.startsAt.getTime() > f.now.getTime() &&
        b.startsAt.getTime() <= until &&
        (opts.kind === undefined || b.kind === opts.kind),
    );
  }
  if ("status_in" in c) return c.status_in.includes(f.status);
  if ("has_tag" in c) return f.tags.includes(c.has_tag);
  if ("in_segment" in c) return f.segmentIds.includes(c.in_segment);
  if ("has_active_membership" in c) return f.hasActiveMembership;
  if ("membership_cancelling" in c) return f.membershipCancelling;
  if ("has_other_active_grant" in c) {
    const wanted =
      c.has_other_active_grant.credit_kind === TRIGGER_CREDIT_KIND ? scope.trigger?.data.credit_kind : c.has_other_active_grant.credit_kind;
    if (typeof wanted !== "string") return false;
    const own = triggerGrantId(scope);
    return f.activeGrants.some((g) => g.creditKind === wanted && g.grantId !== own);
  }
  if ("form_completed" in c) {
    const { slug, within_days } = c.form_completed;
    return f.formSubmissions.some((s) => s.slug === slug && withinDays(s.completedAt, f.now, within_days));
  }
  if ("form_available" in c) return f.availableForms.includes(c.form_available);
  if ("processing_restricted" in c) return f.processingRestricted;
  if ("event_since_enrolment" in c) return f.eventKindsSinceEnrolment.includes(c.event_since_enrolment);
  if ("booking_status_in" in c) return f.triggerBookingStatus !== null && (c.booking_status_in as string[]).includes(f.triggerBookingStatus);
  if ("trigger" in c) {
    const t = scope.trigger;
    if (!t) return false;
    return matchesFilter(c.trigger, { mode: t.mode ?? null, refType: t.ref_type ?? null, refId: t.ref_id ?? null, data: t.data });
  }
  if ("task_open" in c) return f.openTaskStepKeys.includes(c.task_open);
  if ("sent_within_days" in c) {
    const { template, days } = c.sent_within_days;
    return f.sentTemplates.some((s) => s.template === template && withinDays(s.sentAt, f.now, days));
  }
  throw new Error(`evaluateCondition: unknown predicate ${Object.keys(c).join(",")}`);
}

/**
 * Evaluates a condition. `predicate` names what decided the result, for run reasons such as
 * `unless:has_future_booking`: the leaf key; for `any` the first true child (else `any`); for
 * `all` the first false child (else `all`); `not:<inner>` for a negation.
 */
export function evaluateCondition(c: Condition, facts: PersonFacts, scope: ConditionScope): ConditionResult {
  if ("all" in c) {
    for (const child of c.all) {
      const r = evaluateCondition(child, facts, scope);
      if (!r.result) return r;
    }
    return { result: true, predicate: "all" };
  }
  if ("any" in c) {
    for (const child of c.any) {
      const r = evaluateCondition(child, facts, scope);
      if (r.result) return r;
    }
    return { result: false, predicate: "any" };
  }
  if ("not" in c) {
    const r = evaluateCondition(c.not, facts, scope);
    return { result: !r.result, predicate: `not:${r.predicate}` };
  }
  return { result: leaf(c, facts, scope), predicate: leafKey(c) };
}

/** Every leaf predicate a condition uses, so the step job loads only the facts it needs. */
export function conditionPredicates(c: Condition | undefined, out: Set<ConditionPredicate> = new Set()): Set<ConditionPredicate> {
  if (!c) return out;
  if ("all" in c) c.all.forEach((x) => conditionPredicates(x, out));
  else if ("any" in c) c.any.forEach((x) => conditionPredicates(x, out));
  else if ("not" in c) conditionPredicates(c.not, out);
  else out.add(leafKey(c));
  return out;
}

/** Every condition node of a condition tree, depth first (validation and `isSegmentInUse`). */
export function walkCondition(c: Condition, visit: (node: Condition) => void): void {
  visit(c);
  if ("all" in c) c.all.forEach((x) => walkCondition(x, visit));
  else if ("any" in c) c.any.forEach((x) => walkCondition(x, visit));
  else if ("not" in c) walkCondition(c.not, visit);
}
