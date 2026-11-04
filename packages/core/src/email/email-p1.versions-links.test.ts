import { describe, expect, it } from "vitest";
import { base64Url, hashLinkToken, isLinkTokenShape, newLinkToken, parseLinkIndex, sha256Hex } from "./links";
import { assertDraftVersion, draftCopyOf, draftIsCurrent, nextVersionNumber, PublishedVersionError } from "./versions";
import { CreateTemplateInput, ScheduleCampaignInput, SendTestEmailInput, SendTransactionalInputSchema } from "./inputs";
import { fromDomainOf, isValidTemplateSlug } from "./types";

describe("assertDraftVersion (rule 11)", () => {
  it("passes a draft and refuses a published or missing row", () => {
    expect(() => assertDraftVersion({ id: "v1", publishedAt: null })).not.toThrow();
    expect(() => assertDraftVersion({ id: "v1", publishedAt: new Date() })).toThrow(PublishedVersionError);
    expect(() => assertDraftVersion(null)).toThrow(PublishedVersionError);
    try {
      assertDraftVersion({ id: "v9", publishedAt: "2026-11-03T10:00:00Z" });
    } catch (error) {
      expect(error).toMatchObject({ code: "version_published", versionId: "v9", retryable: false });
    }
  });

  it("numbers the next draft max + 1 and copies content without sharing references", () => {
    expect(nextVersionNumber([])).toBe(1);
    expect(nextVersionNumber([1, 3, 2])).toBe(4);
    const current = { subject: { en: "Hi" }, preheader: { en: "Pre" }, document: { schemaVersion: 1, locales: {} }, copy: null, reactComponent: null };
    const draft = draftCopyOf(current, 4);
    expect(draft).toEqual({ ...current, version: 4, publishedAt: null });
    expect(draft.subject).not.toBe(current.subject);
    expect(draftIsCurrent({ updatedAt: new Date("2026-11-03T10:00:00.123Z") }, "2026-11-03T10:00:00.123Z")).toBe(true);
    expect(draftIsCurrent({ updatedAt: new Date("2026-11-03T10:00:00.124Z") }, "2026-11-03T10:00:00.123Z")).toBe(false);
  });
});

/** Reference SHA-256 from WebCrypto. */
async function webSha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("link tokens (rule 53)", () => {
  it("hashes with SHA-256 exactly like WebCrypto", async () => {
    for (const input of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "é ünïcode ✓", "y".repeat(1000)]) {
      const bytes = new TextEncoder().encode(input);
      expect(sha256Hex(bytes)).toBe(await webSha256(bytes));
    }
  });

  it("encodes base64url like Buffer", () => {
    for (const len of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
      expect(base64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("makes 43-character random tokens whose hash is the sha256 hex of the token", async () => {
    const a = newLinkToken();
    const b = newLinkToken();
    expect(a.token).not.toBe(b.token);
    expect(isLinkTokenShape(a.token)).toBe(true);
    expect(a.hash).toBe(await webSha256(new TextEncoder().encode(a.token)));
    expect(hashLinkToken(a.token)).toBe(a.hash);
    expect(isLinkTokenShape("short")).toBe(false);
    expect(isLinkTokenShape(42)).toBe(false);
  });

  it("parses the click index safely", () => {
    expect(parseLinkIndex("0", 3)).toBe(0);
    expect(parseLinkIndex("2", 3)).toBe(2);
    expect(parseLinkIndex("3", 3)).toBeNull();
    expect(parseLinkIndex("-1", 3)).toBeNull();
    expect(parseLinkIndex("1e2", 3)).toBeNull();
    expect(parseLinkIndex(null, 3)).toBeNull();
  });
});

describe("slugs, domains and inputs", () => {
  it("accepts the two slug forms", () => {
    expect(isValidTemplateSlug("transactional", "booking.booking_confirmed")).toBe(true);
    expect(isValidTemplateSlug("transactional", "booking/booking-confirmed")).toBe(false);
    expect(isValidTemplateSlug("marketing", "campaign-20261103-autumn")).toBe(true);
    expect(isValidTemplateSlug("marketing", "booking.booking_confirmed")).toBe(false);
    expect(fromDomainOf("marketing")).toBe("news.beam.be");
    expect(fromDomainOf("transactional")).toBe("mail.beam.be");
  });

  it("parses action inputs", () => {
    expect(CreateTemplateInput.safeParse({ name: "Autumn", kind: "marketing", purpose: "events" }).success).toBe(true);
    expect(CreateTemplateInput.safeParse({ name: "Autumn", kind: "transactional", purpose: "events" }).success).toBe(false);
    const id = "3c4d5e6f-3c4d-4e5f-8a0b-2c3d4e5f6a7b";
    expect(ScheduleCampaignInput.parse({ campaignId: id, expectedVersion: 2, scheduledAt: "now" }).scheduledAt).toBe("now");
    expect(ScheduleCampaignInput.parse({ campaignId: id, expectedVersion: 2, scheduledAt: "2026-12-01T09:00:00Z" }).scheduledAt).toBeInstanceOf(Date);
    const test = { templateId: id, use: "draft", locales: ["en"], to: ["staff@example.com"], as: { sample: "member" } };
    expect(SendTestEmailInput.safeParse(test).success).toBe(true);
    expect(SendTestEmailInput.safeParse({ ...test, to: Array.from({ length: 6 }, (_, i) => `s${i}@example.com`) }).success).toBe(false);
    const send = { template: "platform.magic_link", to: "a@example.com", locale: "en", data: {}, key: "k" };
    expect(SendTransactionalInputSchema.safeParse({ ...send, headers: { "In-Reply-To": "<a@b>" } }).success).toBe(true);
    expect(SendTransactionalInputSchema.safeParse({ ...send, headers: { "X-Other": "1" } }).success).toBe(false);
  });
});
