/**
 * webinar-P4 privacy (spec section 9.1): the subject export carries the raw watch segments as CSV
 * next to the merged watch per mode, one line per segment in the JSON order, with quoted cells
 * where a title holds a comma.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { createTestDb, makeUser } from "@beam/db/testing";
import { setAppDb } from "@/lib/ctx";
import { privacy, segmentsCsv } from "./privacy";
import { makeRegistration, makeSegments, makeWebinar } from "./test/factories";

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
}, 120_000);
afterAll(async () => {
  setAppDb(undefined);
  await h.close();
});

describe("segments CSV (section 9.1)", () => {
  it("quotes cells with commas and quotes; header first, CRLF lines", () => {
    expect(segmentsCsv([{ webinar_title: 'Slaap, "beter"', mode: "live", from_sec: 0, to_sec: 15, recorded_at: null }])).toBe(
      'webinar_title,mode,from_sec,to_sec,recorded_at\r\n"Slaap, ""beter""",live,0,15,\r\n',
    );
  });

  it("the export holds one CSV line per segment, matching the JSON rows", async () => {
    const owner = await makeUser(h.db);
    const w = await makeWebinar(h.db, { ownerUserId: owner.id, title: { "nl-BE": "Beter slapen, deel 2", "fr-BE": "Mieux dormir", en: "Sleep better" } }, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, r, "live", [[0, 15], [15, 30]], { recordedAt: new Date("2026-06-01T19:00:00Z"), stepMs: 15_000 });
    await makeSegments(h.db, r, "replay", [[100, 115]], { recordedAt: new Date("2026-06-02T19:00:00Z") });
    const out = await privacy.export(h.db as unknown as Tx, r.personId);
    const csv = out["webinar/watch_segments.csv"] as string;
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("webinar_title,mode,from_sec,to_sec,recorded_at");
    expect(lines.slice(1)).toEqual([
      '"Beter slapen, deel 2",live,0,15,2026-06-01T19:00:00.000Z',
      '"Beter slapen, deel 2",live,15,30,2026-06-01T19:00:15.000Z',
      '"Beter slapen, deel 2",replay,100,115,2026-06-02T19:00:00.000Z',
    ]);
    expect(out["webinar/watch_segments.json"]).toHaveLength(3);
  });
});
