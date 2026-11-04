/**
 * Scenario 2: fast unsubscribe (proposal section 11; email spec rules 2, 32, 40, 53 to 58; email-P4).
 *
 * The spec creates its own rows (unique `@example.com` persons with a newsletter grant, a marketing
 * template, a marketing automation with one waiting step, a scheduled campaign of a segment id
 * nobody else uses) and never edits demo rows. Messages are queued as `sendTransactional` and
 * `queueMarketingEmail` queue them: an `email_messages` row plus its `email.send` job (key
 * `email:<id>`), run by the local tick (DR-13).
 *
 * Person A receives a marketing message; the spec reads it from the sink and POSTs crm's one-click
 * URL. The sink stores the rendered HTML, not the headers, so the URL is rebuilt from the
 * message's link token in its footer link: `List-Unsubscribe` is `<APP_URL/api/public/unsubscribe/
 * <token>>` for that same token (proved header by header in `modules/email/unsubscribe-links.test.ts`).
 * Within 60 s A's journey is `exited` with `unsubscribed`, a marketing message queued before the
 * unsubscribe is `suppressed` at send time, and nothing more of marketing reaches the sink, while a
 * transactional booking confirmation still arrives. Person B's fake Resend complaint (a signed
 * `email.complained` webhook) has the same effect. The campaign chunk (email-P6) then marks both
 * `skipped_suppressed`.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { sql } from "drizzle-orm";
import { emailHash } from "@beam/core/crm";
import { hashLinkToken } from "@beam/core/email";
import { FAKE_RESEND_WEBHOOK_SECRET, signResendWebhook } from "@beam/integrations/resend";
import { closeE2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";
import { latestEmail } from "./support/sink";

const WITHIN = 60_000;
const SEND_WAIT = 90_000;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Person = { id: string; email: string; enrolmentId: string };
type Ids = { templateId: string; versionId: string; slug: string; automationId: string; campaignId: string; a: Person; b: Person };
let ids: Ids | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` until `done` holds, for at most `timeoutMs`; returns the last value. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = WITHIN): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(500);
  }
}

const one = async <T>(query: Parameters<typeof e2eRows>[0]): Promise<T | undefined> => (await e2eRows<T>(query))[0];

const blocks = (locale: string) => [
  { id: `s2h${RUN}${locale}`, type: "heading", level: 1, text: "Hallo {{first_name|vriend}}" },
  { id: `s2t${RUN}${locale}`, type: "text", markdown: `Scenario 2 nieuws (${locale}). [Programma](https://beam.be/nl/events)` },
];

async function marketingTemplate(): Promise<{ templateId: string; versionId: string; slug: string }> {
  const slug = `e2e-s2-${RUN}`;
  const texts = JSON.stringify({ "nl-BE": "Scenario 2 nieuws", "fr-BE": "Scénario 2 nouvelles", en: "Scenario 2 news" });
  const document = JSON.stringify({ schemaVersion: 1, locales: { "nl-BE": blocks("nl"), "fr-BE": blocks("fr"), en: blocks("en") } });
  const t = (await one<{ id: string }>(sql`
    insert into email_templates (slug, name, kind, purpose, status) values (${slug}, ${`E2E scenario 2 ${RUN}`}, 'marketing', 'newsletter', 'published') returning id`))!;
  const v = (await one<{ id: string }>(sql`
    insert into email_template_versions (template_id, version, subject, preheader, document, locales, published_at)
    values (${t.id}, 1, ${texts}::jsonb, ${texts}::jsonb, ${document}::jsonb, array['nl-BE','fr-BE','en']::text[], now()) returning id`))!;
  await e2eRows(sql`update email_templates set current_version_id = ${v.id} where id = ${t.id}`);
  return { templateId: t.id, versionId: v.id, slug };
}

/** A marketing automation with one step a day away, so the journey stays active until it exits. */
async function marketingAutomation(): Promise<string> {
  const group = (await one<{ id: string }>(sql`
    insert into automation_groups (key, name) values (${`e2e_s2_${RUN}`}, 'E2E scenario 2') returning id`))!;
  const definition = JSON.stringify({
    schema_version: 1,
    trigger: { manual: true },
    anchor: "enrolment",
    re_entry: "always",
    exit_on: [],
    steps: [{ key: "s1", type: "tag", tag: "engaged", at: { from: "enrolment", minutes: 1440 } }],
  });
  const a = (await one<{ id: string }>(sql`
    insert into automations (slug, name, group_id, is_marketing, purpose) values (${`e2e-s2-${RUN}`}, 'E2E scenario 2 journey', ${group.id}, true, 'newsletter') returning id`))!;
  const v = (await one<{ id: string }>(sql`
    insert into automation_versions (automation_id, version, definition, definition_hash) values (${a.id}, 1, ${definition}::jsonb, ${`e2e-s2-${RUN}`}) returning id`))!;
  await e2eRows(sql`update automations set current_version_id = ${v.id}, status = 'active', activated_at = now() where id = ${a.id}`);
  return a.id;
}

