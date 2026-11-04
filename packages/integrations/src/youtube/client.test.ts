/**
 * YouTube client and fake (webinar-P2, webinar spec section 6): the fake's results pass the same
 * Zod schemas as the real client's, the real client maps Google responses through Zod and maps
 * HTTP failures to retryable or permanent `IntegrationError`s. No network: the client gets an
 * injected `fetch`.
 */
import { describe, expect, it } from "vitest";
import { isPermanentFailure, type IntegrationCallEntry } from "../_shared";
import { createYouTubeClient, mapLifecycle, parseIsoDuration, toVideo } from "./client";
import { createYouTubeFake } from "./fake";
import { BroadcastRefSchema, CreatedBroadcastSchema, MeetSpaceSchema, YouTubeBroadcastSchema, YouTubeVideoSchema, broadcastMarker } from "./types";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers the token endpoint and routes every other request to `handler`. */
function fakeFetch(handler: Handler) {
  const seen: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.push({ method, url, body: typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "ya29.test-access", expires_in: 3600 });
    return handler(url, init ?? {});
  };
  return { fetchImpl, seen };
}

function client(handler: Handler, onCall?: (e: IntegrationCallEntry) => void) {
  const { fetchImpl, seen } = fakeFetch(handler);
  const c = createYouTubeClient({ clientId: "cid", clientSecret: "secret", refreshToken: "refresh", fetch: fetchImpl, ...(onCall ? { onCall } : {}) });
  return { c, seen };
}

const BROADCAST = {
  id: "abcdefghijk",
  snippet: { title: "Sleep better", description: `Hello\n\n${broadcastMarker("w1")}`, scheduledStartTime: "2027-01-10T18:00:00Z" },
  status: { lifeCycleStatus: "ready" },
  contentDetails: { boundStreamId: "stream-1" },
};

describe("youtube fake results pass the client's Zod schemas", () => {
  it("broadcast, ref, video and Meet space shapes", async () => {
    const fake = createYouTubeFake();
    const created = await fake.createBroadcast({ title: "Webinar", description: broadcastMarker("w1"), scheduledStartAt: new Date("2027-01-10T18:00:00Z") });
    expect(CreatedBroadcastSchema.safeParse(created).success).toBe(true);
    expect(created.broadcastId).toHaveLength(11);
    expect(BroadcastRefSchema.safeParse(await fake.findBroadcastByMarker(broadcastMarker("w1"))).success).toBe(true);
    expect(YouTubeBroadcastSchema.safeParse(await fake.getBroadcast(created.broadcastId)).success).toBe(true);
    fake.setLifecycle(created.broadcastId, "testing");
    const done = fake.setLifecycle(created.broadcastId, "complete", new Date("2027-01-10T19:00:00Z"));
    expect(YouTubeBroadcastSchema.safeParse(done).success).toBe(true);
    expect(YouTubeVideoSchema.safeParse(await fake.getVideo(done.recordingVideoId!)).success).toBe(true);
    fake.markProcessed(done.recordingVideoId!, 3540);
    expect(await fake.getVideo(done.recordingVideoId!)).toMatchObject({ processed: true, durationSec: 3540 });
    expect(MeetSpaceSchema.safeParse(await fake.createMeetSpace()).success).toBe(true);
  });

  it("failNext queues failures per operation and loseNextResponse does the work but fails", async () => {
    const fake = createYouTubeFake();
    fake.failNext("createBroadcast", { status: 403 });
    fake.failNext("createBroadcast", { status: 503 });
    const input = { title: "x", description: broadcastMarker("w2"), scheduledStartAt: new Date() };
    await expect(fake.createBroadcast(input)).rejects.toMatchObject({ retryable: false, statusCode: 403 });
    await expect(fake.createBroadcast(input)).rejects.toMatchObject({ retryable: true, statusCode: 503 });
    fake.loseNextResponse("createBroadcast");
    await expect(fake.createBroadcast(input)).rejects.toMatchObject({ retryable: true });
    expect(fake.broadcasts()).toHaveLength(1);
    expect(await fake.findBroadcastByMarker(broadcastMarker("w2"))).not.toBeNull();
  });
});

