/**
 * YouTube Live and Google Meet types (webinar spec section 6; webinar-P2). One `YouTubeClient`
 * covers the YouTube Data API v3 operations the webinar jobs call and Meet REST v2
 * `spaces.create` (both on BEAM's own Google Workspace account). The client and the fake return
 * the same domain shapes, each parsed by the Zod schemas below, so a test of the fake checks the
 * contract the real client keeps. The `*Resource` schemas validate the raw Google responses.
 */
import { z } from "zod";
import type { FakeCall, FetchLike, OnCall } from "../_shared/types";

/** `status.lifeCycleStatus` of a live broadcast (the values BEAM stores in `webinars.youtube_lifecycle`). */
export const BROADCAST_LIFECYCLES = ["created", "ready", "testing", "live", "complete", "revoked"] as const;
export type BroadcastLifecycle = (typeof BROADCAST_LIFECYCLES)[number];

/** A YouTube video or broadcast id: 11 characters of `[A-Za-z0-9_-]` (the `webinars` checks). */
export const YouTubeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);

/** Where the description of a BEAM broadcast carries `beam-webinar:<webinarId>` (retry after a lost response). */
export const BROADCAST_MARKER_PREFIX = "beam-webinar:";
export const broadcastMarker = (webinarId: string): string => `${BROADCAST_MARKER_PREFIX}${webinarId}`;

export const YouTubeBroadcastSchema = z.object({
  broadcastId: YouTubeIdSchema,
  streamId: z.string().min(1).nullable(),
  title: z.string(),
  description: z.string(),
  scheduledStartAt: z.date().nullable(),
  lifecycle: z.enum(BROADCAST_LIFECYCLES),
  actualStartAt: z.date().nullable(),
  actualEndAt: z.date().nullable(),
  /** The broadcast id is the recording's video id once the broadcast is `complete` (`recordFromStart`). */
  recordingVideoId: YouTubeIdSchema.nullable(),
});
export type YouTubeBroadcast = z.infer<typeof YouTubeBroadcastSchema>;

export const BroadcastRefSchema = z.object({ broadcastId: YouTubeIdSchema, streamId: z.string().min(1).nullable() });
export type BroadcastRef = z.infer<typeof BroadcastRefSchema>;

export const CreatedBroadcastSchema = z.object({
  broadcastId: YouTubeIdSchema,
  streamId: z.string().min(1),
  /** RTMP ingestion address of the bound stream (shown to hosts who stream without Meet). */
  ingestionUrl: z.string().min(1),
});
export type CreatedBroadcast = z.infer<typeof CreatedBroadcastSchema>;

export const YouTubeVideoSchema = z.object({
  videoId: YouTubeIdSchema,
  /** `processingDetails.processingStatus = succeeded` and a duration is known. */
  processed: z.boolean(),
  /** `contentDetails.duration` in seconds; null while YouTube has not computed it. */
  durationSec: z.number().int().positive().nullable(),
  privacyStatus: z.enum(["unlisted", "private", "public"]),
});
export type YouTubeVideo = z.infer<typeof YouTubeVideoSchema>;

export const MeetSpaceSchema = z.object({
  /** Meet API resource name `spaces/<id>`. */
  spaceName: z.string().regex(/^spaces\/[A-Za-z0-9_-]+$/),
  /** `https://meet.google.com/...` (the `webinars.host_meet_url` check). */
  meetingUri: z.string().startsWith("https://meet.google.com/"),
});
export type MeetSpace = z.infer<typeof MeetSpaceSchema>;

export type CreateBroadcastInput = { title: string; description: string; scheduledStartAt: Date };
export type UpdateBroadcastPatch = { title?: string; description?: string; scheduledStartAt?: Date };

export interface YouTubeClient {
  /** `liveBroadcasts.list?mine=true&broadcastStatus=upcoming`, matched on the description marker. */
  findBroadcastByMarker(marker: string): Promise<BroadcastRef | null>;
  /** `liveBroadcasts.insert` (unlisted, auto start/stop, record from start), `liveStreams.insert`, `liveBroadcasts.bind`. */
  createBroadcast(input: CreateBroadcastInput): Promise<CreatedBroadcast>;
  /** `liveBroadcasts.update` (a full PUT of title, description and scheduled start). 404 is permanent. */
  updateBroadcast(broadcastId: string, patch: UpdateBroadcastPatch): Promise<void>;
  /** `liveBroadcasts.delete`; 404 counts as done. */
  deleteBroadcast(broadcastId: string): Promise<void>;
  /** `liveBroadcasts.list?id=`; a missing broadcast is a permanent 404 `IntegrationError`. */
  getBroadcast(broadcastId: string): Promise<YouTubeBroadcast>;
  /** `videos.list?part=contentDetails,processingDetails,status`; null when YouTube does not know the id. */
  getVideo(videoId: string): Promise<YouTubeVideo | null>;
  /** Meet REST v2 `spaces.create` with `accessType: TRUSTED`. */
  createMeetSpace(): Promise<MeetSpace>;
}

export type YouTubeOperation = keyof YouTubeClient;

/** The operation names written to `integration_calls.operation` (`<area>.<verb>`). */
export const YOUTUBE_OPERATION_NAMES: Readonly<Record<YouTubeOperation, string>> = {
  findBroadcastByMarker: "broadcasts.find",
  createBroadcast: "broadcasts.create",
  updateBroadcast: "broadcasts.update",
  deleteBroadcast: "broadcasts.delete",
  getBroadcast: "broadcasts.get",
  getVideo: "videos.get",
  createMeetSpace: "meet.spaces.create",
};

export type YouTubeClientOptions = {
  clientId: string;
  clientSecret: string;
  /** `GOOGLE_OAUTH_REFRESH_TOKEN` of BEAM's Google account (scopes `youtube`, `meetings.space.created`). */
  refreshToken: string;
  onCall?: OnCall;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
};

/** The fake's scripting surface (webinar spec section 6). */
export interface FakeYouTube extends YouTubeClient {
  readonly calls: FakeCall[];
  /** Moves a broadcast forward (`created -> ready -> testing -> live -> complete`); `live` and `complete` stamp the actual times. */
  setLifecycle(broadcastId: string, lifecycle: BroadcastLifecycle, at?: Date): YouTubeBroadcast;
  /** Marks a video processed with its duration (creates the video when unknown). */
  markProcessed(videoId: string, durationSec: number): void;
  /** Adds a video that exists but is still processing (an upload staff link with "Use different YouTube video"). */
  addVideo(videoId: string, opts?: { processed?: boolean; durationSec?: number | null }): void;
  /** The next call of `operation` fails with this HTTP status (default 500); several calls queue up. */
  failNext(operation: YouTubeOperation, opts?: { status?: number }): void;
  /** The next call of `operation` performs its work and then fails (a lost response). */
  loseNextResponse(operation: YouTubeOperation): void;
  /** Current broadcasts (copies), for assertions. */
  broadcasts(): YouTubeBroadcast[];
  reset(): void;
}

/** @deprecated The Wave 0 name of `FakeYouTube`. */
export type YouTubeFake = FakeYouTube;
