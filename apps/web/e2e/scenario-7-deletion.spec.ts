import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { demoStaffEmail, signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows, e2eRewrite } from "./support/db";
import { uniqueEmail } from "./support/ids";
import { newCheckinCode } from "@beam/core/booking";

/**
 * Scenario 7: end-to-end deletion (proposal section 11; ops-P5, ops rules 59-64). Replaces Wave 0's
 * `test.fixme` shell. On beam_dev with the demo seed and the provider fakes: a fresh person (never a
 * shared demo row) gets a booking, a waitlist entry, a form submission, a campaign email, an
 * imported webinar registration and attendance, a native webinar registration with watch segments
 * and a live and a replay poll answer (ops-P7, R2), a terms acceptance, a paid order with its
 * invoice, a valid mandate and an AI request (all seeded by SQL). The owner creates, verifies and runs the
 * erasure on `/admin/privacy`; the jobs run on the local tick. Afterwards the CRM, email, webinar
 * history, native webinar registration, watch segments and poll answers, assessment, waitlist and
 * AI rows are gone or anonymised, the mandate is revoked, the
 * invoice stays with `person_id` null, the suppression hash remains, the Billit and Resend fakes
 * were called from `privacy.erase_external`, a re-import of the address is skipped with `erased`,
 * and neither the report nor the audit row holds personal data. The person cannot be restored, so
 * every run seeds its own; the other rows it adds are removed after the test (runbook 3.6).
 */
test.describe.configure({ mode: "serial" });

const OWNER = demoStaffEmail("owner");
const EMAIL = uniqueEmail("scenario7");
const FIRST = "Scenario";
const LAST = `Seven${Date.now().toString(36)}`;
const PHONE = "+32470999777";
const startedAt = new Date();
let personId = "";
let requestId = "";
let invoiceId = "";
let mandateId = "";
let registrationId = "";
const WEBINAR_SLUG = `e2e-s7-webinar-${Date.now().toString(36)}`;

const one = async <T>(q: Parameters<typeof e2eRows>[0]) => (await e2eRows<T>(q))[0];

