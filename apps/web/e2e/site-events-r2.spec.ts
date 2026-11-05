/**
 * site-P8 (R2): events and ticketing extensions on public event pages, on beam_dev.
 * 1. An event with ticket types lists each type with its public price and the "Members: <amount>"
 *    line, and "Get tickets" leads to the portal session page (sign-in with the return URL).
 * 2. A Lead Magnet event in its lead window shows "Priority access for new guests until <date>"
 *    (Europe/Brussels) and "Check your access", never a seat count, a rank or "Get tickets"
 *    (scenario 3, rule 32).
 * 3. A full event shows "Join the waitlist" to the portal session page.
 * 4. With `ff_webinar_portal` on, an event linked to a published demo webinar shows "Register for
 *    the webinar" to the webinar's own page (edge case 36); skipped while the flag is off or no
 *    webinar session exists.
 *
 * The spec creates its own products, event sessions and event pages under a unique tag (no demo
 * row is touched) and removes them before and after: pages are archived and their routes dropped
 * (published versions are immutable), sessions cancelled, products deactivated.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { closeE2eDb, e2eRows } from "./support/db";

const TAG = randomUUID().replace(/-/g, "").slice(0, 8);
const SKU_PREFIX = `E2E-R2-${TAG.toUpperCase()}`;
const DAY = 24 * 60 * 60 * 1000;

const made = { products: [] as string[], sessions: [] as string[], pages: [] as string[] };

const localized = (en: string, nl: string, fr: string) => JSON.stringify({ "nl-BE": nl, "fr-BE": fr, en });

async function product(n: number, publicCents: number, memberCents: number | null): Promise<string> {
  const [row] = await e2eRows<{ id: string }>(sql`
    insert into products (kind, sku, name, vat_rate_pct, is_active)
    values ('ticket', ${`${SKU_PREFIX}-${n}`}, ${localized(`R2 ticket ${n}`, `R2 ticket ${n}`, `R2 billet ${n}`)}::jsonb, 21.00, true)
    returning id`);
  await e2eRows(sql`insert into price_versions (product_id, version, audience, amount_cents) values (${row!.id}, 1, 'public', ${publicCents})`);
  if (memberCents !== null) await e2eRows(sql`insert into price_versions (product_id, version, audience, amount_cents) values (${row!.id}, 2, 'member', ${memberCents})`);
  made.products.push(row!.id);
  return row!.id;
}

/** A published, open event about ten days ahead (fractional days keep it clear of midnight in Brussels). */
async function eventSession(opts: { capacity?: number; lead?: { endsAt: Date }; productId?: string } = {}): Promise<string> {
  const startsAt = new Date(Date.now() + 10.4 * DAY);
  const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
  const [row] = await e2eRows<{ id: string }>(sql`
    insert into sessions (kind, title, starts_at, ends_at, capacity_seats, event_category, published_at, product_id,
                          is_lead_magnet, lead_reserved_seats, lead_window_start_at, lead_window_end_at)
    values ('event', ${localized(`R2 event ${TAG}`, `R2 evenement ${TAG}`, `R2 événement ${TAG}`)}::jsonb, ${startsAt}, ${endsAt},
            ${opts.capacity ?? 30}, 'lecture', now() - interval '1 day', ${opts.productId ?? null},
            ${!!opts.lead}, ${opts.lead ? 10 : 0}, ${opts.lead ? new Date(Date.now() - 60 * 60 * 1000) : null}, ${opts.lead?.endsAt ?? null})
    returning id`);
  made.sessions.push(row!.id);
  return row!.id;
}

async function ticketType(sessionId: string, productId: string, name: string, sortOrder: number): Promise<void> {
  await e2eRows(sql`
    insert into ticket_types (session_id, product_id, name, sort_order)
    values (${sessionId}, ${productId}, ${localized(name, name, name)}::jsonb, ${sortOrder})`);
}

/** A published event page for the session at `/<prefix>/e2e-r2-<tag>-<n>` in every locale. */
async function eventPage(sessionId: string, n: number): Promise<string> {
  const path = `e2e-r2-${TAG}-${n}`;
  const [page] = await e2eRows<{ id: string }>(sql`insert into pages (kind, slug, session_id) values ('event', ${path}, ${sessionId}) returning id`);
  const paths = JSON.stringify({ "nl-BE": path, "fr-BE": path, en: path });
  const blocks = JSON.stringify({ "nl-BE": [], "fr-BE": [], en: [] });
  const [version] = await e2eRows<{ id: string }>(sql`
    insert into page_versions (page_id, version, state, title, paths, blocks, published_at)
    values (${page!.id}, 1, 'published', ${localized(`R2 event ${TAG}`, `R2 evenement ${TAG}`, `R2 événement ${TAG}`)}::jsonb, ${paths}::jsonb, ${blocks}::jsonb, now())
    returning id`);
  await e2eRows(sql`update pages set status = 'published', current_version_id = ${version!.id}, first_published_at = now() where id = ${page!.id}`);
  for (const locale of ["nl-BE", "fr-BE", "en"]) {
    await e2eRows(sql`insert into page_routes (page_id, locale, path, version_id) values (${page!.id}, ${locale}, ${path}, ${version!.id})`);
  }
  made.pages.push(page!.id);
  return path;
}

