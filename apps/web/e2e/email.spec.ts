import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { emailHash } from "@beam/core/crm";
import { FAKE_RESEND_WEBHOOK_SECRET, signResendWebhook } from "@beam/integrations/resend";
import { signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows, e2eRewrite } from "./support/db";
import { uniqueEmail } from "./support/ids";
import { latestEmail } from "./support/sink";

/**
 * email end to end, part 1 (email-P5; runs at the wave checkpoint against beam_dev with the demo
 * seed): marketing staff create a newsletter template, build it in the block editor with a
 * heading and a dynamic block (a member variant and a fallback for everyone else) in Dutch, copy
 * the blocks to French and English, preview it as a lead and as a member, and publish it.
 * Part 2 (email-P6): a campaign on that newsletter to a 3-person static segment; one recipient is
 * removed on the recipients screen, a test send is made, the campaign is scheduled and then made
 * due at once ("send now" through the minute dispatch, so the removal happens while it is still
 * `scheduled`); exactly the two remaining persons get the message in the sink.
 * Part 3 (email-P7): the report of that campaign shows its two sent messages; a signed fake Resend
 * `email.bounced` (Permanent) webhook for one of them shows as bounced on the person page's email
 * history, and the address becomes unreachable for the newsletter.
 * Selectors use test ids, data attributes and ids, never copy. Templates this spec creates (slug
 * `e2e-newsletter-*`), their campaigns and the spec's segments (`E2E campaign segment *`) are
 * removed before and after.
 */
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const NAME = `E2E newsletter ${RUN}`;
const MEMBER = `MEMBER-E2E-${RUN}`;
const EVERYONE = `EVERYONE-E2E-${RUN}`;
let templateId = "";

async function resetTemplates(): Promise<void> {
  const owned = sql`select id from email_templates where slug like 'e2e-newsletter-%'`;
  const ownedCampaigns = sql`select id from campaigns where template_id in (${owned})`;
  await e2eRows(sql`update campaign_recipients set email_message_id = null where campaign_id in (${ownedCampaigns})`);
  await e2eRewrite([sql`delete from email_messages where campaign_id in (${ownedCampaigns})`]);
  await e2eRows(sql`delete from campaigns where id in (${ownedCampaigns})`);
  await e2eRows(sql`delete from segments where name like 'E2E campaign segment %'`);
  await e2eRows(sql`update email_templates set current_version_id = null where id in (${owned})`);
  await e2eRewrite([sql`delete from email_messages where template_version_id in (select id from email_template_versions where template_id in (${owned}))`]);
  await e2eRows(sql`delete from email_template_versions where template_id in (${owned})`);
  await e2eRows(sql`delete from email_templates where slug like 'e2e-newsletter-%'`);
}

/** Waits for the Server Action POST a click starts (never on a bare alert, CONVENTIONS 11). */
async function clickAndWait(page: Page, click: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await click();
  await response;
}

test.beforeAll(resetTemplates);
test.afterAll(async () => {
  await resetTemplates();
  await closeE2eDb();
});

test("marketing builds a newsletter with a dynamic block, previews it as lead and member, and publishes it", async ({ page }) => {
  await signInStaff(page, "marketing", { returnTo: "/admin/templates?kind=marketing" });
  await page.goto("/admin/templates?kind=marketing");

  await page.locator("#new-template-name").fill(NAME);
  await page.locator("#new-template-purpose").selectOption("newsletter");
  await page.locator("#new-template-name").press("Enter");
  await page.waitForURL(/\/admin\/templates\/[0-9a-f-]{36}$/);
  templateId = page.url().split("/").pop()!;
  await expect(page.getByTestId("block-editor")).toBeVisible();

  const palette = page.getByTestId("block-palette");
  const inspector = page.getByTestId("block-inspector");

  // Dutch: a heading and a dynamic block with a member variant and a fallback.
  await palette.locator('[data-block-type="heading"]').click();
  await inspector.locator("input").first().fill(`Nieuws ${RUN}`);
  await palette.locator('[data-block-type="dynamic"]').click();
  const dynamic = page.getByTestId("dynamic-editor");
  await expect(dynamic).toBeVisible();
  const inline = dynamic.getByTestId("block-palette-inline");
  await inline.first().locator('[data-block-type="text"]').click();
  await inline.last().locator('[data-block-type="text"]').click();
  const rows = page.locator("button[data-block-id]");
  await expect(rows).toHaveCount(4);
  await rows.nth(2).click();
  await inspector.locator("textarea").fill(`${MEMBER} Hallo {{first_name|lid}}`);
  await rows.nth(3).click();
  await inspector.locator("textarea").fill(EVERYONE);

  for (const locale of ["nl-BE", "fr-BE", "en"] as const) {
    await page.locator(`[data-locale="${locale}"]`).click();
    if (locale !== "nl-BE") await page.getByTestId("copy-from-nl-BE").click();
    await page.locator("#field-subject").fill(`Nieuwsbrief ${locale} ${RUN}`);
    await page.locator("#field-preheader").fill(`Voorkop ${locale}`);
  }
  await clickAndWait(page, () => page.getByTestId("save-draft").click());

  // Preview as member, then as lead (the fallback).
  await page.goto(`/admin/templates/${templateId}/preview?locale=nl-BE&use=draft&as=member`);
  await expect(page.getByTestId("preview-iframe")).toHaveAttribute("srcdoc", new RegExp(MEMBER));
  await expect(page.getByTestId("preview-subject")).toHaveText(`Nieuwsbrief nl-BE ${RUN}`);
  await page.locator('[data-persona="lead"]').click();
  await page.waitForURL(/as=lead/);
  const leadHtml = (await page.getByTestId("preview-iframe").getAttribute("srcdoc")) ?? "";
  expect(leadHtml).toContain(EVERYONE);
  expect(leadHtml).not.toContain(MEMBER);

  // Publish.
  await page.goto(`/admin/templates/${templateId}`);
  await clickAndWait(page, () => page.getByTestId("publish").click());
  await expect
    .poll(async () => {
      const [row] = await e2eRows<{ status: string; locales: string[] | null }>(
        sql`select t.status, v.locales from email_templates t left join email_template_versions v on v.id = t.current_version_id where t.id = ${templateId}`,
      );
      return row ? `${row.status}:${[...(row.locales ?? [])].sort().join(",")}` : "";
    })
    .toBe("published:en,fr-BE,nl-BE");
  const [compiled] = await e2eRows<{ variants: number }>(
    sql`select count(*)::int as variants from email_templates t join email_template_versions v on v.id = t.current_version_id, jsonb_object_keys(v.html_by_locale -> 'nl-BE') where t.id = ${templateId}`,
  );
  expect(compiled!.variants).toBe(2);
});

