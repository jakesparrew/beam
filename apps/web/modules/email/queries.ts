/**
 * email queries (email spec section 4 "Queries"). email-P5: the template store.
 *
 * - `listTemplates(db, { kind?, status?, q?, module?, page })`: the Transactional and Marketing
 *   tabs of `/admin/templates` (archived rows only with `status: 'archived'`), 50 per page.
 * - `getTemplate(db, templateId)`: template, draft, current version, completeness, references
 *   (active campaigns, automation use), version history, copy slots and merge fields.
 * - `getPreview(db, { templateId, use, locale, as }, { canReadPersons })`: subject, preheader,
 *   HTML, text, size and warnings of one locale for a sample persona or a real contact
 *   (`persons.read`; otherwise `forbidden`).
 *
 * email-P6, campaigns: `listCampaigns(db, { status?, q?, page })` (open and click rate per
 * campaign), `getCampaign(db, campaignId)` (campaign, template, draft and current version, segment
 * refs, review checklist, recipient counts by status), `getAudienceEstimate(db, { segmentId,
 * excludeSegmentIds, purpose })` → `{ total, reachable, byLocale, blockedByReason }` and
 * `listCampaignRecipients(db, { campaignId, status?, q?, page, pageSize: 50 }, { unmasked })`
 * (addresses masked unless `persons.read`).
 *
 * The pages call these after `requireStaff({ permission: 'email.write' })` (spec: staff queries
 * need `email.write`); the functions take the database so tests and pages share them.
 */
import { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { ForbiddenError } from "@beam/core/errors";
import {
  GetPreviewInput,
  ListTemplatesInput,
  type GetPreviewInput as GetPreviewArgs,
  type ListCampaignRecipientsInput as ListCampaignRecipientsArgs,
  type ListCampaignsInput as ListCampaignsArgs,
  type ListTemplatesInput as ListTemplatesArgs,
} from "@beam/core/email";
import { emailEvents, emailMessages, emailTemplates, users, vMarketingReachability } from "@beam/db/schema";
import { MESSAGES, type Locale } from "@beam/core/i18n";
import { asc, eq, sql } from "@/lib/ctx";
import { brusselsDayBounds, warmupCap, warmupWeek } from "@beam/core/email";
import { readFile } from "@/lib/files";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import { complaintState, type ComplaintState } from "./server/complaints";
import { deliveryProblems, type DeliveryCheck, type EmailHealth } from "./server/delivery-watch";
import { listCampaignRows, listRecipientRows, loadCampaignDetail, maskEmail, type CampaignDetail } from "./server/campaigns";
import { buildPreview, personRecipient, samplePersona, type PreviewResult } from "./server/preview";
import { draftVersionOf, listTemplateRows, loadTemplateDetail, loadTemplateVersion, transactionalModules, versionById, type TemplateDetail } from "./server/templates";

export type { CampaignDetail, CampaignListRow, RecipientListRow, ReviewChecklist } from "./server/campaigns";
export type { AudienceEstimate } from "./server/plan";
export { getAudienceEstimate } from "./server/plan";
export type { PreviewResult, PreviewWarning, RecipientContext } from "./server/preview";
export type { TemplateDetail, TemplateListRow } from "./server/templates";
export { samplePersona } from "./server/preview";

/**
 * Every message under `prefix` (`email.editor`) in `locale`, flattened to `{ key: text }` with
 * keys relative to the prefix: the label set handed to the editor's client components (ICU
 * `{name}` placeholders stay and are filled on the client).
 */
export function catalogueSection(locale: Locale, prefix: string): Record<string, string> {
  const [module, ...path] = prefix.split(".");
  let node: unknown = (MESSAGES as unknown as Record<string, Record<string, unknown>>)[locale]?.[module!];
  for (const segment of [module!, ...path]) node = node && typeof node === "object" ? (node as Record<string, unknown>)[segment] : undefined;
  const out: Record<string, string> = {};
  const walk = (n: unknown, at: string) => {
    if (typeof n === "string") out[at] = n;
    else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) walk(v, at ? `${at}.${k}` : k);
  };
  walk(node, "");
  return out;
}

