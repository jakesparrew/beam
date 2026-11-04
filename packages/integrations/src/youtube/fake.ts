/**
 * The YouTube and Meet fake (runbook section 1.5, webinar spec section 6). Broadcast ids are
 * `fake_` plus six url-safe characters, so they pass the 11-character id checks of `webinars`;
 * lifecycle `created -> ready -> testing -> live -> complete`, and a broadcast's id becomes its
 * recording's video id on `complete` (still processing until `markProcessed`). Wave 0 shipped
 * the first version; webinar-P2 moved the types to `types.ts`, validates every result with the
 * same Zod schemas as the real client and added `addVideo`, `loseNextResponse` and `broadcasts`.
 */
import { randomBytes } from "node:crypto";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type FakeCall, type OnCall } from "../_shared/types";
import {
  BroadcastRefSchema,
  CreatedBroadcastSchema,
  MeetSpaceSchema,
  YOUTUBE_OPERATION_NAMES,
  YouTubeBroadcastSchema,
  YouTubeVideoSchema,
  type BroadcastLifecycle,
  type FakeYouTube,
  type YouTubeBroadcast,
  type YouTubeOperation,
  type YouTubeVideo,
} from "./types";

export type { BroadcastLifecycle, FakeYouTube, YouTubeBroadcast, YouTubeClient, YouTubeFake, YouTubeOperation, YouTubeVideo } from "./types";

const ORDER: BroadcastLifecycle[] = ["created", "ready", "testing", "live", "complete"];

type StoredBroadcast = YouTubeBroadcast & { ingestionUrl: string };

/** `fake_` + 6 url-safe characters: an 11-character YouTube-shaped id. */
function fakeId(): string {
  return `fake_${randomBytes(6).toString("base64url").slice(0, 6)}`;
}

const notFound = (operation: YouTubeOperation, what: string) =>
  new IntegrationError({ provider: "youtube", operation: YOUTUBE_OPERATION_NAMES[operation], retryable: false, statusCode: 404, message: `youtube ${what} not found` });