/** A person with a newsletter grant (the campaign's audience). */
async function subscribed(tag: string): Promise<{ id: string; email: string }> {
  const email = uniqueEmail(tag);
  const [p] = await e2eRows<{ id: string }>(sql`
    insert into persons (email, email_hash, first_name, last_name, locale, is_tester, acquisition)
    values (${email}, ${emailHash(email)}, ${tag}, 'Campaign', 'nl-BE', true, '{"source":"manual"}'::jsonb) returning id`);
  await e2eRows(sql`
    insert into consent_records (person_id, purpose, status, lawful_basis, source, method, wording_version, recorded_at, actor)
    values (${p!.id}, 'newsletter', 'granted', 'consent', 'e2e:email-campaign', 'form', 'newsletter@1', now() - interval '1 day', '{"kind":"system","id":null}'::jsonb)`);
  return { id: p!.id, email };
}

/** `YYYY-MM-DDTHH:mm` of tomorrow 10:00 in Brussels (the datetime-local value). */
function tomorrowTen(): string {
  const d = new Date(Date.now() + 86_400_000);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return `${day}T10:00`;
}

let sentCampaignId = "";
let sentPeople: { id: string; email: string }[] = [];

async function campaignStatus(id: string): Promise<string> {
  const [row] = await e2eRows<{ status: string }>(sql`select status from campaigns where id = ${id}`);
  return row?.status ?? "";
}