/** The staff user's own address (the test send dialog's default recipient). */
export async function staffEmailOf(db: DbOrTx, userId: string): Promise<string> {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return u?.email ?? "";
}

export async function listTemplates(db: DbOrTx, input: ListTemplatesArgs = {}) {
  const args = ListTemplatesInput.parse(input);
  return listTemplateRows(db, args);
}

export function listTemplateModules(db: DbOrTx): Promise<string[]> {
  return transactionalModules(db);
}

export function getTemplate(db: DbOrTx, templateId: string): Promise<TemplateDetail | null> {
  return loadTemplateDetail(db, templateId);
}

/**
 * The preview of one locale. `opts.versionId` previews an older version (version history).
 * Returns null when the template or the requested version does not exist.
 */
export async function getPreview(db: DbOrTx, input: GetPreviewArgs, opts: { canReadPersons: boolean; versionId?: string; now?: Date }): Promise<PreviewResult | null> {
  const args = GetPreviewInput.parse(input);
  const [template] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, args.templateId));
  if (!template) return null;
  const version = opts.versionId
    ? await loadTemplateVersion(db, template.id, opts.versionId)
    : args.use === "draft"
      ? ((await draftVersionOf(db, template.id)) ?? (await versionById(db, template.currentVersionId)))
      : await versionById(db, template.currentVersionId);
  if (!version) return null;
  let recipient = samplePersona("lead");
  if (args.as && "personId" in args.as) {
    if (!opts.canReadPersons) throw new ForbiddenError("forbidden: persons.read", "persons.read");
    const found = await personRecipient(db, args.as.personId, version.document, args.locale);
    if (!found) return null;
    recipient = found;
  } else if (args.as) {
    recipient = samplePersona(args.as.sample, args.as.assessmentOutcome);
  }
  return buildPreview(db, { template, version, locale: args.locale, recipient, ...(opts.now ? { now: opts.now } : {}) });
}

export function listCampaigns(db: DbOrTx, input: ListCampaignsArgs = {}) {
  return listCampaignRows(db, input);
}

export function getCampaign(db: DbOrTx, campaignId: string): Promise<CampaignDetail | null> {
  return loadCampaignDetail(db, campaignId);
}

export function listCampaignRecipients(db: DbOrTx, input: ListCampaignRecipientsArgs, opts: { unmasked: boolean } = { unmasked: false }) {
  return listRecipientRows(db, input, opts);
}

// ---------------------------------------------------------------------------
// email-P7: reports, deliverability, the message log and the person history
// ---------------------------------------------------------------------------

export type { BounceRow, CampaignReport, LinkClicks, LocaleCounts, ReportStats, TimelineBucket } from "./server/reports";
export { campaignReportCsv, getCampaignReport } from "./server/reports";
export type { ComplaintState, DeliveryCheck, EmailHealth };

const MESSAGES_PAGE_SIZE = 50;
const MESSAGE_STATUSES = ["queued", "blocked_translation", "suppressed", "sent", "delivered", "bounced", "complained", "failed"] as const;
const MESSAGE_KINDS = ["transactional", "campaign", "automation", "test"] as const;
/** Statuses `resendMessage` accepts (spec section 4). */
export const RESENDABLE_STATUSES = ["sent", "delivered", "bounced", "failed"] as const;