async function seed(): Promise<void> {
  const owner = await one<{ id: string }>(sql`select id::text as id from users where lower(email) = lower(${OWNER})`);
  const person = await one<{ id: string }>(
    sql`insert into persons (email, first_name, last_name, phone, locale, acquisition, is_tester)
        values (${EMAIL}, ${FIRST}, ${LAST}, ${PHONE}, 'nl-BE', '{"source":"manual"}'::jsonb, true) returning id::text as id`,
  );
  personId = person!.id;
  const sessions = await e2eRows<{ id: string }>(sql`select id::text as id from sessions where starts_at > now() and status = 'open' order by starts_at limit 2`);
  await e2eRows(sql`insert into bookings (session_id, person_id, status, paid_with, source, checkin_code) values (${sessions[0]!.id}::uuid, ${personId}::uuid, 'confirmed', 'free', 'admin', ${newCheckinCode()})`);
  await e2eRows(sql`insert into waitlist_entries (session_id, person_id) values (${(sessions[1] ?? sessions[0])!.id}::uuid, ${personId}::uuid)`);
  await e2eRows(sql`insert into form_submissions (form_id, form_version_id, funnel, locale, person_id)
    select fv.form_id, fv.id, 'assessment', 'nl-BE', ${personId}::uuid from form_versions fv order by fv.created_at limit 1`);
  // A sent newsletter: campaign messages carry a purpose and a template version (email_messages checks).
  await e2eRows(sql`insert into email_messages (kind, purpose, template_version_id, locale, to_email, idempotency_key, person_id, status, sent_at)
    select 'campaign', 'newsletter', v.id, 'nl-BE', ${EMAIL}, ${`e2e:scenario7:${personId}`}, ${personId}::uuid, 'sent', now() - interval '3 days'
    from email_template_versions v order by v.created_at limit 1`);
  const [message] = await e2eRows<{ n: number }>(sql`select count(*)::int as n from email_messages where idempotency_key = ${`e2e:scenario7:${personId}`}`);
  expect(message?.n, "the seeded newsletter message exists").toBe(1);
  const file = await one<{ id: string }>(
    sql`insert into files (kind, name, mime, size_bytes, bytes, sha256) values ('import', 'webinar.csv', 'text/csv', 5, '\\x656d61696c'::bytea, ${createHash("sha256").update("email").digest("hex")}) returning id::text as id`,
  );
  const imp = await one<{ id: string }>(
    sql`insert into imports (kind, source, name, file_id, created_by_user_id, status) values ('history', 'webinar_tool', 'Scenario 7 webinar history', ${file!.id}::uuid, ${owner!.id}::uuid, 'done') returning id::text as id`,
  );
  for (const kind of ["webinar_registration", "webinar_attendance"]) {
    await e2eRows(sql`insert into imported_history (person_id, import_id, source, kind, occurred_at, external_id, data)
      values (${personId}::uuid, ${imp!.id}::uuid, 'webinar_tool', ${kind}, now() - interval '30 days', ${`e2e-s7-${kind}-${personId}`}, '{"mode":"live"}'::jsonb)`);
  }
  // R2: a native webinar registration with watch segments and a live and a replay poll answer.
  const title = JSON.stringify({ "nl-BE": "Scenario 7 webinar", "fr-BE": "Webinaire scénario 7", en: "Scenario 7 webinar" });
  const webinar = await one<{ id: string }>(
    sql`insert into webinars (slug, title, mode, starts_at, owner_user_id, created_by_user_id, attended_min_sec)
        values (${WEBINAR_SLUG}, ${title}::jsonb, 'live', now() - interval '2 days', ${owner!.id}::uuid, ${owner!.id}::uuid, 60) returning id::text as id`,
  );
  const registration = await one<{ id: string }>(
    sql`insert into webinar_registrations (webinar_id, person_id, access_token_hash, registered_mode, source, locale, person_status)
        values (${webinar!.id}::uuid, ${personId}::uuid, ${createHash("sha256").update(`s7:${personId}`).digest("hex")}, 'live', 'site', 'nl-BE', 'lead') returning id::text as id`,
  );
  registrationId = registration!.id;
  const viewId = randomUUID();
  for (const [from, mode] of [[0, "live"], [30, "live"], [0, "replay"]] as const) {
    await e2eRows(sql`insert into watch_segments (registration_id, webinar_id, mode, view_id, from_sec, to_sec)
      values (${registrationId}::uuid, ${webinar!.id}::uuid, ${mode}, ${mode === "live" ? viewId : randomUUID()}::uuid, ${from}, ${from + 30})`);
  }
  const option = JSON.stringify({ "nl-BE": "Ja", "fr-BE": "Oui", en: "Yes" });
  const poll = await one<{ id: string }>(
    sql`insert into webinar_polls (webinar_id, key, question, options)
        values (${webinar!.id}::uuid, 'sleep', ${title}::jsonb, ${`[{"key":"a","label":${option}},{"key":"b","label":${option}}]`}::jsonb) returning id::text as id`,
  );
  for (const mode of ["live", "replay"]) {
    await e2eRows(sql`insert into webinar_interactions (registration_id, webinar_id, mode, kind, poll_id, payload, at_sec)
      values (${registrationId}::uuid, ${webinar!.id}::uuid, ${mode}, 'poll_answer', ${poll!.id}::uuid, '{"option":"a"}'::jsonb, 15)`);
  }
  await e2eRows(sql`insert into terms_acceptances (person_id, page_version_id, legal_key, context, idempotency_key)
    select ${personId}::uuid, pv.id, 'terms', 'checkout', ${`e2e:s7:terms:${personId}`} from page_versions pv order by pv.created_at desc limit 1`);
  const order = await one<{ id: string }>(
    sql`insert into orders (channel, status, subtotal_cents, discount_cents, vat_cents, total_cents, locale, client_key, person_id, paid_at)
        values ('admin', 'paid', 4500, 0, 781, 4500, 'nl-BE', ${randomUUID()}, ${personId}::uuid, now()) returning id::text as id`,
  );
  // A paid invoice that satisfies the invoices checks: number `BEAM-<year>-<6-digit sequence>`,
  // the issue date inside the fiscal year, at least one line, paid_at, issued_by an actor. Fiscal
  // year 2099 keeps the row out of the real numbering and this year's reports.
  const sequence = 1 + Math.floor(Math.random() * 999_998);
  const line = {
    order_line_id: randomUUID(), product_id: randomUUID(), sku: "E2E-S7", category: "session", description: "Scenario 7 session",
    description_i18n: { "nl-BE": "Scenario 7 sessie", "fr-BE": "Séance scénario 7", en: "Scenario 7 session" },
    quantity: 1, unit_amount_cents: 4500, discount_cents: 0, discount_label: null, line_total_cents: 4500, vat_rate_pct: 21,
    vat_cents: 781, net_cents: 3719, vat_note: null, credit_kind: null, credit_units: null, session_starts_at: null,
  };
  const invoice = await one<{ id: string }>(
    sql`insert into invoices (kind, number, order_id, person_id, customer_snapshot, lines, subtotal_cents, vat_cents, total_cents, vat_breakdown,
          issued_on, status, paid_at, fiscal_year, sequence_number, locale, seller_snapshot, issued_by)
        values ('invoice', ${`BEAM-2099-${String(sequence).padStart(6, "0")}`}, ${order!.id}::uuid, ${personId}::uuid, ${JSON.stringify({ name: `${FIRST} ${LAST}`, email: EMAIL })}::jsonb,
          ${JSON.stringify([line])}::jsonb, 3719, 781, 4500, ${JSON.stringify([{ vat_rate_pct: 21, net_cents: 3719, vat_cents: 781, gross_cents: 4500 }])}::jsonb,
          '2099-01-01', 'paid', now(), 2099, ${sequence}, 'nl-BE', '{}'::jsonb, '{"kind":"system","id":null}'::jsonb)
        returning id::text as id`,
  );
  invoiceId = invoice!.id;
  const mandate = await one<{ id: string }>(
    sql`insert into mandates (provider, provider_mandate_id, provider_customer_id, method, status, person_id)
        values ('mollie', ${`mdt_e2e_${randomUUID().slice(0, 8)}`}, ${`cst_e2e_${randomUUID().slice(0, 8)}`}, 'directdebit', 'valid', ${personId}::uuid) returning id::text as id`,
  );
  mandateId = mandate!.id;
  await e2eRows(sql`insert into ai_requests (feature, model, actor, prompt, status, person_id)
    values ('ai.draft_reply', 'claude-opus-5-5', '{"kind":"system","id":null}'::jsonb, '{"fields":[]}'::jsonb, 'ok', ${personId}::uuid)`);
}

