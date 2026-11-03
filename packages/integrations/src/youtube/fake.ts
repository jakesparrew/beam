/**
 * The YouTube fake (runbook section 1.5, webinar spec section 6). Broadcast ids `fake_<uuid>`,
 * lifecycle `created -> ready -> live -> complete`, a recording video id on `complete`.
 * Wave 0 ships the interface here; webinar-P2 writes the real `client.ts` and `types.ts` and
 * extends this fake, keeping its name and constructor.
 */
import { randomUUID } from "node:crypto";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type FakeCall, type OnCall } from "../_shared/types";

export type BroadcastLifecycle = "created" | "ready" | "live" | "complete";

export type YouTubeBroadcast = {
  broadcastId: string;
  streamId: string;
  title: string;
  description: string;
  scheduledStartAt: Date;
  lifecycle: BroadcastLifecycle;
  actualStartAt: Date | null;
  actualEndAt: Date | null;
  recordingVideoId: string | null;
  ingestionUrl: string;
};

export type YouTubeVideo = { videoId: string; processed: boolean; durationSec: number | null; privacyStatus: "unlisted" | "private" | "public" };

export interface YouTubeClient {
  findBroadcastByMarker(marker: string): Promise<{ broadcastId: string; streamId: string } | null>;
  createBroadcast(input: { title: string; description: string; scheduledStartAt: Date }): Promise<{ broadcastId: string; streamId: string; ingestionUrl: string }>;
  updateBroadcast(broadcastId: string, patch: { title?: string; description?: string; scheduledStartAt?: Date }): Promise<void>;
  deleteBroadcast(broadcastId: string): Promise<void>;
  getBroadcast(broadcastId: string): Promise<YouTubeBroadcast>;
  getVideo(videoId: string): Promise<YouTubeVideo | null>;
  createMeetSpace(): Promise<{ spaceName: string; meetingUri: string }>;
}

export type YouTubeOperation = keyof YouTubeClient;

export type YouTubeFake = YouTubeClient & {
  readonly calls: FakeCall[];
  setLifecycle(broadcastId: string, lifecycle: BroadcastLifecycle, at?: Date): YouTubeBroadcast;
  markProcessed(videoId: string, durationSec: number): void;
  failNext(operation: YouTubeOperation, opts?: { status?: number }): void;
  reset(): void;
};

const ORDER: BroadcastLifecycle[] = ["created", "ready", "live", "complete"];

export function createYouTubeFake(options: { onCall?: OnCall; now?: () => Date } = {}): YouTubeFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const calls: FakeCall[] = [];
  const broadcasts = new Map<string, YouTubeBroadcast>();
  const videos = new Map<string, YouTubeVideo>();
  const failures: { operation: YouTubeOperation; status: number }[] = [];

  function run<T>(operation: YouTubeOperation, input: unknown, work: () => T): Promise<T> {
    calls.push({ operation, input, at: now() });
    return trackCall(onCall, { provider: "youtube", operation, requestDigest: digestRequest({ method: "POST", path: `/youtube/${operation}` }) }, () => {
      const i = failures.findIndex((f) => f.operation === operation);
      if (i >= 0) {
        const [f] = failures.splice(i, 1);
        throw errorFromStatus("youtube", operation, f!.status);
      }
      return { value: work(), statusCode: 200 };
    });
  }

  const get = (id: string): YouTubeBroadcast => {
    const b = broadcasts.get(id);
    if (!b) throw new IntegrationError({ provider: "youtube", operation: "getBroadcast", retryable: false, statusCode: 404, message: `broadcast ${id} not found` });
    return b;
  };

  return {
    calls,
    findBroadcastByMarker(marker) {
      return run("findBroadcastByMarker", { marker }, () => {
        const b = [...broadcasts.values()].find((x) => x.description.includes(marker) && x.lifecycle !== "complete");
        return b ? { broadcastId: b.broadcastId, streamId: b.streamId } : null;
      });
    },
    createBroadcast(input) {
      return run("createBroadcast", { title: input.title }, () => {
        const broadcastId = `fake_${randomUUID()}`;
        const b: YouTubeBroadcast = {
          broadcastId,
          streamId: `fake_stream_${randomUUID()}`,
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
        return { broadcastId, streamId: b.streamId, ingestionUrl: b.ingestionUrl };
      });
    },
    updateBroadcast(broadcastId, patch) {
      return run("updateBroadcast", { broadcastId }, () => {
        Object.assign(get(broadcastId), Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      });
    },
    deleteBroadcast(broadcastId) {
      return run("deleteBroadcast", { broadcastId }, () => {
        broadcasts.delete(broadcastId);
      });
    },
    getBroadcast(broadcastId) {
      return run("getBroadcast", { broadcastId }, () => ({ ...get(broadcastId) }));
    },
    getVideo(videoId) {
      return run("getVideo", { videoId }, () => {
        const v = videos.get(videoId);
        return v ? { ...v } : null;
      });
    },
    createMeetSpace() {
      return run("createMeetSpace", {}, () => {
        const code = randomUUID().slice(0, 10);
        return { spaceName: `spaces/fake-${code}`, meetingUri: `https://meet.google.com/fake-${code}` };
      });
    },
    setLifecycle(broadcastId, lifecycle, at) {
      const b = get(broadcastId);
      if (ORDER.indexOf(lifecycle) < ORDER.indexOf(b.lifecycle)) throw new Error(`fake youtube: cannot go back from ${b.lifecycle} to ${lifecycle}`);
      const when = at ?? now();
      b.lifecycle = lifecycle;
      if (lifecycle === "live" && !b.actualStartAt) b.actualStartAt = when;
      if (lifecycle === "complete") {
        b.actualStartAt ??= when;
        b.actualEndAt = when;
        b.recordingVideoId ??= broadcastId;
        if (!videos.has(b.recordingVideoId)) videos.set(b.recordingVideoId, { videoId: b.recordingVideoId, processed: false, durationSec: null, privacyStatus: "unlisted" });
      }
      return { ...b };
    },
    markProcessed(videoId, durationSec) {
      videos.set(videoId, { videoId, processed: true, durationSec, privacyStatus: videos.get(videoId)?.privacyStatus ?? "unlisted" });
    },
    failNext(operation, opts) {
      failures.push({ operation, status: opts?.status ?? 500 });
    },
    reset() {
      broadcasts.clear();
      videos.clear();
      failures.length = 0;
      calls.length = 0;
    },
  };
}