export const ListMessagesInput = z.object({
  status: z.enum(MESSAGE_STATUSES).optional(),
  kind: z.enum(MESSAGE_KINDS).optional(),
  q: z.string().trim().max(200).optional(),
  personId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type ListMessagesArgs = z.input<typeof ListMessagesInput>;

export type MessageListRow = {
  id: string;
  createdAt: Date;
  sentAt: Date | null;
  personId: string | null;
  email: string | null;
  templateSlug: string | null;
  kind: (typeof MESSAGE_KINDS)[number];
  status: (typeof MESSAGE_STATUSES)[number];
  error: string | null;
  campaignId: string | null;
  campaignName: string | null;
};

const likePrefix = (q: string) => `${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/**
 * The message log of `/admin/email/messages`, newest first, 50 per page. `q` matches a template
 * slug or campaign name, and an address prefix only for staff who see addresses (`unmasked`);
 * `personId` narrows to one person (the person history's "all messages" link).
 */
export async function listMessages(
  db: DbOrTx,
  input: ListMessagesArgs = {},
  opts: { unmasked: boolean } = { unmasked: false },
): Promise<{ items: MessageListRow[]; page: number; pageSize: number; hasMore: boolean }> {
  const args = ListMessagesInput.parse(input);
  const q = args.q?.toLowerCase();
  const where = sql.join(
    [
      sql`true`,
      args.status ? sql`m.status = ${args.status}` : undefined,
      args.kind ? sql`m.kind = ${args.kind}` : undefined,
      args.personId ? sql`m.person_id = ${args.personId}::uuid` : undefined,
      args.from ? sql`m.created_at >= ${args.from.toISOString()}::timestamptz` : undefined,
      args.to ? sql`m.created_at < ${args.to.toISOString()}::timestamptz` : undefined,
      q
        ? opts.unmasked
          ? sql`(lower(m.to_email) like ${likePrefix(q)} or t.slug like ${likePrefix(q)} or c.name ilike ${`%${q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`})`
          : sql`(t.slug like ${likePrefix(q)} or c.name ilike ${`%${q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`})`
        : undefined,
    ].filter((x): x is NonNullable<typeof x> => !!x),
    sql` and `,
  );
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select m.id, m.created_at, m.sent_at, m.person_id, m.to_email, m.kind::text as kind, m.status::text as status, m.error,
        m.campaign_id, c.name as campaign_name, coalesce(t.slug, j.payload->>'template') as template_slug
      from email_messages m
      left join email_template_versions v on v.id = m.template_version_id
      left join email_templates t on t.id = v.template_id
      left join campaigns c on c.id = m.campaign_id
      left join jobs j on j.idempotency_key = 'email:' || m.id::text
      where ${where}
      order by m.created_at desc, m.id desc
      limit ${MESSAGES_PAGE_SIZE + 1} offset ${(args.page - 1) * MESSAGES_PAGE_SIZE}`),
  );
  const items = rows.slice(0, MESSAGES_PAGE_SIZE).map((r) => ({
    id: String(r.id),
    createdAt: new Date(r.created_at as string),
    sentAt: r.sent_at ? new Date(r.sent_at as string) : null,
    personId: (r.person_id as string | null) ?? null,
    email: opts.unmasked ? ((r.to_email as string | null) ?? null) : maskEmail((r.to_email as string | null) ?? null),
    templateSlug: (r.template_slug as string | null) ?? null,
    kind: r.kind as MessageListRow["kind"],
    status: r.status as MessageListRow["status"],
    error: (r.error as string | null) ?? null,
    campaignId: (r.campaign_id as string | null) ?? null,
    campaignName: (r.campaign_name as string | null) ?? null,
  }));
  return { items, page: args.page, pageSize: MESSAGES_PAGE_SIZE, hasMore: rows.length > MESSAGES_PAGE_SIZE };
}

export type MessageDetail = {
  message: Omit<typeof emailMessages.$inferSelect, "props" | "toEmail" | "linkTokenHash"> & { email: string | null; hasProps: boolean };
  templateSlug: string | null;
  templateKind: "transactional" | "marketing" | null;
  campaignName: string | null;
  events: { id: string; type: string; source: string; occurredAt: Date; url: string | null; linkIndex: number | null; reason: string | null }[];
  /** The stored rendered copy (non-production, `rendered_file_id`); null when none is kept. */
  html: string | null;
  canResend: boolean;
  /** When the detail was read (the page compares `send_at` with it). */
  loadedAt: Date;
};

