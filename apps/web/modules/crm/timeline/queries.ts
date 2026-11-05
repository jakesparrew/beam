/**
 * Timeline queries for the 360 and company pages (crm spec 4.3, 4.7, rules 3.36 and 3.37),
 * crm-P7. `getTimeline` is `listTimeline` for crm's own screens. `toTimelineRows` turns a page
 * into display rows on the server: each crm kind through its `crm.timeline.<kind>` summary,
 * another module's kind through `<module>.timeline.<kind>` when that catalogue declares one,
 * automation items through `crm.timeline.automation_item`, and any other kind as its raw kind
 * string. A sensitive note never carries a body here: its row shows the placeholder only.
 */
import type { DbOrTx } from "@beam/db";
import { companies, companyContacts, persons, segments, tasks } from "@beam/db/schema";
import { formatCustomerNumber, type TimelineCategory, type TimelineItem, type TimelinePage } from "@beam/core/crm";
import { formatDateTime, t, type Locale } from "@beam/core/i18n";
import { eq, inArray } from "@/lib/ctx";
import type { TimelineRowView } from "../ui/timeline/event-row";
import { AUTOMATION_ITEM_PREFIX, listTimeline } from "./api";

export function getTimeline(
  tx: DbOrTx,
  input: { personId?: string; companyId?: string; before?: { occurredAt: Date; id: string }; categories?: TimelineCategory[]; limit?: number },
): Promise<TimelinePage> {
  return listTimeline(tx, input);
}

type Lookups = {
  persons: Map<string, string>;
  segments: Map<string, string>;
  tasks: Map<string, string>;
  contacts: Map<string, string>;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

async function loadLookups(tx: DbOrTx, items: readonly TimelineItem[]): Promise<Lookups> {
  const ids = (kinds: string[], key: string) => [...new Set(items.filter((i) => kinds.some((k) => i.kind.startsWith(k))).map((i) => str(i.data[key])).filter((v): v is string => !!v))];
  const personIds = ids(["person.merged"], "other_person_id");
  const segmentIds = ids(["segment."], "segment_id");
  const taskIds = ids(["task."], "task_id");
  const contactIds = ids(["company.contact_"], "contact_id");
  const [p, s, tk, c] = await Promise.all([
    personIds.length ? tx.select({ id: persons.id, n: persons.customerNumber }).from(persons).where(inArray(persons.id, personIds)) : [],
    segmentIds.length ? tx.select({ id: segments.id, name: segments.name }).from(segments).where(inArray(segments.id, segmentIds)) : [],
    taskIds.length ? tx.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, taskIds)) : [],
    contactIds.length
      ? tx.select({ id: companyContacts.id, name: companies.name }).from(companyContacts).innerJoin(companies, eq(companies.id, companyContacts.companyId)).where(inArray(companyContacts.id, contactIds))
      : [],
  ]);
  return {
    persons: new Map(p.map((r) => [r.id, formatCustomerNumber(r.n)])),
    segments: new Map(s.map((r) => [r.id, r.name])),
    tasks: new Map(tk.map((r) => [r.id, r.title])),
    contacts: new Map(c.map((r) => [r.id, r.name])),
  };
}

function enumLabel(locale: Locale, group: string, value: unknown): string {
  const v = str(value);
  if (!v) return "—";
  const key = `crm.enums.${group}.${v.replace("-", "_")}`;
  return t.has(locale, key) ? t(locale, key) : v;
}

