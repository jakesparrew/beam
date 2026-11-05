/**
 * fix-w20-credits-wiring: the credits wiring requests of docs/build/requests.md.
 * - credits-P8: the staff grant screen renders `SharingPanel variant="staff"` (mode and guest limit
 *   form, named shares with full names, stop and add for `credits.adjust`; read-only otherwise;
 *   not shareable for store credit and membership grants).
 * - credits-P8: the admin nav entry for `/admin/credits/sharing-review`.
 * - credits-P8: `errorMessage` names the R2 sharing errors.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@beam/core/i18n";
import type * as I18nLib from "@/lib/i18n";
import type * as CtxLib from "@/lib/ctx";
import type * as CreditsQueries from "@/modules/credits/queries";

const fx = vi.hoisted(() => ({ canAdjust: true, detail: undefined as unknown as object }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth", () => ({
  requireStaff: () => Promise.resolve({ kind: "staff", userId: "00000000-0000-4000-8000-000000000001" }),
  hasPermission: (_actor: unknown, permission: string) => permission !== "credits.adjust" || fx.canAdjust,
  getSession: () => Promise.resolve(null),
}));
vi.mock("@/lib/i18n", async (orig) => ({ ...(await orig<typeof I18nLib>()), adminLocale: () => Promise.resolve("en") }));
vi.mock("@/lib/ctx", async (orig) => ({ ...(await orig<typeof CtxLib>()), getAppDb: () => Promise.resolve({}) }));
vi.mock("@/modules/credits/queries", async (orig) => ({
  ...(await orig<typeof CreditsQueries>()),
  getGrant: () => Promise.resolve(fx.detail),
}));
vi.mock("@/modules/credits/actions", () => {
  const ok = () => Promise.resolve({ ok: true, data: null });
  return new Proxy({}, { get: (_t, name) => (name === "then" ? undefined : ok) });
});

const { default: GrantPage } = await import("../../app/(admin)/admin/credits/grants/[grantId]/page");
const { errorMessage } = await import("./ui/adjust-dialog");
const { nav } = await import("./nav");

const GRANT_ID = "00000000-0000-4000-8000-0000000000aa";

function makeDetail(over: { creditKind?: string; source?: string; status?: string; mode?: "none" | "guests" | "named" } = {}) {
  return {
    grant: {
      id: GRANT_ID,
      personId: "00000000-0000-4000-8000-0000000000bb",
      creditKind: over.creditKind ?? "day",
      source: over.source ?? "purchase",
      status: over.status ?? "active",
      label: { en: "Ten days", "nl-BE": "Tien dagen", "fr-BE": "Dix jours" },
      startsAt: new Date("2026-10-01T08:00:00Z"),
      expiresAt: new Date("2027-10-01T08:00:00Z"),
      vatTreatment: "single_purpose",
      vatRatePct: "21",
      unitValueCents: 4500,
      sharing: { mode: over.mode ?? "named", max_guest_uses_per_month: 2, allowed_person_ids: [] },
      note: null,
    },
    personName: "Owner Example",
    productName: null,
    balance: { remainingUnits: 7, baseUnits: 10, usedUnits: 3, guestUnits: 0, expiredUnits: 0, adjustedUnits: 0, isUsable: true },
    entries: [],
    guests: [],
    guestUsesThisMonth: 0,
    shares: [
      { shareId: "00000000-0000-4000-8000-0000000000c1", personId: "00000000-0000-4000-8000-0000000000d1", name: "Sharon Fullname", maxUnits: 3, status: "active", createdAt: new Date("2026-10-05T09:00:00Z") },
      { shareId: "00000000-0000-4000-8000-0000000000c2", personId: "00000000-0000-4000-8000-0000000000d2", name: "Rita Revoked", maxUnits: null, status: "revoked", createdAt: new Date("2026-10-06T09:00:00Z") },
    ],
    voucherLast4: null,
  };
}

async function render(): Promise<string> {
  return renderToStaticMarkup(await GrantPage({ params: Promise.resolve({ grantId: GRANT_ID }) }));
}

const en = (key: string, params?: Record<string, string | number>) => t("en", key, params);
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("staff grant screen: SharingPanel variant=staff (credits-P8 request)", () => {
  beforeEach(() => {
    fx.canAdjust = true;
    fx.detail = makeDetail();
  });

  it("shows the sharing settings, the named shares with full names and the add form for credits.adjust", async () => {
    const html = decode(await render());
    expect(html).toContain(en("credits.admin.sharing.title"));
    expect(html).toContain(en("credits.admin.sharing.mode"));
    expect(html).toContain('name="maxGuestUsesPerMonth"');
    expect(html).toContain(en("credits.admin.sharing.save"));
    expect(html).toContain("Sharon Fullname");
    expect(html).toContain("Rita Revoked");
    expect(html).toContain(en("credits.admin.grant.share_max", { count: 3 }));
    expect(html).toContain(en("credits.admin.sharing.unlimited"));
    expect(html).toContain(en("credits.admin.sharing.status_revoked"));
    expect(html).toContain(en("credits.admin.sharing.revoke"));
    expect(html).toContain(en("credits.admin.sharing.add_title"));
  });

  it("is read-only without credits.adjust", async () => {
    fx.canAdjust = false;
    const html = decode(await render());
    expect(html).toContain(en("credits.admin.sharing.title"));
    expect(html).toContain("Sharon Fullname");
    expect(html).not.toContain(en("credits.admin.sharing.save"));
    expect(html).not.toContain(en("credits.admin.sharing.add_title"));
    expect(html).not.toContain(en("credits.admin.sharing.revoke"));
  });

  it("offers no add form on a grant that is no longer active", async () => {
    fx.detail = makeDetail({ status: "expired" });
    const html = decode(await render());
    expect(html).toContain(en("credits.admin.sharing.title"));
    expect(html).not.toContain(en("credits.admin.sharing.add_title"));
  });

  it.each([
    ["store credit", { creditKind: "euro", source: "voucher", mode: "none" as const }],
    ["a membership inclusion", { source: "membership", mode: "none" as const }],
  ])("says %s cannot be shared and offers neither save nor add", async (_label, over) => {
    fx.detail = { ...makeDetail(over), shares: [] };
    const html = decode(await render());
    expect(html).toContain(en("credits.admin.sharing.not_shareable"));
    expect(html).not.toContain(en("credits.admin.sharing.save"));
    expect(html).not.toContain(en("credits.admin.sharing.add_title"));
  });
});

describe("credits nav (credits-P8 request)", () => {
  it("has the admin entry for the sharing review behind credits.read", () => {
    const entry = (nav as readonly { href: string; area: string; labelKey: string; permission?: string }[]).find((n) => n.href === "/admin/credits/sharing-review");
    expect(entry).toMatchObject({ area: "admin", labelKey: "credits.nav.sharing_review", permission: "credits.read" });
  });
});

describe("errorMessage names the R2 sharing errors (credits-P8 request)", () => {
  const labels: Record<string, string> = Object.fromEntries(
    ["already_shared", "share_with_owner", "grant_not_active", "review_item_not_found", "conflict", "not_found", "generic"].map((k) => [`errors.${k}`, `text:${k}`]),
  );
  it.each([
    ["already_shared", "conflict"],
    ["share_with_owner", "validation"],
    ["grant_not_active", "conflict"],
    ["review_item_not_found", "not_found"],
  ])("%s", (message, code) => {
    expect(errorMessage({ code, message }, labels)).toBe(`text:${message}`);
  });
  it("still falls back to the code's words", () => {
    expect(errorMessage({ code: "conflict", message: "something_else" }, labels)).toBe("text:conflict");
  });
});