async function cleanup(): Promise<void> {
  await e2eRewrite([sql`delete from email_messages where idempotency_key like 'e2e:scenario7:%'`]);
  await e2eRows(sql`delete from webinar_polls where webinar_id in (select id from webinars w where w.slug like 'e2e-s7-webinar-%'
    and not exists (select 1 from webinar_registrations r where r.webinar_id = w.id))`);
  await e2eRows(sql`delete from webinars w where w.slug like 'e2e-s7-webinar-%' and not exists (select 1 from webinar_registrations r where r.webinar_id = w.id)`);
  await e2eRows(sql`delete from imports where name = 'Scenario 7 webinar history' and status = 'done' and not exists (select 1 from imported_history h where h.import_id = imports.id)`);
  await e2eRows(sql`delete from imports where name like 'Scenario 7 re-import%'`);
  // A run that stopped before the erasure leaves its person holding a seat and a waitlist place
  // on demo sessions: release them.
  const leftovers = sql`select id from persons where email like 'e2e+scenario7-%@example.com' and erased_at is null`;
  await e2eRows(sql`update bookings set status = 'cancelled', cancelled_at = now(), cancel_reason_code = 'staff', version = version + 1
    where status in ('reserved', 'confirmed') and person_id in (${leftovers})`);
  await e2eRows(sql`delete from waitlist_entries where person_id in (${leftovers})`);
}

test.beforeAll(async () => {
  await cleanup();
  await seed();
});
test.afterAll(async () => {
  await cleanup();
  await closeE2eDb();
});

