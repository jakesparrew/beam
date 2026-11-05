/**
 * site-P8 (R2): the account home's upcoming-webinars card (scoped to the person and the ids merged
 * into it, hidden while `ff_webinar_portal` is off for the person) and the "Shared with me" link.
 */
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { featureFlags, persons } from "@beam/db/schema";
import type * as CreditsApi from "@/modules/credits/api";
import type * as WebinarApi from "@/modules/webinar/api";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn, revalidateTag: () => undefined }));

type Row = Awaited<ReturnType<typeof WebinarApi.listUpcomingRegistrationsForPerson>>[number];
const registrationsByPerson = new Map<string, Row[]>();
const listUpcoming = vi.fn((_db: unknown, personId: string): Promise<Row[]> => Promise.resolve(registrationsByPerson.get(personId) ?? []));
vi.mock("@/modules/webinar/api", () => ({ listUpcomingRegistrationsForPerson: (db: unknown, personId: string) => listUpcoming(db, personId) }));

const sharedWith = vi.fn<typeof CreditsApi.listGrantsSharedWith>();
vi.mock("@/modules/credits/api", async (importOriginal) => {
  const actual = await importOriginal<typeof CreditsApi>();
  return { ...actual, listGrantsSharedWith: (...args: Parameters<typeof actual.listGrantsSharedWith>) => sharedWith(...args) };
});

const { eq, setAppDb } = await import("@/lib/ctx");
const { clearFlagCache } = await import("@/lib/flags");
const { resetRuntime } = await import("@/lib/testing");
const { translator } = await import("@/lib/i18n");
const { getAccountHome } = await import("./portal");
const { AccountHome } = await import("../ui/portal/account-home");

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  registrationsByPerson.clear();
  listUpcoming.mockClear();
  sharedWith.mockReset();
  sharedWith.mockResolvedValue([]);
  await handle.db.delete(featureFlags).where(eq(featureFlags.key, "ff_webinar_portal"));
  clearFlagCache();
});

const DAY = 24 * 60 * 60 * 1000;

async function setFlag(state: "on" | "off" | "testers", personIds: string[] = []) {
  await handle.db
    .insert(featureFlags)
    .values({ key: "ff_webinar_portal", state, personIds })
    .onConflictDoUpdate({ target: featureFlags.key, set: { state, personIds } });
  clearFlagCache();
}

function registration(title: string, startsAt: Date | null): Row {
  const row: Row = {
    registrationId: randomUUID(),
    webinarId: randomUUID(),
    title: { "nl-BE": `${title} (nl)`, "fr-BE": `${title} (fr)`, en: title },
    mode: startsAt ? "live" : "on_demand",
    registeredMode: startsAt ? "live" : "on_demand",
    status: "registered",
    startsAt,
    watchedSec: { live: 0, replay: 0, on_demand: 0 },
    attended: { live: false, replay: false, on_demand: false },
  };
  return row;
}

async function customerWithMergedAway() {
  // Factories make testers by default; these customers are ordinary ones (testers mode lists them by id).
  const person = await makePerson(handle.db, { isTester: false });
  const user = await makeUser(handle.db, { audience: "customer", isTester: false, personId: person.id, email: person.email ?? undefined });
  const mergedAway = await makePerson(handle.db);
  await handle.db.update(persons).set({ mergedIntoPersonId: user.personId! }).where(eq(persons.id, mergedAway.id));
  return { personId: user.personId!, mergedAwayId: mergedAway.id };
}

const html = (home: Awaited<ReturnType<typeof getAccountHome>>) => renderToStaticMarkup(createElement(AccountHome, { locale: "en", tr: translator("en"), home }));