/** `/admin/email/messages/[id]`: the message with its events and the stored rendered copy. */
export async function getMessage(db: DbOrTx, messageId: string, opts: { unmasked: boolean } = { unmasked: false }): Promise<MessageDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) return null;
  const [m] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
  if (!m) return null;
  const [meta] = rowsOf<{ slug: string | null; kind: "transactional" | "marketing" | null; campaign_name: string | null }>(
    await db.execute(sql`
      select coalesce(t.slug, j.payload->>'template') as slug, t.kind::text as kind, c.name as campaign_name
      from email_messages m
      left join email_template_versions v on v.id = m.template_version_id
      left join email_templates t on t.id = v.template_id
      left join campaigns c on c.id = m.campaign_id
      left join jobs j on j.idempotency_key = 'email:' || m.id::text
      where m.id = ${m.id}::uuid`),
  );
  const events = await db
    .select()
    .from(emailEvents)
    .where(eq(emailEvents.emailMessageId, m.id))
    .orderBy(asc(emailEvents.occurredAt), asc(emailEvents.createdAt));
  let html: string | null = null;
  if (m.renderedFileId) {
    const file = await readFile(db, m.renderedFileId);
    if (file) html = new TextDecoder().decode(file.bytes);
  }
  const { props, toEmail, linkTokenHash: _hash, ...rest } = m;
  return {
    message: { ...rest, email: opts.unmasked ? toEmail : maskEmail(toEmail), hasProps: props !== null },
    templateSlug: meta?.slug ?? null,
    templateKind: meta?.kind ?? null,
    campaignName: meta?.campaign_name ?? null,
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      source: e.source,
      occurredAt: e.occurredAt,
      url: e.url,
      linkIndex: e.linkIndex,
      reason: typeof (e.payload as { reason?: unknown })?.reason === "string" ? ((e.payload as { reason: string }).reason ?? null) : null,
    })),
    html,
    canResend: m.kind === "transactional" && (RESENDABLE_STATUSES as readonly string[]).includes(m.status),
    loadedAt: new Date(),
  };
}

export type PersonEmailHistoryRow = {
  id: string;
  createdAt: Date;
  sentAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  kind: MessageListRow["kind"];
  status: MessageListRow["status"];
  email: string | null;
  subject: string | null;
  templateSlug: string | null;
  campaignId: string | null;
  campaignName: string | null;
  automationName: string | null;
  canResend: boolean;
};

export const PERSON_HISTORY_PAGE_SIZE = 50;

