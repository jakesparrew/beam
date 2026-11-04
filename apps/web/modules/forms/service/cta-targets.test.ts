/** forms-P3: CTA target checks and resolution (rule P7, section 4 CTA targets, edge case 17). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { forms, products, sessionTemplates } from "@beam/db/schema";
import { createTestDb, makeProduct, makeSession } from "@beam/db/testing";
import type { Cta } from "@beam/core/forms";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { assessment, createForm, setupEnv, T } from "../forms-p3.fixtures";
import { checkCtaTargets, refreshCtaWarnings, resolveCtaTarget } from "./cta-targets";

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function template(isActive = true): Promise<string> {
  const [t] = await h.db
    .insert(sessionTemplates)
    .values({ kind: "day", name: T("Day"), weekdays: [1, 2, 3], startTime: "10:00", durationMinutes: 120, capacitySeats: 10, creditKind: "day", activeFromOn: "2026-01-01", isActive })
    .returning();
  return t!.id;
}

const cta = (c: Partial<Cta> & Pick<Cta, "kind">): Cta => ({ key: `c${randomUUID().slice(0, 4)}`, label: T("Go"), ...c });
const FALLBACK = "https://www.example.com/fallback";

describe("resolveCtaTarget", () => {
  it("resolves active targets to the portal and site routes", async () => {
    const tpl = await template();
    const product = await makeProduct(h.db);
    const event = await makeSession(h.db, { kind: "event" });
    expect(await resolveCtaTarget(h.db, cta({ kind: "booking", sessionTemplateId: tpl }), "nl-BE")).toEqual({ url: `https://app.example.com/nl/account/book?template=${tpl}`, fallback: false });
    expect(await resolveCtaTarget(h.db, cta({ kind: "experience", sessionTemplateId: tpl }), "fr-BE")).toEqual({ url: `https://app.example.com/fr/account/book?template=${tpl}`, fallback: false });
    expect(await resolveCtaTarget(h.db, cta({ kind: "product", productId: product.id }), "en")).toEqual({ url: `https://app.example.com/en/account/shop?product=${product.id}`, fallback: false });
    const ev = await resolveCtaTarget(h.db, cta({ kind: "event", sessionId: event.id }), "nl-BE");
    expect(ev.fallback).toBe(false);
    expect(ev.url).toContain(event.id);
    const url = await resolveCtaTarget(h.db, cta({ kind: "url", url: "https://partner.example.com/page?x=1" }), "nl-BE", { formSlug: "recovery-check" });
    expect(new URL(url.url).searchParams.get("utm_campaign")).toBe("recovery-check");
    expect(new URL(url.url).searchParams.get("utm_source")).toBe("beam_form");
  });

  it("an inactive product falls back with fallback = true", async () => {
    const product = await makeProduct(h.db);
    await h.db.update(products).set({ isActive: false }).where(eq(products.id, product.id));
    const r = await resolveCtaTarget(h.db, cta({ kind: "product", productId: product.id }), "nl-BE", { fallbackUrl: FALLBACK, formSlug: "x" });
    expect(r.fallback).toBe(true);
    expect(r.url.startsWith(FALLBACK)).toBe(true);
  });

  it("a past session falls back to the locale home without a url CTA", async () => {
    const past = await makeSession(h.db, { kind: "event", startsAt: new Date(Date.now() - 86_400_000) });
    expect(await resolveCtaTarget(h.db, cta({ kind: "event", sessionId: past.id }), "fr-BE")).toEqual({ url: "https://app.example.com/fr", fallback: true });
  });

  it("a missing or inactive template falls back", async () => {
    expect((await resolveCtaTarget(h.db, cta({ kind: "booking", sessionTemplateId: randomUUID() }), "en")).fallback).toBe(true);
    expect((await resolveCtaTarget(h.db, cta({ kind: "experience", sessionTemplateId: await template(false) }), "en")).fallback).toBe(true);
  });
});

describe("checkCtaTargets and the nightly refresh", () => {
  it("lists every broken CTA with its reason and overwrites forms.cta_warnings", async () => {
    const a = assessment();
    const product = await makeProduct(h.db);
    await h.db.update(products).set({ isActive: false }).where(eq(products.id, product.id));
    const past = await makeSession(h.db, { kind: "event", startsAt: new Date(Date.now() - 86_400_000) });
    a.definition.endings[0]!.ctas = [
      { key: "shop", label: T("Shop"), kind: "product", productId: product.id },
      { key: "event", label: T("Event"), kind: "event", sessionId: past.id },
      { key: "book", label: T("Book"), kind: "booking", sessionTemplateId: randomUUID() },
      { key: "site", label: T("Site"), kind: "url", url: "https://www.example.com" },
    ];
    expect(await checkCtaTargets(h.db, a.definition)).toEqual([
      { endingKey: "result_reset", ctaKey: "shop", reason: "inactive_product" },
      { endingKey: "result_reset", ctaKey: "event", reason: "past_session" },
      { endingKey: "result_reset", ctaKey: "book", reason: "inactive_template" },
    ]);
    const f = await createForm(h.db, a);
    await refreshCtaWarnings(h.db);
    const [row] = await h.db.select().from(forms).where(eq(forms.id, f.formId));
    expect(row!.ctaWarnings).toHaveLength(3);
    await h.db.update(products).set({ isActive: true }).where(eq(products.id, product.id));
    await refreshCtaWarnings(h.db);
    const [after] = await h.db.select().from(forms).where(eq(forms.id, f.formId));
    expect(after!.ctaWarnings.map((w) => w.ctaKey)).toEqual(["event", "book"]);
  });
});
