/**
 * fix-w22-webinar-wiring (forms-P8 request): the webinar row factories are published under
 * `@beam/db/testing/webinar-factories`, so other modules' tests build webinar rows without raw
 * inserts. The webinar module's own `test/factories.ts` re-exports the same functions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@beam/db";
import { sessions, webinarRegistrations } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import {
  FAKE_VIDEO_ID,
  heartbeatSpans,
  makeCta,
  makePoll,
  makeRegistration,
  makeSegments,
  makeWatchSegments,
  makeWebinar,
  makeWebinarRegistration,
} from "@beam/db/testing/webinar-factories";
import { hashAccessToken } from "@beam/core/webinar";
import * as local from "./test/factories";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
}, 120_000);
afterAll(async () => {
  await h.close();
});

describe("@beam/db/testing/webinar-factories", () => {
  it("is what the webinar module's test factories re-export", () => {
    expect(local.makeWebinar).toBe(makeWebinar);
    expect(local.makeRegistration).toBe(makeRegistration);
    expect(makeWebinarRegistration).toBe(makeRegistration);
    expect(makeWatchSegments).toBe(makeSegments);
  });

  it("creates a draft live webinar and a published one with its event session and broadcast id", async () => {
    const draft = await makeWebinar(h.db);
    expect(draft.status).toBe("draft");
    expect(draft.mode).toBe("live");
    expect(draft.startsAt).toBeInstanceOf(Date);

    const live = await makeWebinar(h.db, {}, { published: true });
    expect(live.status).toBe("published");
    expect(live.youtubeVideoId).toBe(FAKE_VIDEO_ID);
    const [s] = await h.db.select().from(sessions).where(eq(sessions.id, live.sessionId!));
    expect(s?.kind).toBe("event");

    const onDemand = await makeWebinar(h.db, { mode: "on_demand" }, { published: true });
    expect(onDemand.startsAt).toBeNull();
    expect(onDemand.sessionId).toBeNull();
    expect(onDemand.recordingVideoId).toBe(FAKE_VIDEO_ID);
  });

  it("creates registrations with a working access token, segments, polls and CTAs", async () => {
    const w = await makeWebinar(h.db, {}, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const [stored] = await h.db.select().from(webinarRegistrations).where(eq(webinarRegistrations.id, r.id));
    expect(stored?.accessTokenHash).toBe(hashAccessToken(r.token));
    expect(stored?.status).toBe("registered");

    const blocked = await makeRegistration(h.db, { webinarId: w.id, status: "blocked" });
    expect(blocked.blockedAt).toBeInstanceOf(Date);

    const segs = await makeSegments(h.db, r, "live", heartbeatSpans(0, 60));
    expect(segs).toHaveLength(4);
    expect((await makePoll(h.db, { webinarId: w.id })).options).toHaveLength(2);
    expect((await makeCta(h.db, { webinarId: w.id })).url).toMatch(/^https:\/\//);
  });
});
