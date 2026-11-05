/**
 * finance-P6 end to end against `beam_dev` with `PAYMENTS_FAKE=1` and the Billit fake (finance
 * spec section 12): the finance half of the V1 acceptance tests "customer can pay" and
 * "reporting reflects the transaction".
 * - A customer buys the 5-day package with the fake Mollie page; the portal lists the new
 *   `BEAM-<year>-<n>` invoice as paid, the detail shows it and the PDF downloads.
 * - Staff refund half of it on the commerce order screen; the credit note `CN-<year>-<n>` shows
 *   in the portal and on the finance screen with Billit `synced` against the fake. This test
 *   skips itself while commerce's `/admin/orders/[id]` screen does not exist.
 * - The paid order counts in `/admin/finance` "issued today", the admin list finds it, and an
 *   `invoices` CSV export for today contains it (skipped until the exports screen exists).
 * The buyer and the other customer are fresh customers per run, registered by their first magic
 * link (shared demo customers run into the magic-link limit of 5 an hour, PL-68, across runs and
 * parallel servers); the spec only adds its own people, orders and documents, which are legal
 * records and are never deleted.
 */
import { expect, test, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { signInCustomer, signInStaff } from "./support/auth";
import { closeE2eDb, e2eRows } from "./support/db";
import { uniqueEmail } from "./support/ids";

const PACKAGE_SKU = "PKG-5-DAYS";
const BUYER = uniqueEmail("finance-buyer");
const NUMBER_RE = /^BEAM-\d{4}-\d{6}$/;

type Doc = { id: string; number: string; status: string; pdf_status: string; billit_status: string; order_id: string; total_cents: number };

test.afterAll(async () => {
  await closeE2eDb();
});

/** Buys the 5-day package on the fake provider page and returns when the return page says paid. */
async function buyPackage(page: Page): Promise<void> {
  await signInCustomer(page, BUYER, "nl");
  await page.goto(`/nl/account/shop/${PACKAGE_SKU}`);
  await page.getByRole("button", { name: "Nu kopen" }).click();
  await page.waitForURL(/\/nl\/account\/checkout\?checkout=/);
  await page.locator("#accept-terms").check();
  const posted = page.waitForResponse((r) => r.request().method() === "POST");
  await page.getByRole("button", { name: /Betaal|Pay|Payer/ }).click();
  await posted;
  await page.waitForURL(/\/api\/dev\/fake-pay\//);
  await page.getByTestId("fake-pay-paid").click();
  await page.waitForURL(/\/checkout\/return\//);
  await expect(page.locator('[data-return-phase="paid"]')).toBeVisible({ timeout: 35_000 });
}

/** The buyer's newest invoice issued after `since`. */
async function newestInvoice(since: Date): Promise<Doc | null> {
  const [row] = await e2eRows<Doc>(sql`
    select i.id, i.number, i.status, i.pdf_status, i.billit_status, i.order_id, i.total_cents from invoices i
    join persons p on p.id = i.person_id
    where p.email = ${BUYER} and i.kind = 'invoice' and i.issued_at >= ${since.toISOString()}::timestamptz
    order by i.issued_at desc limit 1`);
  return row ?? null;
}

async function documentById(id: string): Promise<Doc | null> {
  const [row] = await e2eRows<Doc>(sql`select id, number, status, pdf_status, billit_status, order_id, total_cents from invoices where id = ${id}::uuid`);
  return row ?? null;
}

async function creditNoteOf(invoiceId: string): Promise<Doc | null> {
  const [row] = await e2eRows<Doc>(sql`
    select id, number, status, pdf_status, billit_status, order_id, total_cents from invoices
    where reverses_invoice_id = ${invoiceId}::uuid order by issued_at desc limit 1`);
  return row ?? null;
}

test.describe.serial("invoices from purchase to report", () => {
  let invoice: Doc;

  test("a fake Mollie purchase shows its paid invoice in the portal and the PDF downloads", async ({ page }) => {
    const since = new Date(Date.now() - 5_000);
    await buyPackage(page);
    await expect.poll(async () => (await newestInvoice(since))?.number ?? "", { timeout: 30_000 }).toMatch(NUMBER_RE);
    invoice = (await newestInvoice(since))!;
    expect(invoice.status).toBe("paid");

    await page.goto("/nl/account/invoices");
    await expect(page.getByRole("heading", { level: 1, name: "Facturen" })).toBeVisible();
    const row = page.getByTestId("portal-invoice-row").filter({ hasText: invoice.number });
    await expect(row).toBeVisible();
    await expect(row.getByText("Betaald")).toBeVisible();
    await expectAccessible(page);

    await row.getByRole("link", { name: `${invoice.number} bekijken` }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Factuur ${invoice.number}` })).toBeVisible();
    await expectAccessible(page);

    await expect.poll(async () => (await documentById(invoice.id))?.pdf_status, { timeout: 60_000 }).toBe("rendered");
    const pdf = await page.request.get(`/nl/account/invoices/${invoice.id}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect(Buffer.from(await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
  });

  test("another customer gets 404 for this invoice and its PDF", async ({ page }) => {
    test.skip(!invoice, "needs the purchase of the first test");
    await signInCustomer(page, uniqueEmail("finance-other"), "nl");
    // The portal pages stream behind `loading.tsx`, so Next.js has sent status 200 before the page
    // calls notFound(): the page answers with the 404 page (noindex) instead of the status. The PDF
    // route handler answers the 404 status itself (finance spec section 4, never 403).
    await page.goto(`/nl/account/invoices/${invoice.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Pagina niet gevonden" })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
    await expect(page.getByText(invoice.number)).toHaveCount(0);
    expect((await page.request.get(`/nl/account/invoices/${invoice.id}/pdf`)).status()).toBe(404);
  });

  test("staff refund half: the credit note appears in the portal and on the finance screen, Billit synced", async ({ page }) => {
    test.skip(!invoice, "needs the purchase of the first test");
    await signInStaff(page, "owner");
    const orderPage = await page.goto(`/admin/orders/${invoice.order_id}`);
    test.skip(orderPage?.status() === 404, "commerce's order refund screen has not shipped yet");
    await page.getByRole("button", { name: /Terugbetal|Refund/ }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("spinbutton").first().fill(String(invoice.total_cents / 200));
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await dialog.getByRole("button", { name: /Terugbetal|Refund|Bevestig|Confirm/ }).last().click();
    await posted;

    await expect.poll(async () => (await creditNoteOf(invoice.id))?.number ?? "", { timeout: 30_000 }).toMatch(/^CN-\d{4}-\d{6}$/);
    const cn = (await creditNoteOf(invoice.id))!;
    expect(cn.total_cents).toBe(-invoice.total_cents / 2);
    await expect.poll(async () => (await creditNoteOf(invoice.id))?.billit_status, { timeout: 90_000 }).toBe("synced");

    await page.goto(`/admin/finance/invoices/${cn.id}`);
    await expect(page.getByText(cn.number).first()).toBeVisible();

    await signInCustomer(page, BUYER, "nl");
    await page.goto("/nl/account/invoices");
    await expect(page.getByTestId("portal-invoice-row").filter({ hasText: cn.number })).toBeVisible();
  });

  test("reporting reflects the transaction: issued today on /admin/finance, the admin list and the invoices CSV", async ({ page }) => {
    test.skip(!invoice, "needs the purchase of the first test");
    // A staff sign-in may wait up to 30 s for a fresh TOTP step, then three screens and an export.
    test.setTimeout(2 * 60_000);
    await signInStaff(page, "finance");
    await page.goto("/admin/finance");
    // The innermost box holding both the tile's label and its count (the label sits in its own div).
    const tile = page
      .locator("section, article, div")
      .filter({ has: page.getByText("Vandaag uitgegeven", { exact: true }) })
      .filter({ hasText: /\d+ facturen/ })
      .last();
    await expect(tile).toBeVisible();
    const [today] = await e2eRows<{ n: number }>(sql`
      select count(*)::int as n from invoices where kind = 'invoice' and issued_on = (now() at time zone 'Europe/Brussels')::date`);
    expect(Number(today!.n)).toBeGreaterThanOrEqual(1);
    // Other specs may issue invoices meanwhile, so the tile is compared loosely with the database.
    const shown = Number(((await tile.innerText()).match(/(\d+) facturen/) ?? [])[1] ?? 0);
    expect(shown).toBeGreaterThanOrEqual(1);

    await page.goto(`/admin/finance/invoices?q=${encodeURIComponent(invoice.number)}`);
    await expect(page.getByRole("link", { name: invoice.number }).first()).toBeVisible();

    const exportsPage = await page.goto("/admin/finance/exports");
    test.skip(exportsPage?.status() === 404, "the exports screen lands with finance-P7");
    const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" });
    // The form's own ids: the kind is labelled "Export", and /Van|From/ or /Tot|To/ match other text.
    await page.locator("#export-kind").selectOption("invoices");
    await page.locator("#export-from").fill(day);
    await page.locator("#export-to").fill(day);
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await page.locator('form:has(#export-kind) button[type="submit"]').click();
    await posted;
    const [exp] = await e2eRows<{ id: string }>(sql`select id from finance_exports where kind = 'invoices' order by created_at desc limit 1`);
    await expect.poll(async () => (await e2eRows<{ status: string }>(sql`select status from finance_exports where id = ${exp!.id}::uuid`))[0]?.status, { timeout: 60_000 }).toBe("done");
    const csv = await page.request.get(`/admin/finance/exports/${exp!.id}`);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain(invoice.number);
  });
});