/** The catalogue params of a crm kind (`crm.timeline.<kind_with_underscore>`). */
function crmParams(item: TimelineItem, locale: Locale, l: Lookups): Record<string, string> {
  const d = item.data;
  const fields = Array.isArray(d.fields) ? (d.fields as unknown[]).map(String).join(", ") : "";
  switch (item.kind) {
    case "person.created":
    case "person.acquisition_filled":
      return { source: enumLabel(locale, "acquisition_source", d.acquisition_source) };
    case "person.updated":
    case "company.updated":
    case "opportunity.updated":
      return { fields };
    case "opportunity.created":
      return { stage: enumLabel(locale, "opportunity_stage", d.to_stage) };
    case "opportunity.stage_changed":
    case "opportunity.won":
    case "opportunity.lost":
    case "opportunity.reopened":
      return { fromStage: enumLabel(locale, "opportunity_stage", d.from_stage), toStage: enumLabel(locale, "opportunity_stage", d.to_stage) };
    case "person.locale_changed":
      return { locale: enumLabel(locale, "locale", d.to) };
    case "person.status_overridden":
      return { status: enumLabel(locale, "person_status", d.to) };
    case "person.status_override_confirmed":
      return { status: enumLabel(locale, "person_status", d.status) };
    case "person.merged":
      return { customerNumber: l.persons.get(str(d.other_person_id) ?? "") ?? "—" };
    case "interaction.logged":
      return { channel: enumLabel(locale, "interaction_channel", d.channel), summary: str(d.summary) ?? "" };
    case "consent.granted":
    case "consent.withdrawn":
      return { purpose: enumLabel(locale, "consent_purpose", d.purpose) };
    case "suppression.added":
      return { scope: enumLabel(locale, "suppression_scope", d.scope), reason: enumLabel(locale, "suppression_reason", d.reason) };
    case "tag.added":
    case "tag.removed":
      return { tag: str(d.tag_key) ?? "—" };
    case "segment.entered":
    case "segment.left":
      return { segment: l.segments.get(str(d.segment_id) ?? "") ?? "—" };
    case "task.created":
    case "task.completed":
    case "task.cancelled":
    case "task.reopened":
      return { title: l.tasks.get(str(d.task_id) ?? "") ?? "—" };
    case "sensitive.updated":
      return { key: enumLabel(locale, "sensitive_key", d.key) };
    case "declaration.accepted":
      return { version: typeof d.document_version === "number" ? String(d.document_version) : "" };
    case "company.contact_linked":
    case "company.contact_unlinked":
      return { company: l.contacts.get(str(d.contact_id) ?? "") ?? "—" };
    default:
      return {};
  }
}

function summaryOf(item: TimelineItem, locale: Locale, l: Lookups): { summary: string; detail: string | null; isUnknown: boolean } {
  if (item.id.startsWith(AUTOMATION_ITEM_PREFIX)) {
    const d = item.data;
    const outcomeKey = `crm.timeline.automation_outcomes.${str(d.outcome) ?? ""}`;
    const outcome = t.has(locale, outcomeKey) ? t(locale, outcomeKey) : (str(d.outcome) ?? "");
    const summary = t(locale, "crm.timeline.automation_item", { automation: str(d.automation_name) ?? str(d.automation_slug) ?? "—", outcome });
    return { summary, detail: str(d.step_key), isUnknown: false };
  }
  const [module, ...rest] = item.kind.split(".");
  const crmKey = `crm.timeline.${item.kind.replace(".", "_")}`;
  if (t.has(locale, crmKey)) {
    try {
      const summary = t(locale, crmKey, crmParams(item, locale, l));
      const detail = item.kind === "note.added" ? str(item.data.body) : null;
      return { summary, detail, isUnknown: false };
    } catch {
      return { summary: item.kind, detail: null, isUnknown: true };
    }
  }
  const ownKey = `${module}.timeline.${rest.join("_")}`;
  if (module && module !== "crm" && t.has(locale, ownKey)) {
    try {
      const params = Object.fromEntries(Object.entries(item.data).filter(([, v]) => typeof v === "string" || typeof v === "number")) as Record<string, string | number>;
      return { summary: t(locale, ownKey, params), detail: null, isUnknown: false };
    } catch {
      /* falls through to the raw kind */
    }
  }
  return { summary: item.kind, detail: null, isUnknown: true };
}

/** Display rows for a timeline page (rule 3.37). */
export async function toTimelineRows(tx: DbOrTx, items: readonly TimelineItem[], locale: Locale): Promise<TimelineRowView[]> {
  const lookups = await loadLookups(tx, items);
  return items.map((item) => {
    const mode = (item.data as { mode?: unknown }).mode;
    const s = item.isSensitive ? { summary: t(locale, "crm.timeline.sensitive_note"), detail: null, isUnknown: false } : summaryOf(item, locale, lookups);
    const catKey = `crm.timeline.categories.${item.category}`;
    return {
      id: item.id,
      occurredAt: item.occurredAt.toISOString(),
      timeLabel: formatDateTime(item.occurredAt, locale),
      kind: item.kind,
      category: item.category,
      categoryLabel: t.has(locale, catKey) ? t(locale, catKey) : item.category,
      summary: s.summary,
      detail: s.detail,
      modeLabel: typeof mode === "string" ? enumLabel(locale, "activity_mode", mode) : null,
      isSensitive: item.isSensitive,
      isUnknown: s.isUnknown,
    };
  });
}