async function subscribedPerson(tag: string, firstName: string, automationId: string): Promise<Person> {
  const email = uniqueEmail(tag);
  const p = (await one<{ id: string }>(sql`
    insert into persons (email, email_hash, first_name, last_name, locale, is_tester, acquisition)
    values (${email}, ${emailHash(email)}, ${firstName}, 'Scenario2', 'nl-BE', true, '{"source":"manual"}'::jsonb) returning id`))!;
  await e2eRows(sql`
    insert into consent_records (person_id, purpose, status, lawful_basis, source, method, wording_version, recorded_at, actor)
    values (${p.id}, 'newsletter', 'granted', 'consent', 'e2e:scenario2', 'form', 'newsletter@1', now() - interval '1 day', '{"kind":"system","id":null}'::jsonb)`);
  const e = (await one<{ id: string }>(sql`
    insert into automation_enrolments (automation_id, automation_version_id, person_id, group_id, source, status, next_step_key, next_step_at)
    select a.id, a.current_version_id, ${p.id}, a.group_id, 'staff', 'active', 's1', now() + interval '1 day' from automations a where a.id = ${automationId}
    returning id`))!;
  return { id: p.id, email, enrolmentId: e.id };
}

/** Queues one message and its `email.send` job, exactly as email's queue functions write them. */
async function queueMessage(input: {
  person: Person;
  kind: "automation" | "transactional";
  template: string;
  versionId: string | null;
  props?: Record<string, unknown>;
  runAt?: string;
}): Promise<string> {
  const marketing = input.kind === "automation";
  const key = `e2e:s2:${RUN}:${input.person.id}:${input.template}:${Math.random().toString(36).slice(2, 8)}`;
  const m = (await one<{ id: string }>(sql`
    insert into email_messages (person_id, to_email, kind, purpose, template_version_id, enrolment_id, locale, props, from_domain, idempotency_key, status)
    values (${input.person.id}, ${input.person.email}, ${input.kind}, ${marketing ? "newsletter" : null}, ${input.versionId}, ${marketing ? input.person.enrolmentId : null},
      'nl-BE', ${JSON.stringify(input.props ?? {})}::jsonb, ${marketing ? "news.beam.be" : "mail.beam.be"}, ${key}, 'queued')
    returning id`))!;
  await e2eRows(sql`
    insert into jobs (kind, payload, idempotency_key, lane, priority, run_at)
    values ('email.send', ${JSON.stringify({ emailMessageId: m.id, template: input.template })}::jsonb, ${`email:${m.id}`}, 'fast', ${marketing ? 5 : 1},
      coalesce(${input.runAt ?? null}::timestamptz, now()))`);
  return m.id;
}

const message = (id: string) =>
  one<{ status: string; resend_id: string | null; link_token_hash: string | null; sent_at: string | null }>(sql`
    select status, resend_id, link_token_hash, sent_at from email_messages where id = ${id}`);
const enrolment = (id: string) => one<{ status: string; end_reason: string | null }>(sql`select status, end_reason from automation_enrolments where id = ${id}`);
const suppressionsOf = (email: string) =>
  e2eRows<{ scope: string; reason: string; source: string }>(sql`select scope, reason, source from suppressions where email_hash = ${emailHash(email)}`);
/** Marketing messages of the person that left for Resend after `after`. */
const marketingSentAfter = async (personId: string, after: Date) =>
  (await one<{ n: number }>(sql`
    select count(*)::int as n from email_messages
    where person_id = ${personId} and from_domain = 'news.beam.be' and sent_at > ${after.toISOString()}::timestamptz`))!.n;

