/**
 * fix-w23-leftovers (booking-P5 requests): terms accepted at a waitlist join are recorded against
 * the entry (`refType: 'waitlist_entry'`, R62), and the public claim actions count against the
 * `claim:ip:<ip>` bucket (booking spec 4.2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { rateLimits, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.77" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/crm/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPersonStatus: vi.fn() }));
// site's contract: the current terms version, whether the person accepted it, and the recorder.
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn(),
  hasAcceptedCurrentTerms: vi.fn(),
  recordTermsAcceptance: vi.fn(),
}));

const actions = await import("./actions/waitlist");
const { createCtx, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { getMembershipForPerson } = await import("@/modules/credits/api");
const { getPersonStatus } = await import("@/modules/crm/api");
const { getCurrentLegalVersion, hasAcceptedCurrentTerms, recordTermsAcceptance } = await import("@/modules/site/api");
const { setBookingRules } = await import("./server/booking-p3a.fixtures");
const { fullSession } = await import("./server/booking-p5.fixtures");
const { joinWaitlistRow } = await import("./server/claim");

let h: DbHandle;
const VERSION_ID = "00000000-0000-4000-8000-00000000f123";

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await setBookingRules(h.db);
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue({ isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null });
  vi.mocked(getPersonStatus).mockReset().mockResolvedValue({ status: "customer", derivedStatus: "customer", override: null, hasActiveMembership: false } as never);
  vi.mocked(getCurrentLegalVersion).mockReset().mockResolvedValue({ versionId: VERSION_ID } as never);
  vi.mocked(hasAcceptedCurrentTerms).mockReset().mockResolvedValue(false);
  vi.mocked(recordTermsAcceptance).mockReset().mockResolvedValue(undefined as never);
});

const join = (sessionId: string, acceptTerms?: boolean) =>
  h.db.transaction(async (tx) => {
    const person = await makePerson(tx);
    const ctx = createCtx({ tx, actor: { kind: "customer", userId: person.id, personId: person.id }, ip: "192.0.2.5", durableMode: "immediate" });
    const r = await joinWaitlistRow(tx, ctx, { sessionId, personId: person.id, by: "customer", ...(acceptTerms !== undefined ? { acceptTerms } : {}) });
    return { ...r, personId: person.id };
  });

describe("R62 terms at a waitlist join", () => {
  it("records the acceptance against the new waitlist entry", async () => {
    const { session } = await fullSession(h.db);
    const r = await join(session.id, true);
    expect(recordTermsAcceptance).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordTermsAcceptance).mock.calls[0]![2]).toMatchObject({
      personId: r.personId,
      versionId: VERSION_ID,
      context: "booking",
      refType: "waitlist_entry",
      refId: r.entryId,
    });
    const [row] = await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, r.entryId));
    expect(row?.personId).toBe(r.personId);
  });

  it("refuses a join without accepting the current terms and writes no entry", async () => {
    const { session } = await fullSession(h.db);
    await expect(join(session.id)).rejects.toThrow(/terms_required/);
    expect(recordTermsAcceptance).not.toHaveBeenCalled();
    expect(await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.sessionId, session.id))).toEqual([]);
  });
});

describe("claim rate limit (booking spec 4.2)", () => {
  it("claimSeat, declineOffer and requestClaimSignIn count against claim:ip:<ip>", async () => {
    const token = "x".repeat(40);
    await actions.claimSeat({ token });
    await actions.declineOffer({ token });
    await actions.requestClaimSignIn({ token });
    const [claim] = await h.db.select().from(rateLimits).where(eq(rateLimits.key, "claim:ip:192.0.2.77"));
    expect(Number(claim?.count)).toBe(3);
    expect(await h.db.select().from(rateLimits).where(eq(rateLimits.key, "api:ip:192.0.2.77"))).toEqual([]);
  });
});