test("one request erases the person everywhere, propagates externally and leaves no personal data in the report", async ({ page }) => {
  test.setTimeout(300_000);
  await signInStaff(page, "owner", { returnTo: `/admin/privacy/new?personId=${personId}` });
  const form = page.getByTestId("privacy-new");
  await form.locator('input[name="kind"][value="erase"]').check();
  await form.locator('textarea[name="verificationNote"]').fill("Identity checked at the desk (scenario 7)");
  const created = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await form.locator('button[type="submit"]').click();
  await created;
  await page.waitForURL(/\/admin\/privacy\/[0-9a-f-]{36}/);
  requestId = page.url().match(/\/admin\/privacy\/([0-9a-f-]{36})/)![1]!;

  const verify = page.getByTestId("privacy-verify");
  await verify.locator('textarea[name="verificationNote"]').fill("Identity checked at the desk (scenario 7)");
  await verify.locator('input[name="acknowledgeWarnings"]').check();
  const verified = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await verify.locator('button[type="submit"]').click();
  await verified;
  await expect(page.getByTestId("privacy-status")).toHaveAttribute("data-status", "verified");

  const run = page.getByTestId("privacy-run-now");
  const started = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined);
  await run.locator('button[type="submit"]').click();
  await started;

  await expect
    .poll(async () => (await one<{ status: string }>(sql`select status::text as status from privacy_requests where id = ${requestId}::uuid`))?.status, { timeout: 240_000, intervals: [1_000, 2_000, 5_000] })
    .toBe("done");

  // CRM: anonymised, email gone; email, webinar history, assessment, waitlist and AI rows gone or unlinked.
  const person = await one<{ erased_at: Date | null; email: string | null; first_name: string | null; phone: string | null }>(
    sql`select erased_at, email, first_name, phone from persons where id = ${personId}::uuid`,
  );
  expect(person!.erased_at).not.toBeNull();
  expect(person!.email).toBeNull();
  expect(person!.first_name).not.toBe(FIRST);
  expect(person!.phone).toBeNull();
  for (const table of ["email_messages", "imported_history", "form_submissions", "waitlist_entries", "ai_requests"]) {
    const left = await one<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(table)} where person_id = ${personId}::uuid`);
    expect(left!.n, table).toBe(0);
  }
  // Bookings are kept, linked to the anonymised person (booking spec section 9): the future seat
  // is cancelled with code `erased`, and no free text or QR file is left on the row.
  const booking = await one<{ status: string; code: string | null; notes: string | null; reason: string | null; qr: string | null }>(
    sql`select status::text as status, cancel_reason_code::text as code, notes, cancel_reason as reason, qr_file_id::text as qr from bookings where person_id = ${personId}::uuid`,
  );
  expect(booking, "bookings").toEqual({ status: "cancelled", code: "erased", notes: null, reason: null, qr: null });

  // R2: the native webinar registration, its watch segments and both poll answers are gone.
  const webinarLeft = await one<{ registrations: number; segments: number; answers: number }>(
    sql`select (select count(*)::int from webinar_registrations where person_id = ${personId}::uuid or id = ${registrationId}::uuid) as registrations,
               (select count(*)::int from watch_segments where registration_id = ${registrationId}::uuid) as segments,
               (select count(*)::int from webinar_interactions where registration_id = ${registrationId}::uuid) as answers`,
  );
  expect(webinarLeft).toEqual({ registrations: 0, segments: 0, answers: 0 });
  const webinarStep = await one<{ report: { steps: { module: string; table: string; rows: number }[] } }>(sql`select report from privacy_requests where id = ${requestId}::uuid`);
  const steps = webinarStep!.report.steps.filter((st) => st.module === "webinar");
  expect(steps.find((st) => st.table === "webinar_registrations")?.rows).toBeGreaterThanOrEqual(1);
  expect(steps.find((st) => st.table === "watch_segments")?.rows).toBeGreaterThanOrEqual(3);
  expect(steps.find((st) => st.table === "webinar_interactions")?.rows).toBeGreaterThanOrEqual(2);

  // Finance keeps the invoice (Belgian accounting law), unlinked from the person.
  const invoice = await one<{ person_id: string | null }>(sql`select person_id::text as person_id from invoices where id = ${invoiceId}::uuid`);
  expect(invoice).toBeDefined();
  expect(invoice!.person_id).toBeNull();

  // The mandate is revoked through commerce (its provider job runs on the tick).
  await expect.poll(async () => (await one<{ status: string }>(sql`select status::text as status from mandates where id = ${mandateId}::uuid`))?.status, { timeout: 60_000 }).toBe("revoked");

  // The suppression fingerprint remains, so marketing never reaches the address again.
  const hash = createHash("sha256").update(EMAIL.trim().toLowerCase()).digest("hex");
  const supp = await e2eRows<{ reason: string }>(sql`select reason::text as reason from suppressions where email_hash = ${hash}`);
  expect(supp.map((s) => s.reason)).toContain("erased");

  // Billit and Resend received their calls from privacy.erase_external (the fakes log them).
  const calls = await e2eRows<{ provider: string; operation: string }>(
    sql`select provider::text as provider, operation from integration_calls where created_at >= ${startedAt.toISOString()}::timestamptz
        and job_id in (select id from jobs where idempotency_key like ${`privacy:${requestId}:%:external:%`})`,
  );
  expect(calls.map((c) => c.provider)).toEqual(expect.arrayContaining(["resend"]));
  const report = await one<{ report: { external: { provider: string; outcome: string }[] } }>(sql`select report from privacy_requests where id = ${requestId}::uuid`);
  expect(report!.report.external.map((e) => e.provider)).toEqual(expect.arrayContaining(["billit", "mandates", "resend", "anthropic"]));

  // Neither the report nor the audit row holds personal data.
  const audit = await one<{ new_value: unknown; old_value: unknown }>(sql`select new_value, old_value from audit_log where action = 'privacy.erased' and entity_id = ${requestId}`);
  expect(audit).toBeDefined();
  for (const text of [JSON.stringify(report!.report), JSON.stringify(audit!.new_value), JSON.stringify(audit!.old_value)]) {
    for (const value of [EMAIL, FIRST, LAST, PHONE]) expect(text).not.toContain(value);
  }

  // The detail page shows the finished report.
  await page.reload();
  await expect(page.getByTestId("privacy-status")).toHaveAttribute("data-status", "done");
});

test("a re-import of the erased address is skipped with 'erased'", async () => {
  test.setTimeout(180_000);
  const owner = await one<{ id: string }>(sql`select id::text as id from users where lower(email) = lower(${OWNER})`);
  const csv = `email,first_name\n${EMAIL},${FIRST}\n`;
  const file = await one<{ id: string }>(
    sql`insert into files (kind, name, mime, size_bytes, bytes, sha256) values ('import', 'reimport.csv', 'text/csv', ${Buffer.byteLength(csv)}, ${Buffer.from(csv)}, ${createHash("sha256").update(csv).digest("hex")}) returning id::text as id`,
  );
  const mapping = { columns: { email: "email", first_name: "first_name" }, options: { delimiter: ",", dateFormat: "iso", defaultLocale: "nl-BE", overwrite: false } };
  const imp = await one<{ id: string }>(
    sql`insert into imports (kind, source, name, file_id, created_by_user_id, mapping, status, is_dry_run, run_seq)
        values ('persons', 'spreadsheet', ${`Scenario 7 re-import ${Date.now()}`}, ${file!.id}::uuid, ${owner!.id}::uuid, ${JSON.stringify(mapping)}::jsonb, 'dry_run', true, 1) returning id::text as id`,
  );
  await e2eRows(sql`insert into jobs (kind, payload, idempotency_key, lane, priority, max_attempts)
    values ('import.parse', ${JSON.stringify({ importId: imp!.id, runSeq: 1 })}::jsonb, ${`import:${imp!.id}:1:parse`}, 'bulk', 5, 6)`);
  await expect
    .poll(async () => (await one<{ status: string }>(sql`select dry_run_status::text as status from import_rows where import_id = ${imp!.id}::uuid and row_number = 1`))?.status ?? "missing", {
      timeout: 120_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toBe("skipped");
  const row = await one<{ message: string | null }>(sql`select message from import_rows where import_id = ${imp!.id}::uuid and row_number = 1`);
  expect(row!.message).toBe("erased");
  const persons = await one<{ n: number }>(sql`select count(*)::int as n from persons where lower(email) = lower(${EMAIL})`);
  expect(persons!.n).toBe(0);
});