describe("account home webinars card", () => {
  it("lists the person's and the merged-away person's upcoming webinars, soonest first, never another person's", async () => {
    await setFlag("on");
    const { personId, mergedAwayId } = await customerWithMergedAway();
    const stranger = await makePerson(handle.db);
    const later = registration("Sleep better", new Date(Date.now() + 9.5 * DAY));
    const sooner = registration("Breathwork", new Date(Date.now() + 2.5 * DAY));
    registrationsByPerson.set(personId, [later]);
    registrationsByPerson.set(mergedAwayId, [sooner]);
    registrationsByPerson.set(stranger.id, [registration("Not yours", new Date(Date.now() + DAY))]);

    const home = await getAccountHome(personId, "en");
    expect(listUpcoming.mock.calls.map((c) => c[1]).sort()).toEqual([personId, mergedAwayId].sort());
    expect(home.webinars).toEqual({ ok: true, data: [expect.objectContaining({ webinarId: sooner.webinarId }), expect.objectContaining({ webinarId: later.webinarId })] });

    const out = html(home);
    expect(out).toContain('data-home-card="webinars"');
    expect(out).toContain("Breathwork");
    expect(out).toContain("Sleep better");
    expect(out).not.toContain("Not yours");
    expect(out).toContain('href="/en/account/webinars"');
    expect(out.indexOf("Breathwork")).toBeLessThan(out.indexOf("Sleep better"));
  });

  it("is hidden while the flag is off, and shown to a listed tester only in testers mode", async () => {
    const { personId } = await customerWithMergedAway();
    registrationsByPerson.set(personId, [registration("Breathwork", new Date(Date.now() + 3.5 * DAY))]);

    const off = await getAccountHome(personId, "en");
    expect(off.webinars).toBeUndefined();
    expect(listUpcoming).not.toHaveBeenCalled();
    expect(html(off)).not.toContain('data-home-card="webinars"');

    const other = await makePerson(handle.db, { isTester: false });
    await setFlag("testers", [other.id]);
    expect((await getAccountHome(personId, "en")).webinars).toBeUndefined();
    await setFlag("testers", [personId]);
    expect((await getAccountHome(personId, "en")).webinars).toMatchObject({ ok: true });
  });

  it("a failing webinar api makes this card unavailable and leaves the others", async () => {
    await setFlag("on");
    const { personId } = await customerWithMergedAway();
    listUpcoming.mockRejectedValueOnce(new Error("webinar down"));
    const home = await getAccountHome(personId, "en");
    expect(home.webinars).toEqual({ ok: false });
    expect(home.bookings.ok).toBe(true);
    expect(html(home)).toMatch(/data-home-card="webinars"[\s\S]*Temporarily unavailable/);
  });

  it("shows no card without upcoming registrations", async () => {
    await setFlag("on");
    const { personId } = await customerWithMergedAway();
    const home = await getAccountHome(personId, "en");
    expect(home.webinars).toEqual({ ok: true, data: [] });
    expect(html(home)).not.toContain('data-home-card="webinars"');
  });
});

describe("account home Shared with me", () => {
  it("links to the shared packages on credits' packages page while a package is shared with the person", async () => {
    const { personId, mergedAwayId } = await customerWithMergedAway();
    const shared = (grantId: string) => ({ grantId }) as Awaited<ReturnType<typeof CreditsApi.listGrantsSharedWith>>[number];
    const g1 = randomUUID();
    sharedWith.mockImplementation((_db, id) => Promise.resolve(id === personId ? [shared(g1)] : id === mergedAwayId ? [shared(g1), shared(randomUUID())] : []));
    const home = await getAccountHome(personId, "en");
    expect(home.sharedWithMe).toEqual({ ok: true, data: 2 });
    const out = html(home);
    expect(out).toContain('data-quick-action="sharedWithMe"');
    expect(out).toContain('href="/en/account/packages#packages-shared"');
    expect(out).toContain("2 packages are shared with you");
  });

  it("is absent with nothing shared or when credits cannot answer", async () => {
    const { personId } = await customerWithMergedAway();
    expect(html(await getAccountHome(personId, "en"))).not.toContain('data-quick-action="sharedWithMe"');
    sharedWith.mockRejectedValue(new Error("credits down"));
    const home = await getAccountHome(personId, "en");
    expect(home.sharedWithMe).toEqual({ ok: false });
    expect(home.balances.ok).toBe(true);
    expect(html(home)).not.toContain('data-quick-action="sharedWithMe"');
  });
});