describe("youtube client", () => {
  it("creates an unlisted, auto-starting, recorded broadcast, a stream and binds them", async () => {
    const calls: IntegrationCallEntry[] = [];
    const { c, seen } = client((url, init) => {
      if (url.includes("/liveBroadcasts/bind")) return json({ id: BROADCAST.id });
      if (url.includes("/liveBroadcasts") && init.method === "POST") return json({ ...BROADCAST, status: { lifeCycleStatus: "created" } });
      if (url.includes("/liveStreams")) return json({ id: "stream-1", cdn: { ingestionInfo: { ingestionAddress: "rtmp://a.rtmp.youtube.com/live2" } } });
      return json({}, 500);
    }, (e) => calls.push(e));
    const out = await c.createBroadcast({ title: "Sleep better", description: broadcastMarker("w1"), scheduledStartAt: new Date("2027-01-10T18:00:00Z") });
    expect(out).toEqual({ broadcastId: BROADCAST.id, streamId: "stream-1", ingestionUrl: "rtmp://a.rtmp.youtube.com/live2" });
    const insert = seen.find((s) => s.url.includes("/liveBroadcasts?part=") && s.method === "POST")!;
    expect(insert.body).toMatchObject({
      status: { privacyStatus: "unlisted" },
      contentDetails: { enableAutoStart: true, enableAutoStop: true, recordFromStart: true, enableDvr: false, latencyPreference: "low", enableEmbed: true },
    });
    expect(calls).toEqual([expect.objectContaining({ provider: "youtube", operation: "broadcasts.create", ok: true, error: null })]);
    expect(JSON.stringify(calls)).not.toContain("ya29");
  });

  it("finds a broadcast by its description marker and maps lifecycle and times", async () => {
    const { c } = client((url) => {
      if (url.includes("broadcastStatus=upcoming")) return json({ items: [{ ...BROADCAST, id: "zzzzzzzzzzz", snippet: { title: "other", description: "nothing" } }, BROADCAST] });
      if (url.includes(`id=${BROADCAST.id}`)) {
        return json({ items: [{ ...BROADCAST, snippet: { ...BROADCAST.snippet, actualStartTime: "2027-01-10T18:02:00Z", actualEndTime: "2027-01-10T19:01:00Z" }, status: { lifeCycleStatus: "complete" } }] });
      }
      return json({ items: [] });
    });
    expect(await c.findBroadcastByMarker(broadcastMarker("w1"))).toEqual({ broadcastId: BROADCAST.id, streamId: "stream-1" });
    expect(await c.findBroadcastByMarker(broadcastMarker("nope"))).toBeNull();
    const b = await c.getBroadcast(BROADCAST.id);
    expect(b).toMatchObject({ lifecycle: "complete", recordingVideoId: BROADCAST.id, actualStartAt: new Date("2027-01-10T18:02:00Z"), actualEndAt: new Date("2027-01-10T19:01:00Z") });
    expect(YouTubeBroadcastSchema.safeParse(b).success).toBe(true);
  });

  it("reads a video's duration and processing state", async () => {
    const { c } = client((url) =>
      url.includes("id=abcdefghijk")
        ? json({ items: [{ id: "abcdefghijk", contentDetails: { duration: "PT1H2M3S" }, processingDetails: { processingStatus: "succeeded" }, status: { privacyStatus: "unlisted" } }] })
        : json({ items: [] }),
    );
    expect(await c.getVideo("abcdefghijk")).toEqual({ videoId: "abcdefghijk", processed: true, durationSec: 3723, privacyStatus: "unlisted" });
    expect(await c.getVideo("unknownvide")).toBeNull();
    expect(toVideo({ id: "abcdefghijk", contentDetails: { duration: "P0D" }, processingDetails: { processingStatus: "processing" } })).toMatchObject({ processed: false, durationSec: null });
    expect(parseIsoDuration("PT45M")).toBe(2700);
    expect(parseIsoDuration("P1DT1S")).toBe(86_401);
    expect(parseIsoDuration("garbage")).toBeNull();
    expect(mapLifecycle("liveStarting")).toBe("live");
    expect(mapLifecycle("testStarting")).toBe("testing");
  });

  it("creates a trusted Meet space", async () => {
    const { c, seen } = client(() => json({ name: "spaces/abc-123", meetingUri: "https://meet.google.com/abc-defg-hij" }));
    expect(await c.createMeetSpace()).toEqual({ spaceName: "spaces/abc-123", meetingUri: "https://meet.google.com/abc-defg-hij" });
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "https://meet.googleapis.com/v2/spaces", body: { config: { accessType: "TRUSTED" } } });
  });

  it("an update is a full PUT of the merged values", async () => {
    const { c, seen } = client((url, init) => (init.method === "PUT" ? json(BROADCAST) : json({ items: [BROADCAST] })));
    await c.updateBroadcast(BROADCAST.id, { scheduledStartAt: new Date("2027-01-11T18:00:00Z") });
    expect(seen.at(-1)).toMatchObject({
      method: "PUT",
      body: { id: BROADCAST.id, snippet: { title: "Sleep better", description: BROADCAST.snippet.description, scheduledStartTime: "2027-01-11T18:00:00.000Z" } },
    });
  });

  describe("error mapping", () => {
    it.each([
      [400, false],
      [403, false],
      [404, false],
      [408, true],
      [429, true],
      [500, true],
      [503, true],
    ])("HTTP %i on insert -> retryable %s", async (status, retryable) => {
      const calls: IntegrationCallEntry[] = [];
      const { c } = client(() => json({ error: { message: "quotaExceeded for owner@example.com" } }, status), (e) => calls.push(e));
      const failure = await c.createBroadcast({ title: "x", description: "", scheduledStartAt: new Date() }).catch((e: unknown) => e);
      expect(failure).toMatchObject({ provider: "youtube", operation: "broadcasts.create", statusCode: status, retryable });
      expect(isPermanentFailure(failure)).toBe(!retryable);
      expect(calls[0]).toMatchObject({ ok: false, statusCode: status });
      expect(calls[0]!.error).not.toContain("owner@example.com");
    });

    it("a 404 on delete counts as done; a 404 on update is permanent", async () => {
      const { c } = client(() => json({ error: { code: 404 } }, 404));
      await expect(c.deleteBroadcast(BROADCAST.id)).resolves.toBeUndefined();
      await expect(c.updateBroadcast(BROADCAST.id, { title: "x" })).rejects.toMatchObject({ statusCode: 404, retryable: false });
      await expect(c.getBroadcast(BROADCAST.id)).rejects.toMatchObject({ statusCode: 404, retryable: false });
    });

    it("a missing broadcast in a 200 list is a permanent 404", async () => {
      const { c } = client(() => json({ items: [] }));
      await expect(c.getBroadcast(BROADCAST.id)).rejects.toMatchObject({ statusCode: 404, retryable: false });
    });

    it("a response that fails Zod is a permanent invalid_response", async () => {
      const { c } = client(() => json({ id: 42 }));
      await expect(c.createMeetSpace()).rejects.toMatchObject({ code: "invalid_response", retryable: false });
      const { c: c2 } = client(() => json({ items: [{ id: "short", snippet: {} }] }));
      await expect(c2.getBroadcast("short")).rejects.toThrow();
    });

    it("a refused refresh token is permanent and a network failure retries", async () => {
      const refused = createYouTubeClient({
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        fetch: () => Promise.resolve(json({ error: "invalid_grant" }, 400)),
      });
      await expect(refused.getVideo("abcdefghijk")).rejects.toMatchObject({ retryable: false, statusCode: 400 });
      const offline = createYouTubeClient({ clientId: "c", clientSecret: "s", refreshToken: "r", fetch: () => Promise.reject(new Error("ECONNRESET")) });
      await expect(offline.getVideo("abcdefghijk")).rejects.toMatchObject({ retryable: true, code: "network" });
    });
  });

  it("caches the access token across calls", async () => {
    const { fetchImpl, seen } = fakeFetch(() => json({ items: [] }));
    const c = createYouTubeClient({ clientId: "c", clientSecret: "s", refreshToken: "r", fetch: fetchImpl });
    await c.getVideo("abcdefghijk");
    await c.getVideo("abcdefghijk");
    expect(seen.filter((s) => s.url.startsWith("https://oauth2.googleapis.com/token"))).toHaveLength(1);
  });
});
