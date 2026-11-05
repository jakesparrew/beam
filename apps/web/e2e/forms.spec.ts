/**
 * forms-P4 against beam_dev (forms spec section 12, acceptance rows of section 12):
 * - the demo `recovery-check` in `fr-BE`, branching to a conditional ending, result page with
 *   score and CTA ("a weighted, branched assessment works"); the person exists with
 *   `acquisition.source = 'paid_meta'` and the submission's funnel for
 *   `?utm_source=facebook&utm_medium=paid_social`; no newsletter consent ("a result does not
 *   create newsletter consent");
 * - a second run with an existing customer's email fills their empty phone ("an existing customer
 *   record is updated"), on a temporary `nl-BE`-only lead form this spec creates and removes;
 * - the unavailable-locale page for that `nl-BE`-only form;
 * - the whole `contact` form with the keyboard only, the error summary receiving focus on an
 *   empty submit.
 * Waits on the route responses (`waitForResponse`), never on a bare `role=alert`.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { deriveVersionColumns, recoveryCheckSeed, seedDefinitions, type FormDefinition } from "@beam/core/forms";
import { formSubmissions, forms, formVersions, persons } from "@beam/db/schema";
import { eq, sql } from "drizzle-orm";
import { closeE2eDb, e2eDb, e2eRows } from "./support/db";

const RUN = randomUUID().slice(0, 8);
const demo = recoveryCheckSeed({ baseUrl: "https://www.example.com" }).definition;
const FR = "fr-BE" as const;
const lbl = (def: FormDefinition, key: string, locale: "fr-BE" | "nl-BE" | "en" = FR) => def.fields[key]!.label[locale]!;
const optLabel = (def: FormDefinition, key: string, option: string) => {
  const f = def.fields[key] as { options?: { key: string; label: Record<string, string> }[] };
  return f.options!.find((o) => o.key === option)!.label[FR]!;
};

const NL_ONLY_SLUG = `e2e-nl-only-${RUN}`;
let nlOnlyFormId: string | null = null;
let customerId: string | null = null;
const customerEmail = `e2e-forms-${RUN}@demo.beam.be`;

function nlOnlyDefinition(): FormDefinition {
  const c = JSON.parse(JSON.stringify(seedDefinitions().contact.definition)) as FormDefinition;
  const t = (nl: string) => ({ "nl-BE": nl });
  c.fields.phone = { key: "phone", type: "phone", label: t("Telefoon") as never, required: false, sensitive: false, mapsTo: "person.phone" };
  c.fields.message = { ...c.fields.message!, required: false };
  c.sections[0]!.fieldKeys = ["email", "first_name", "phone", "message"];
  delete c.fields.newsletter;
  return c;
}

test.beforeAll(async () => {
  const db = await e2eDb();
  const definition = nlOnlyDefinition();
  const scoring = { dimensions: [], outcomes: [] };
  const [f] = await db.insert(forms).values({ slug: NL_ONLY_SLUG, kind: "lead", name: { "nl-BE": "E2E", "fr-BE": "E2E", en: "E2E" } }).returning({ id: forms.id });
  nlOnlyFormId = f!.id;
  const cols = deriveVersionColumns(definition, scoring as never);
  const [v] = await db
    .insert(formVersions)
    .values({ formId: f!.id, version: 1, definition, scoring, locales: ["nl-BE"], ...cols, publishedAt: new Date() })
    .returning({ id: formVersions.id });
  await db.update(forms).set({ status: "published", currentVersionId: v!.id }).where(eq(forms.id, f!.id));
  const [p] = await db.insert(persons).values({ email: customerEmail, firstName: "Bram", locale: "nl-BE" }).returning({ id: persons.id });
  customerId = p!.id;
});

test.afterAll(async () => {
  const db = await e2eDb();
  await db.execute(sql`set local beam.allow_rewrite = 'on'`).catch(() => undefined);
  if (nlOnlyFormId) {
    await db.delete(formSubmissions).where(eq(formSubmissions.formId, nlOnlyFormId));
    await db.update(forms).set({ status: "draft", currentVersionId: null }).where(eq(forms.id, nlOnlyFormId)).catch(() => undefined);
    await db.delete(formVersions).where(eq(formVersions.formId, nlOnlyFormId)).catch(() => undefined);
    await db.delete(forms).where(eq(forms.id, nlOnlyFormId)).catch(() => undefined);
  }
  await closeE2eDb();
});

const routeDone = (page: Page, route: "save" | "submit") => page.waitForResponse((r) => r.url().includes(`/api/public/forms/`) && r.url().endsWith(`/${route}`) && r.request().method() === "POST");

async function choose(page: Page, fieldLabel: string, optionLabel: string) {
  await page.getByRole("group", { name: new RegExp(fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).getByLabel(optionLabel, { exact: true }).check();
}

test.describe("forms (forms-P4)", () => {
  test("recovery-check in fr-BE: branched assessment, result page with score and CTA, paid_meta lead, no newsletter consent", async ({ page }) => {
    const email = `e2e-recovery-${RUN}@demo.beam.be`;
    await page.goto("/fr/f/recovery-check?utm_source=facebook&utm_medium=paid_social");
    await expect(page.locator("h1")).toHaveText(demo.title[FR]!);

    // The footer's newsletter form has its own e-mail field: the hosted form is the one in `main`.
    const main = page.locator("main");
    await main.getByLabel(lbl(demo, "email")).fill(email);
    await main.getByLabel(lbl(demo, "first_name")).fill("Lotte");
    await main.getByLabel((demo.fields.sensitive_consent as { wording: Record<string, string> }).wording[FR]!).check();
    let saved = routeDone(page, "save");
    await page.getByRole("button", { name: "Suivant" }).click();
    expect((await saved).status()).toBe(200);

    await choose(page, lbl(demo, "sleep_hours"), optLabel(demo, "sleep_hours", "5_6"));
    await choose(page, lbl(demo, "sleep_quality"), "2");
    await choose(page, lbl(demo, "stress_level"), "8");
    // Show/hide: the physical stress question appears only for a stress level of 6 or more.
    await expect(page.getByRole("group", { name: new RegExp(lbl(demo, "stress_physical").slice(0, 20)) })).toBeVisible();
    await choose(page, lbl(demo, "stress_physical"), "Oui");
    saved = routeDone(page, "save");
    await page.getByRole("button", { name: "Suivant" }).click();
    expect((await saved).status()).toBe(200);

    await choose(page, lbl(demo, "movement"), optLabel(demo, "movement", "rarely"));
    await choose(page, lbl(demo, "screen_time"), optLabel(demo, "screen_time", "gt5"));
    const submitted = routeDone(page, "submit");
    await page.getByRole("button", { name: demo.settings.submitLabel[FR]! }).click();
    const res = await submitted;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { resultUrl?: string; endingKey: string };
    expect(body.resultUrl).toContain("/fr/f/recovery-check/r/");

    await page.getByRole("link", { name: "Voir votre résultat" }).click();
    await expect(page.locator("[data-result-score]")).toBeVisible();
    await expect(page.locator("[data-cta]").first()).toBeVisible();
    await expect(page.locator("article")).toHaveAttribute("lang", "fr-BE");

    const [person] = await e2eRows<{ id: string; source: string; funnel: string; sub_funnel: string; sub_source: string }>(sql`
      select p.id, p.acquisition->>'source' as source, p.acquisition->>'funnel' as funnel, s.funnel as sub_funnel, s.source as sub_source
      from persons p join form_submissions s on s.person_id = p.id
      where lower(p.email) = ${email} order by s.completed_at desc limit 1`);
    expect(person).toBeTruthy();
    expect(person!.source).toBe("paid_meta");
    expect(person!.sub_source).toBe("paid_meta");
    expect(person!.funnel).toBe(person!.sub_funnel);
    const newsletter = await e2eRows<{ n: number }>(sql`select count(*)::int as n from consent_records where person_id = ${person!.id} and purpose = 'newsletter'`);
    expect(newsletter[0]!.n).toBe(0);
  });

  test("a second run with an existing customer's email fills their empty phone", async ({ page }) => {
    for (const phone of ["", "+32 470 12 34 56"]) {
      await page.goto(`/nl/f/${NL_ONLY_SLUG}`);
      const main = page.locator("main");
      await main.getByLabel(lbl(nlOnlyDefinition(), "email", "nl-BE")).fill(customerEmail);
      await main.getByLabel(lbl(nlOnlyDefinition(), "first_name", "nl-BE")).fill("Bram");
      if (phone) await main.getByLabel("Telefoon").fill(phone);
      // R3: a real visitor needs more than 3 seconds.
      await page.waitForTimeout(3500);
      const submitted = routeDone(page, "submit");
      await page.getByRole("button", { name: nlOnlyDefinition().settings.submitLabel["nl-BE"]! }).click();
      expect((await submitted).status()).toBe(200);
    }
    const db = await e2eDb();
    const [p] = await db.select({ phone: persons.phone }).from(persons).where(eq(persons.id, customerId!));
    expect(p?.phone).toBe("+32470123456");
  });

  test("a nl-BE-only form shows the unavailable-locale page in fr-BE with a link to nl", async ({ page }) => {
    await page.goto(`/fr/f/${NL_ONLY_SLUG}`);
    const unavailable = page.locator("[data-form-state='unavailable-locale']");
    await expect(unavailable).toBeVisible();
    // The header's locale switch also has a link named "Nederlands" (to /nl).
    await expect(unavailable.getByRole("link", { name: "Nederlands" })).toHaveAttribute("href", `/nl/f/${NL_ONLY_SLUG}`);
    await expect(page.locator("main [data-beam-form-root]")).toHaveCount(0);
  });

  test("the contact form works with the keyboard only; an empty submit focuses the error summary", async ({ page }) => {
    const contact = seedDefinitions().contact.definition;
    await page.goto("/en/f/contact");
    const emailInput = page.locator("main form input[type=email]").first();
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      if (await emailInput.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(emailInput).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-error-summary]")).toBeFocused();

    // Tab from the summary through its links back to the first field.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      if (await emailInput.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(emailInput).toBeFocused();
    await page.keyboard.type(`e2e-contact-${RUN}@demo.beam.be`);
    await page.keyboard.press("Tab");
    await page.keyboard.type("Lotte");
    await page.keyboard.press("Tab");
    await page.keyboard.type("A question from the keyboard.");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space"); // the optional newsletter box, ticked and untouched by the result
    await page.keyboard.press("Space");
    await page.waitForTimeout(3500);
    await page.keyboard.press("Tab");
    const submitted = routeDone(page, "submit");
    await page.keyboard.press("Enter");
    expect((await submitted).status()).toBe(200);
    await expect(page.getByText(contact.endings[0]!.title.en!)).toBeVisible();
  });
});