async function cleanup(): Promise<void> {
  const pages = await e2eRows<{ id: string }>(sql`select id from pages where slug like ${`e2e-r2-${TAG}-%`}`);
  for (const p of pages) {
    await e2eRows(sql`delete from page_routes where page_id = ${p.id}`);
    await e2eRows(sql`update pages set status = 'archived', archived_at = now(), session_id = null where id = ${p.id}`);
  }
  const sessions = await e2eRows<{ id: string }>(sql`select id from sessions where title->>'en' = ${`R2 event ${TAG}`}`);
  for (const s of sessions) {
    await e2eRows(sql`delete from bookings where session_id = ${s.id}`);
    await e2eRows(sql`update ticket_types set is_active = false where session_id = ${s.id}`);
    await e2eRows(sql`update sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'e2e site-events-r2 cleanup' where id = ${s.id} and status <> 'cancelled'`);
  }
  await e2eRows(sql`update products set is_active = false where sku like ${`${SKU_PREFIX}-%`}`);
}

const money = (cents: number, locale: string) => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(cents / 100);

test.describe("event pages, R2 extensions (site-P8)", () => {
  test.beforeAll(async () => {
    await cleanup();
  });
  test.afterAll(async () => {
    await cleanup();
    await closeE2eDb();
  });

  test("ticket types show public and member prices, Get tickets leads to the portal session page", async ({ page }) => {
    const standard = await product(1, 2500, 2000);
    const duo = await product(2, 4000, null);
    const sessionId = await eventSession();
    await ticketType(sessionId, standard, "Standard", 1);
    await ticketType(sessionId, duo, "Duo", 2);
    const path = await eventPage(sessionId, 1);

    await page.goto(`/en/${path}`);
    const types = page.locator("[data-ticket-types] [data-ticket-type]");
    await expect(types).toHaveCount(2);
    await expect(types.nth(0)).toContainText("Standard");
    await expect(types.nth(0).locator('[data-price="public"]')).toHaveText(money(2500, "en"));
    await expect(types.nth(0).locator('[data-price="member"]')).toContainText(money(2000, "en"));
    await expect(types.nth(1).locator('[data-price="member"]')).toHaveCount(0);
    await expectAccessible(page);

    await page.locator('a[data-action="tickets"]').click();
    await expect(page).toHaveURL((url) => url.pathname === "/en/account/login" && url.searchParams.get("returnTo") === `/en/account/book/${sessionId}`);
  });

  test("a Lead Magnet event in its lead window shows the priority line and Check your access only", async ({ page }) => {
    const endsAt = new Date(Date.now() + 2.4 * DAY);
    const sessionId = await eventSession({ lead: { endsAt }, productId: await product(3, 1500, null) });
    const path = await eventPage(sessionId, 2);

    await page.goto(`/nl/${path}`);
    const brussels = new Intl.DateTimeFormat("nl-BE", { timeZone: "Europe/Brussels", day: "numeric", month: "long", year: "numeric" }).format(endsAt);
    await expect(page.locator("[data-lead-window]")).toContainText(brussels);
    await expect(page.locator('a[data-action="check_access"]')).toHaveAttribute("href", `/nl/account/book/${sessionId}`);
    await expect(page.locator('a[data-action="tickets"]')).toHaveCount(0);
    await expect(page.locator("[data-event] [data-band]")).toHaveCount(0);
    await expect(page.locator("[data-event]")).not.toContainText(/\b\d+ (plaatsen|plaats)\b/);
    await expectAccessible(page);
  });

  test("a full event shows Join the waitlist", async ({ page }) => {
    const sessionId = await eventSession({ capacity: 1, productId: await product(4, 1000, null) });
    const [person] = await e2eRows<{ id: string }>(sql`select id from persons where email like '%@demo.beam.be' order by created_at limit 1`);
    test.skip(!person, "no demo person to fill the seat");
    await e2eRows(sql`insert into bookings (session_id, person_id, status, paid_with, source) values (${sessionId}, ${person!.id}, 'confirmed', 'free', 'admin')`);
    const path = await eventPage(sessionId, 3);

    await page.goto(`/fr/${path}`);
    await expect(page.locator("[data-event] [data-band]")).toHaveAttribute("data-band", "full");
    await expect(page.locator('a[data-action="waitlist"]')).toHaveAttribute("href", `/fr/account/book/${sessionId}`);
  });

  test("a webinar-linked event shows Register for the webinar", async ({ page }) => {
    const [flagRow] = await e2eRows<{ state: string }>(sql`select state::text as state from feature_flags where key = 'ff_webinar_portal'`);
    test.skip(flagRow?.state !== "on", "ff_webinar_portal is off (Release 2)");
    const [w] = await e2eRows<{ slug: string; session_id: string; route: string | null }>(sql`
      select w.slug, w.session_id,
             (select r.path from pages p join page_routes r on r.page_id = p.id and r.locale = 'en'
              where p.session_id = w.session_id and p.status = 'published' limit 1) as route
      from webinars w
      where w.status = 'published' and w.session_id is not null
      order by w.created_at limit 1`);
    test.skip(!w, "no published webinar with an event session");
    const path = w!.route ?? (await eventPage(w!.session_id, 4));

    await page.goto(`/en/${path}`);
    await expect(page.locator('a[data-action="webinar"]')).toHaveAttribute("href", `/en/webinars/${w!.slug}`);
    await expect(page.locator('a[data-action="tickets"], a[data-action="waitlist"]')).toHaveCount(0);
  });
});