/** The newest marketing message of the person in the sink, and the link token of its crm links. */
async function marketingFromSink(person: Person, messageId: string, after: Date): Promise<{ token: string }> {
  const sent = await until(() => message(messageId), (m) => m?.status !== "queued", SEND_WAIT);
  expect(sent?.status, "the marketing message is sent (the sink holds its rendered copy)").toBe("sent");
  const mail = await latestEmail(person.email, { after, subjectIncludes: "Scenario 2", timeoutMs: SEND_WAIT });
  const prefs = mail.links.find((l) => /\/preferences\/[^/?#]+/.test(l));
  expect(prefs, "the footer carries crm's preference link").toBeTruthy();
  const token = decodeURIComponent(/\/preferences\/([^/?#]+)/.exec(prefs!)![1]!);
  expect(hashLinkToken(token), "the footer token is the message's own link token").toBe(sent!.link_token_hash);
  expect(mail.links.some((l) => l.includes(`/preferences/${encodeURIComponent(token)}?confirm=unsubscribe`)), "marketing footer has the unsubscribe link").toBe(true);
  return { token };
}

/** RFC 8058 one-click: POST with `List-Unsubscribe=One-Click` to the `List-Unsubscribe` target. */
async function oneClick(request: APIRequestContext, token: string): Promise<number> {
  const res = await request.post(`/api/public/unsubscribe/${encodeURIComponent(token)}`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: "List-Unsubscribe=One-Click",
  });
  return res.status();
}

/** A signed fake Resend `email.complained` delivery for the message's `resend_id`. */
async function complain(request: APIRequestContext, resendId: string, to: string): Promise<number> {
  const at = new Date();
  const body = JSON.stringify({ type: "email.complained", created_at: at.toISOString(), data: { email_id: resendId, created_at: at.toISOString(), to: [to] } });
  const id = `msg_e2e_s2_${RUN}`;
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const secret = process.env.RESEND_WEBHOOK_SECRET || FAKE_RESEND_WEBHOOK_SECRET;
  const res = await request.post("/api/webhooks/resend", {
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signResendWebhook({ id, timestamp, body, secret }) },
    data: body,
  });
  return res.status();
}

/** After an unsubscribe: the journey exits, the queued marketing message is suppressed, transactional mail still arrives. */
async function expectMarketingStopped(person: Person, input: { queuedBefore: string; since: Date }): Promise<void> {
  const e = await until(() => enrolment(person.enrolmentId), (r) => r?.status !== "active");
  expect(e, "the marketing journey ends within 60 s with the reason unsubscribed").toMatchObject({ status: "exited", end_reason: "unsubscribed" });

  const queued = await until(() => message(input.queuedBefore), (m) => m?.status !== "queued", SEND_WAIT);
  expect(queued?.status, "a marketing email queued before the unsubscribe is stopped at send time").toBe("suppressed");

  const confirmation = await queueMessage({
    person,
    kind: "transactional",
    template: "booking.booking_confirmed",
    versionId: (await one<{ id: string }>(sql`select current_version_id as id from email_templates where slug = 'booking.booking_confirmed'`))?.id ?? null,
    props: { title: "Scenario 2 sessie", date: "maandag 9 november 2026 om 10:00", url: "http://localhost:3100/nl/account/bookings", payAtDesk: false },
  });
  const tx = await until(() => message(confirmation), (m) => m?.status !== "queued", SEND_WAIT);
  expect(tx?.status, "a transactional booking confirmation still goes out").toBe("sent");
  await latestEmail(person.email, { after: input.since, timeoutMs: SEND_WAIT });

  expect(await marketingSentAfter(person.id, input.since), "no further marketing message reaches the sink").toBe(0);
}

test.describe("Scenario 2: fast unsubscribe (proposal section 11)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const template = await marketingTemplate();
    const automationId = await marketingAutomation();
    const a = await subscribedPerson("s2-a", "Anna", automationId);
    const b = await subscribedPerson("s2-b", "Bram", automationId);
    const owner = (await one<{ id: string }>(sql`select id from users where email = 'owner@demo.beam.be'`))!;
    // A scheduled campaign of a segment id nobody else uses; due tomorrow until the campaign test moves it to now.
    const c = (await one<{ id: string }>(sql`
      insert into campaigns (name, template_id, template_version_id, segment_id, purpose, status, scheduled_at, audience_snapshot_at, recipients_count, chunk_count, created_by_user_id)
      values (${`E2E scenario 2 ${RUN}`}, ${template.templateId}, ${template.versionId}, gen_random_uuid(), 'newsletter', 'scheduled', now() + interval '1 day', now(), 2, 1, ${owner.id})
      returning id`))!;
    await e2eRows(sql`insert into campaign_recipients (campaign_id, person_id, locale, chunk_no) values (${c.id}, ${a.id}, 'nl-BE', 0), (${c.id}, ${b.id}, 'nl-BE', 0)`);
    ids = { ...template, automationId, campaignId: c.id, a, b };
  });

  test.afterAll(async () => {
    if (ids) {
      await e2eRows(sql`update campaigns set status = 'cancelled', cancelled_at = now() where id = ${ids.campaignId} and status in ('draft', 'scheduled')`);
      await e2eRows(sql`update campaigns set status = 'stopped', stopped_at = now(), paused_reason = null where id = ${ids.campaignId} and status in ('sending', 'paused')`);
      await e2eRows(sql`
        update automation_enrolments set status = 'exited', end_reason = 'e2e_cleanup', ended_at = now(), next_step_at = null
        where automation_id = ${ids.automationId} and status = 'active'`);
      await e2eRows(sql`update automations set status = 'archived', paused_at = null where id = ${ids.automationId}`);
      await e2eRows(sql`update email_templates set status = 'archived' where id = ${ids.templateId}`);
    }
    await closeE2eDb();
  });

  test("the one-click URL of the sink's last marketing message suppresses at once and stops marketing within 60 s", async ({ request }) => {
    test.setTimeout(5 * 60_000);
    const { a, slug, versionId } = ids!;
    const before = new Date(Date.now() - 1000);
    const first = await queueMessage({ person: a, kind: "automation", template: slug, versionId });
    const { token } = await marketingFromSink(a, first, before);

    // Queued before the unsubscribe, due 20 s later: rule 40 re-reads reachability just before Resend.
    const later = await queueMessage({ person: a, kind: "automation", template: slug, versionId, runAt: new Date(Date.now() + 20_000).toISOString() });

    const at = new Date();
    expect(await oneClick(request, token)).toBe(200);
    const rows = await suppressionsOf(a.email);
    expect(rows, "the one-click POST writes the suppression immediately").toEqual([{ scope: "newsletter", reason: "unsubscribe", source: `one_click:${first}` }]);
    await expectMarketingStopped(a, { queuedBefore: later, since: at });
    expect(Date.now() - at.getTime(), "marketing stops well inside 15 minutes").toBeLessThan(15 * 60_000);
  });

  test("a fake Resend complaint has the same effect", async ({ request }) => {
    test.setTimeout(5 * 60_000);
    const { b, slug, versionId } = ids!;
    const before = new Date(Date.now() - 1000);
    const first = await queueMessage({ person: b, kind: "automation", template: slug, versionId });
    await marketingFromSink(b, first, before);
    const sent = (await message(first))!;
    expect(sent.resend_id, "the fake Resend id is stored").toBeTruthy();
    const later = await queueMessage({ person: b, kind: "automation", template: slug, versionId, runAt: new Date(Date.now() + 20_000).toISOString() });

    const at = new Date();
    expect(await complain(request, sent.resend_id!, b.email)).toBeLessThan(300);
    const rows = await until(() => suppressionsOf(b.email), (r) => r.some((s) => s.reason === "complaint"));
    expect(rows.find((s) => s.reason === "complaint"), "the complaint suppresses every marketing purpose").toMatchObject({ scope: "all", reason: "complaint" });
    await expectMarketingStopped(b, { queuedBefore: later, since: at });
  });

  test("the campaign chunk marks the unsubscribed and the complaining person skipped_suppressed", async () => {
    test.setTimeout(4 * 60_000);
    const { a, b, campaignId } = ids!;
    // The minute schedule `email.dispatch_due_campaigns` arrives with email-P6 (campaigns engine).
    const engine = await until(
      () => one<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'email.dispatch_due_campaigns'`),
      (r) => (r?.n ?? 0) > 0,
      75_000,
    );
    test.fixme((engine?.n ?? 0) === 0, "campaign.send_chunk and email.dispatch_due_campaigns are built by email-P6");

    const since = new Date();
    await e2eRows(sql`update campaigns set scheduled_at = now() where id = ${campaignId} and status = 'scheduled'`);
    const recipients = await until(
      () => e2eRows<{ person_id: string; status: string }>(sql`select person_id, status from campaign_recipients where campaign_id = ${campaignId}`),
      (r) => r.every((x) => x.status !== "planned"),
      2 * 60_000,
    );
    expect(Object.fromEntries(recipients.map((r) => [r.person_id, r.status]))).toEqual({ [a.id]: "skipped_suppressed", [b.id]: "skipped_suppressed" });
    expect(await marketingSentAfter(a.id, since)).toBe(0);
    expect(await marketingSentAfter(b.id, since)).toBe(0);
  });
});