/** Rule 63: every message to the person, newest first, 50 per page; addresses masked unless `persons.read`. */
export async function listPersonEmailHistory(
  db: DbOrTx,
  input: { personId: string; page?: number },
  opts: { unmasked: boolean } = { unmasked: false },
): Promise<{ items: PersonEmailHistoryRow[]; page: number; nextPage: number | null }> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select m.id, m.created_at, m.sent_at, m.opened_at, m.clicked_at, m.kind::text as kind, m.status::text as status, m.to_email, m.subject,
        coalesce(t.slug, j.payload->>'template') as template_slug, m.campaign_id, c.name as campaign_name,
        (select a.name from automation_enrolments en join automations a on a.id = en.automation_id where en.id = m.enrolment_id) as automation_name
      from email_messages m
      left join email_template_versions v on v.id = m.template_version_id
      left join email_templates t on t.id = v.template_id
      left join campaigns c on c.id = m.campaign_id
      left join jobs j on j.idempotency_key = 'email:' || m.id::text
      where m.person_id = ${input.personId}::uuid and m.kind <> 'test'
      order by m.created_at desc, m.id desc
      limit ${PERSON_HISTORY_PAGE_SIZE + 1} offset ${(page - 1) * PERSON_HISTORY_PAGE_SIZE}`),
  );
  const date = (v: unknown) => (v ? new Date(v as string) : null);
  const items = rows.slice(0, PERSON_HISTORY_PAGE_SIZE).map((r) => ({
    id: String(r.id),
    createdAt: new Date(r.created_at as string),
    sentAt: date(r.sent_at),
    openedAt: date(r.opened_at),
    clickedAt: date(r.clicked_at),
    kind: r.kind as MessageListRow["kind"],
    status: r.status as MessageListRow["status"],
    email: opts.unmasked ? ((r.to_email as string | null) ?? null) : maskEmail((r.to_email as string | null) ?? null),
    subject: opts.unmasked ? ((r.subject as string | null) ?? null) : null,
    templateSlug: (r.template_slug as string | null) ?? null,
    campaignId: (r.campaign_id as string | null) ?? null,
    campaignName: (r.campaign_name as string | null) ?? null,
    automationName: (r.automation_name as string | null) ?? null,
    canResend: r.kind === "transactional" && (RESENDABLE_STATUSES as readonly string[]).includes(String(r.status)),
  }));
  return { items, page, nextPage: rows.length > PERSON_HISTORY_PAGE_SIZE ? page + 1 : null };
}

/** Reachability of the person for each marketing purpose (the history panel's header). */
export async function personReachability(db: DbOrTx, personId: string): Promise<{ purpose: string; isReachable: boolean; blockedReason: string | null }[]> {
  const rows = await db
    .select({ purpose: vMarketingReachability.purpose, isReachable: vMarketingReachability.isReachable, blockedReason: vMarketingReachability.blockedReason })
    .from(vMarketingReachability)
    .where(eq(vMarketingReachability.personId, personId));
  const order = ["newsletter", "events", "member_comms", "b2b"];
  return rows.sort((a, b) => order.indexOf(a.purpose) - order.indexOf(b.purpose));
}

export type DomainStatus = { domain: "mail.beam.be" | "news.beam.be"; status: "verified" | "problem" | "unknown"; checkedAt: Date | null };

export type Deliverability = {
  /** The last 30 days. Rates are fractions (0.0123 = 1.23 %), null without a denominator. */
  kpis: {
    sent: number;
    delivered: number;
    deliveredRate: number | null;
    openRate: number | null;
    clickRate: number | null;
    hardBounceRate: number | null;
    complaintRate: number | null;
    unsubscribes: number;
  };
  rates7d: { bounceRate: number | null; complaintRate: number | null };
  domains: DomainStatus[];
  warmup: { warmingUp: boolean; week: number | null; cap: number | null; sentToday: number; startOn: string | null };
  complaint: ComplaintState;
  delivery: { checks: DeliveryCheck[]; health: EmailHealth };
  blocked: { id: string; templateSlug: string | null; locale: string; updatedAt: Date }[];
  suppressions: { id: string; email: string | null; reason: string; scope: string; createdAt: Date }[];
  hasAnyMessage: boolean;
};

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/**
 * `/admin/email` (spec section 5): KPI tiles of the last 30 days, domain status from the last
 * `email.check_domains` run, the warm-up week, cap and today's count, the complaint (rule 38) and
 * delivery (rule 38a) states, blocked-translation messages and the last 20 suppressions (masked).
 */
export async function getDeliverability(db: DbOrTx, now: Date = new Date()): Promise<Deliverability> {
  const since = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const d30 = since(30);
  const d7 = since(7);
  const [k] = rowsOf<Record<string, number>>(
    await db.execute(sql`
      select count(*)::int as sent,
        count(*) filter (where delivered_at is not null)::int as delivered,
        count(*) filter (where bounce_type = 'hard')::int as hard,
        count(*) filter (where from_domain = 'news.beam.be' and kind <> 'test' and delivered_at is not null)::int as m_delivered,
        count(*) filter (where from_domain = 'news.beam.be' and kind <> 'test' and opened_at is not null)::int as m_opened,
        count(*) filter (where from_domain = 'news.beam.be' and kind <> 'test' and clicked_at is not null)::int as m_clicked,
        count(*) filter (where from_domain = 'news.beam.be' and complained_at is not null)::int as m_complained,
        count(*) filter (where sent_at > ${d7}::timestamptz)::int as sent7,
        count(*) filter (where sent_at > ${d7}::timestamptz and bounce_type = 'hard')::int as hard7,
        count(*) filter (where sent_at > ${d7}::timestamptz and from_domain = 'news.beam.be' and delivered_at is not null)::int as m_delivered7,
        count(*) filter (where sent_at > ${d7}::timestamptz and from_domain = 'news.beam.be' and complained_at is not null)::int as m_complained7,
        (select count(*)::int from suppressions where reason = 'unsubscribe' and created_at > ${d30}::timestamptz) as unsubscribes,
        (select count(*)::int from (select 1 from email_messages limit 1) x) as any_message
      from email_messages where sent_at > ${d30}::timestamptz and sent_at <= ${now.toISOString()}::timestamptz`),
  );
  const n = (key: string) => Number(k?.[key] ?? 0);

  const [domainJob] = rowsOf<{ result: { problems?: string[] } | null; finished_at: string | Date | null }>(
    await db.execute(sql`
      select result, finished_at from jobs where kind = 'email.check_domains' and status = 'succeeded'
      order by finished_at desc nulls last limit 1`),
  );
  const problems = new Set(domainJob?.result?.problems ?? []);
  const checkedAt = domainJob?.finished_at ? new Date(domainJob.finished_at) : null;
  const domains: DomainStatus[] = (["mail.beam.be", "news.beam.be"] as const).map((domain) => ({
    domain,
    status: !domainJob ? "unknown" : problems.has(domain) ? "problem" : "verified",
    checkedAt,
  }));

  const schedule = await getSetting(db, "warmup_schedule");
  const cap = warmupCap(schedule, now);
  const { start, end } = brusselsDayBounds(now);
  const [today] = rowsOf<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from email_messages
      where from_domain = 'news.beam.be' and sent_at >= ${start.toISOString()}::timestamptz and sent_at < ${end.toISOString()}::timestamptz`),
  );

  const blocked = rowsOf<{ id: string; slug: string | null; locale: string; updated_at: string | Date }>(
    await db.execute(sql`
      select m.id, coalesce(t.slug, j.payload->>'template') as slug, m.locale, m.updated_at
      from email_messages m
      left join email_template_versions v on v.id = m.template_version_id
      left join email_templates t on t.id = v.template_id
      left join jobs j on j.idempotency_key = 'email:' || m.id::text
      where m.status = 'blocked_translation' order by m.updated_at desc limit 20`),
  );
  const supp = rowsOf<{ id: string; email: string | null; reason: string; scope: string; created_at: string | Date }>(
    await db.execute(sql`
      select s.id, coalesce(s.email, p.email) as email, s.reason::text as reason, s.scope::text as scope, s.created_at
      from suppressions s left join persons p on p.id = s.person_id
      order by s.created_at desc, s.id desc limit 20`),
  );

  return {
    kpis: {
      sent: n("sent"),
      delivered: n("delivered"),
      deliveredRate: ratio(n("delivered"), n("sent")),
      openRate: ratio(n("m_opened"), n("m_delivered")),
      clickRate: ratio(n("m_clicked"), n("m_delivered")),
      hardBounceRate: ratio(n("hard"), n("sent")),
      complaintRate: ratio(n("m_complained"), n("m_delivered")),
      unsubscribes: n("unsubscribes"),
    },
    rates7d: { bounceRate: ratio(n("hard7"), n("sent7")), complaintRate: ratio(n("m_complained7"), n("m_delivered7")) },
    domains,
    warmup: { warmingUp: cap !== null, week: cap !== null ? warmupWeek(schedule, now) + 1 : null, cap, sentToday: Number(today?.n ?? 0), startOn: schedule.start_on ?? null },
    complaint: await complaintState(db, now),
    delivery: await deliveryProblems(db, now),
    blocked: blocked.map((b) => ({ id: b.id, templateSlug: b.slug, locale: b.locale, updatedAt: new Date(b.updated_at) })),
    suppressions: supp.map((s) => ({ id: s.id, email: maskEmail(s.email), reason: s.reason, scope: s.scope, createdAt: new Date(s.created_at) })),
    hasAnyMessage: n("any_message") > 0,
  };
}