test("a campaign to a 3-person segment: remove one recipient, test send, send, two messages in the sink", async ({ page }) => {
  test.setTimeout(180_000);
  expect(templateId, "part 1 publishes the template this campaign uses").not.toBe("");
  const people = [await subscribed(`camp-a-${RUN}`), await subscribed(`camp-b-${RUN}`), await subscribed(`camp-c-${RUN}`)];
  const [segment] = await e2eRows<{ id: string }>(sql`insert into segments (name, kind) values (${`E2E campaign segment ${RUN}`}, 'static') returning id`);
  for (const p of people) await e2eRows(sql`insert into segment_members (segment_id, person_id, source) values (${segment!.id}, ${p.id}, 'manual')`);

  await signInStaff(page, "marketing", { returnTo: "/admin/campaigns/new" });
  await page.goto("/admin/campaigns/new");
  await page.locator("#campaign-name").fill(`E2E campaign ${RUN}`);
  await page.locator("#campaign-purpose").selectOption("newsletter");
  await page.locator("#campaign-template").selectOption(templateId);
  await page.getByTestId("campaign-create").click();
  await page.waitForURL(/\/admin\/campaigns\/[0-9a-f-]{36}\?step=content$/);
  const campaignId = new URL(page.url()).pathname.split("/").pop()!;

  // Audience: the segment; the estimate counts three reachable persons.
  await page.goto(`/admin/campaigns/${campaignId}?step=audience`);
  await page.locator("#campaign-segment").selectOption(segment!.id);
  await expect(page.getByTestId("estimate-reachable")).toHaveText("3");
  await clickAndWait(page, () => page.getByTestId("audience-save").click());
  await expect.poll(async () => (await e2eRows<{ segment_id: string | null }>(sql`select segment_id from campaigns where id = ${campaignId}`))[0]?.segment_id).toBe(segment!.id);

  // Review: a test send to the staff user's own address.
  await page.goto(`/admin/campaigns/${campaignId}?step=review`);
  await page.locator("#test-send button").first().click();
  await clickAndWait(page, () => page.locator('[data-slot="dialog-footer"] button').last().click());
  await expect.poll(async () => (await e2eRows<{ t: string | null }>(sql`select test_sent_at as t from campaigns where id = ${campaignId}`))[0]?.t).not.toBeNull();
  await page.reload();
  await expect(page.locator('[data-check="test_send"]')).toHaveAttribute("data-ok", "true");

  // Schedule for tomorrow 10:00 (confirming the send window when that day needs it).
  await page.goto(`/admin/campaigns/${campaignId}?step=schedule`);
  await page.locator("#campaign-scheduled-at").fill(tomorrowTen());
  const confirm = page.getByTestId("schedule-confirm-outside");
  if (await confirm.isVisible()) await confirm.click();
  await clickAndWait(page, () => page.getByTestId("schedule-submit").click());
  await expect.poll(() => campaignStatus(campaignId), { timeout: 60_000 }).toBe("scheduled");

  // Remove one recipient while the campaign is scheduled.
  await page.goto(`/admin/campaigns/${campaignId}/recipients`);
  const removed = people[2]!;
  await clickAndWait(page, () => page.locator(`tr[data-person-id="${removed.id}"]`).getByTestId("recipient-remove").click());
  await expect(page.locator(`tr[data-person-id="${removed.id}"]`)).toHaveAttribute("data-status", "removed");

  // Send now: the minute dispatch picks the campaign up once it is due.
  const sentAfter = new Date(Date.now() - 1000);
  await e2eRows(sql`update campaigns set scheduled_at = now() where id = ${campaignId}`);
  await expect.poll(() => campaignStatus(campaignId), { timeout: 120_000, intervals: [2000] }).toBe("sent");
  for (const p of people.slice(0, 2)) {
    const mail = await latestEmail(p.email, { after: sentAfter, subjectIncludes: RUN, timeoutMs: 30_000 });
    expect(mail.subject).toContain(RUN);
  }
  const [count] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from email_messages where campaign_id = ${campaignId} and kind = 'campaign'`);
  expect(count!.n).toBe(2);
  const [none] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from email_messages where campaign_id = ${campaignId} and person_id = ${removed.id}`);
  expect(none!.n).toBe(0);
  sentCampaignId = campaignId;
  sentPeople = people.slice(0, 2);
});

/** A signed fake Resend `email.bounced` (Permanent) delivery for the message's `resend_id`. */
async function hardBounce(request: APIRequestContext, resendId: string, to: string): Promise<number> {
  const at = new Date();
  const body = JSON.stringify({
    type: "email.bounced",
    created_at: at.toISOString(),
    data: { email_id: resendId, created_at: at.toISOString(), to: [to], bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist" } },
  });
  const id = `msg_e2e_p7_${RUN}`;
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const secret = process.env.RESEND_WEBHOOK_SECRET || FAKE_RESEND_WEBHOOK_SECRET;
  const res = await request.post("/api/webhooks/resend", {
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signResendWebhook({ id, timestamp, body, secret }) },
    data: body,
  });
  return res.status();
}

test("the report shows the sent campaign; a fake hard bounce shows on the person page and the address becomes unreachable", async ({ page, request }) => {
  test.setTimeout(120_000);
  expect(sentCampaignId, "part 2 sends the campaign this report shows").not.toBe("");

  await signInStaff(page, "marketing", { returnTo: `/admin/campaigns/${sentCampaignId}/report` });
  await page.goto(`/admin/campaigns/${sentCampaignId}/report`);
  await expect(page.getByTestId("campaign-report")).toBeVisible();
  await expect(page.locator('[data-kpi="sent"] [data-kpi-value]')).toHaveText("2");
  await expect(page.locator('[data-kpi="recipients"] [data-kpi-value]')).toHaveText("3");

  const target = sentPeople[0]!;
  const [message] = await e2eRows<{ id: string; resend_id: string }>(sql`select id, resend_id from email_messages where campaign_id = ${sentCampaignId} and person_id = ${target.id}`);
  expect(message?.resend_id, "the sent campaign message carries its Resend id").toBeTruthy();
  expect(await hardBounce(request, message!.resend_id, target.email)).toBe(200);
  await expect.poll(async () => (await e2eRows<{ status: string }>(sql`select status from email_messages where id = ${message!.id}`))[0]?.status, { timeout: 60_000, intervals: [2000] }).toBe("bounced");

  await page.goto(`/admin/persons/${target.id}`);
  await expect(page.locator(`[data-testid="person-email-rows"] tr[data-message-id="${message!.id}"]`)).toHaveAttribute("data-status", "bounced");
  await expect(page.locator('[data-testid="person-email-reachability"] [data-purpose="newsletter"]')).toHaveAttribute("data-reachable", "false");
  const [reach] = await e2eRows<{ is_reachable: boolean }>(sql`select is_reachable from v_marketing_reachability where person_id = ${target.id} and purpose = 'newsletter'`);
  expect(reach?.is_reachable).toBe(false);

  // The report counts the hard bounce.
  await page.goto(`/admin/campaigns/${sentCampaignId}/report`);
  await expect(page.locator('[data-kpi="hard_bounced"] [data-kpi-value]')).toHaveText("1");
});