export function createYouTubeFake(options: { onCall?: OnCall; now?: () => Date } = {}): FakeYouTube {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const calls: FakeCall[] = [];
  const broadcasts = new Map<string, StoredBroadcast>();
  const videos = new Map<string, YouTubeVideo>();
  const failures: { operation: YouTubeOperation; status: number }[] = [];
  const lostResponses: YouTubeOperation[] = [];

  function run<T>(operation: YouTubeOperation, input: unknown, work: () => T): Promise<T> {
    calls.push({ operation, input, at: now() });
    const name = YOUTUBE_OPERATION_NAMES[operation];
    return trackCall(onCall, { provider: "youtube", operation: name, requestDigest: digestRequest({ method: "POST", path: `/youtube/${operation}` }) }, () => {
      const i = failures.findIndex((f) => f.operation === operation);
      if (i >= 0) {
        const [f] = failures.splice(i, 1);
        throw errorFromStatus("youtube", name, f!.status);
      }
      const value = work();
      const lost = lostResponses.indexOf(operation);
      if (lost >= 0) {
        lostResponses.splice(lost, 1);
        throw errorFromStatus("youtube", name, 503, "response lost");
      }
      return { value, statusCode: 200 };
    });
  }

  const get = (operation: YouTubeOperation, id: string): StoredBroadcast => {
    const b = broadcasts.get(id);
    if (!b) throw notFound(operation, `broadcast ${id}`);
    return b;
  };
  const publicCopy = (b: StoredBroadcast): YouTubeBroadcast => {
    const { ingestionUrl: _ingestion, ...rest } = b;
    return YouTubeBroadcastSchema.parse({ ...rest });
  };

  return {
    calls,
    findBroadcastByMarker(marker) {
      return run("findBroadcastByMarker", { marker }, () => {
        const b = [...broadcasts.values()].find((x) => x.description.includes(marker) && x.lifecycle !== "complete" && x.lifecycle !== "revoked");
        return b ? BroadcastRefSchema.parse({ broadcastId: b.broadcastId, streamId: b.streamId }) : null;
      });
    },
    createBroadcast(input) {
      return run("createBroadcast", { title: input.title }, () => {
        let broadcastId = fakeId();
        while (broadcasts.has(broadcastId)) broadcastId = fakeId();
        const b: StoredBroadcast = {
          broadcastId,
          streamId: `fake_stream_${fakeId().slice(5)}`,
          title: input.title,
          description: input.description,
          scheduledStartAt: input.scheduledStartAt,
          lifecycle: "created",
          actualStartAt: null,
          actualEndAt: null,
          recordingVideoId: null,
          ingestionUrl: "rtmp://a.rtmp.youtube.com/live2",
        };
        broadcasts.set(broadcastId, b);
        return CreatedBroadcastSchema.parse({ broadcastId, streamId: b.streamId, ingestionUrl: b.ingestionUrl });
      });
    },
    updateBroadcast(broadcastId, patch) {
      return run("updateBroadcast", { broadcastId }, () => {
        const b = get("updateBroadcast", broadcastId);
        if (patch.title !== undefined) b.title = patch.title;
        if (patch.description !== undefined) b.description = patch.description;
        if (patch.scheduledStartAt !== undefined) b.scheduledStartAt = patch.scheduledStartAt;
      });
    },
    deleteBroadcast(broadcastId) {
      return run("deleteBroadcast", { broadcastId }, () => {
        broadcasts.delete(broadcastId);
      });
    },
    getBroadcast(broadcastId) {
      return run("getBroadcast", { broadcastId }, () => publicCopy(get("getBroadcast", broadcastId)));
    },
    getVideo(videoId) {
      return run("getVideo", { videoId }, () => {
        const v = videos.get(videoId);
        return v ? YouTubeVideoSchema.parse({ ...v }) : null;
      });
    },
    createMeetSpace() {
      return run("createMeetSpace", {}, () => {
        const code = fakeId().slice(5).toLowerCase().replace(/[^a-z0-9]/g, "x");
        return MeetSpaceSchema.parse({ spaceName: `spaces/fake-${code}`, meetingUri: `https://meet.google.com/fake-${code}` });
      });
    },
    setLifecycle(broadcastId, lifecycle, at) {
      const b = get("getBroadcast", broadcastId);
      if (lifecycle === "revoked") {
        b.lifecycle = "revoked";
        return publicCopy(b);
      }
      if (b.lifecycle === "revoked" || ORDER.indexOf(lifecycle) < ORDER.indexOf(b.lifecycle)) {
        throw new Error(`fake youtube: cannot go back from ${b.lifecycle} to ${lifecycle}`);
      }
      const when = at ?? now();
      b.lifecycle = lifecycle;
      if (lifecycle === "live" && !b.actualStartAt) b.actualStartAt = when;
      if (lifecycle === "complete") {
        b.actualStartAt ??= when;
        b.actualEndAt = when;
        b.recordingVideoId ??= broadcastId;
        if (!videos.has(b.recordingVideoId)) videos.set(b.recordingVideoId, { videoId: b.recordingVideoId, processed: false, durationSec: null, privacyStatus: "unlisted" });
      }
      return publicCopy(b);
    },
    markProcessed(videoId, durationSec) {
      videos.set(videoId, { videoId, processed: true, durationSec, privacyStatus: videos.get(videoId)?.privacyStatus ?? "unlisted" });
    },
    addVideo(videoId, opts) {
      const processed = opts?.processed ?? false;
      videos.set(videoId, { videoId, processed, durationSec: opts?.durationSec ?? null, privacyStatus: "unlisted" });
    },
    failNext(operation, opts) {
      failures.push({ operation, status: opts?.status ?? 500 });
    },
    loseNextResponse(operation) {
      lostResponses.push(operation);
    },
    broadcasts() {
      return [...broadcasts.values()].map(publicCopy);
    },
    reset() {
      broadcasts.clear();
      videos.clear();
      failures.length = 0;
      lostResponses.length = 0;
      calls.length = 0;
    },
  };
}

/** The webinar spec's name for the fake factory. */
export const createFakeYouTube = createYouTubeFake;
