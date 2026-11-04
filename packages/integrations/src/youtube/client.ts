/**
 * The real YouTube Data API v3 and Google Meet REST v2 client (webinar spec section 6;
 * webinar-P2). Built with `{ clientId, clientSecret, refreshToken, onCall }`; it exchanges the
 * refresh token for an access token (cached until a minute before expiry) and reports every
 * provider call through `onCall` (operation names `YOUTUBE_OPERATION_NAMES`, never bodies).
 * Called only from the webinar jobs. Every response is parsed with Zod; a response that does not
 * match is a permanent `IntegrationError` (code `invalid_response`). Status mapping: 408, 425,
 * 429 and 5xx retry; other 4xx are permanent (400/403 on insert, 404 on update); a 404 on
 * delete counts as done.
 */
import { z } from "zod";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike } from "../_shared/types";
import {
  BroadcastRefSchema,
  CreatedBroadcastSchema,
  MeetSpaceSchema,
  YOUTUBE_OPERATION_NAMES,
  YouTubeBroadcastSchema,
  YouTubeVideoSchema,
  type BroadcastLifecycle,
  type YouTubeBroadcast,
  type YouTubeClient,
  type YouTubeClientOptions,
  type YouTubeOperation,
  type YouTubeVideo,
} from "./types";

export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
export const MEET_API = "https://meet.googleapis.com/v2";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ---------------------------------------------------------------------------------------------
// Raw resources (only the fields BEAM reads)
// ---------------------------------------------------------------------------------------------

const TokenResource = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().optional() });

export const LiveBroadcastResource = z.object({
  id: z.string(),
  snippet: z
    .object({
      title: z.string().default(""),
      description: z.string().default(""),
      scheduledStartTime: z.string().optional(),
      actualStartTime: z.string().optional(),
      actualEndTime: z.string().optional(),
    })
    .default({ title: "", description: "" }),
  status: z.object({ lifeCycleStatus: z.string() }).optional(),
  contentDetails: z.object({ boundStreamId: z.string().optional() }).optional(),
});
const LiveBroadcastList = z.object({ items: z.array(LiveBroadcastResource).default([]), nextPageToken: z.string().optional() });

const LiveStreamResource = z.object({
  id: z.string().min(1),
  cdn: z.object({ ingestionInfo: z.object({ ingestionAddress: z.string().min(1) }) }),
});

export const VideoResource = z.object({
  id: z.string(),
  contentDetails: z.object({ duration: z.string().optional() }).optional(),
  processingDetails: z.object({ processingStatus: z.string().optional() }).optional(),
  status: z.object({ uploadStatus: z.string().optional(), privacyStatus: z.string().optional() }).optional(),
});
const VideoList = z.object({ items: z.array(VideoResource).default([]) });

const MeetSpaceResource = z.object({ name: z.string(), meetingUri: z.string() });

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

/** ISO 8601 duration (`PT1H2M3S`, `P1DT2H`) in seconds; null for `P0D` or an unparsable value. */
export function parseIsoDuration(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m) return null;
  const [, d, h, min, s] = m;
  const total = Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Math.floor(Number(s ?? 0));
  return total > 0 ? total : null;
}

const LIFECYCLES = new Set<string>(["created", "ready", "testing", "live", "complete", "revoked"]);

/** YouTube's `lifeCycleStatus` (it also reports `liveStarting`, `testStarting`) as one of BEAM's values. */
export function mapLifecycle(raw: string | undefined): BroadcastLifecycle {
  if (!raw) return "created";
  if (LIFECYCLES.has(raw)) return raw as BroadcastLifecycle;
  if (raw === "liveStarting") return "live";
  if (raw === "testStarting") return "testing";
  return "created";
}

const date = (v: string | undefined): Date | null => (v ? new Date(v) : null);

export function toBroadcast(raw: z.infer<typeof LiveBroadcastResource>): YouTubeBroadcast {
  const lifecycle = mapLifecycle(raw.status?.lifeCycleStatus);
  return YouTubeBroadcastSchema.parse({
    broadcastId: raw.id,
    streamId: raw.contentDetails?.boundStreamId ?? null,
    title: raw.snippet.title,
    description: raw.snippet.description,
    scheduledStartAt: date(raw.snippet.scheduledStartTime),
    lifecycle,
    actualStartAt: date(raw.snippet.actualStartTime),
    actualEndAt: date(raw.snippet.actualEndTime),
    recordingVideoId: lifecycle === "complete" ? raw.id : null,
  });
}

export function toVideo(raw: z.infer<typeof VideoResource>): YouTubeVideo {
  const durationSec = parseIsoDuration(raw.contentDetails?.duration);
  const status = raw.processingDetails?.processingStatus;
  const processed = durationSec !== null && (status === "succeeded" || (status === undefined && raw.status?.uploadStatus === "processed"));
  const privacy = raw.status?.privacyStatus;
  return YouTubeVideoSchema.parse({
    videoId: raw.id,
    processed,
    durationSec,
    privacyStatus: privacy === "public" || privacy === "private" ? privacy : "unlisted",
  });
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

type Request = { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; body?: unknown; okStatuses?: number[] };

export function createYouTubeClient(options: YouTubeClientOptions): YouTubeClient {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const clock = options.now ?? Date.now;
  let token: { value: string; expiresAt: number } | null = null;

  const invalid = (operation: string, issue: string) =>
    new IntegrationError({ provider: "youtube", operation, retryable: false, code: "invalid_response", message: `youtube ${operation}: invalid response (${issue})` });

  function parse<T extends z.ZodTypeAny>(schema: T, operation: string, value: unknown): z.infer<T> {
    const result = schema.safeParse(value);
    if (!result.success) throw invalid(operation, result.error.issues[0]?.message ?? "schema");
    return result.data;
  }

  async function accessToken(operation: string, signal: AbortSignal): Promise<string> {
    if (token && token.expiresAt > clock() + 60_000) return token.value;
    const res = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        refresh_token: options.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal,
    });
    // A refused refresh token (400 invalid_grant, 401) is permanent; Google's 5xx retry.
    if (!res.ok) throw errorFromStatus("youtube", operation, res.status, "oauth token refresh failed");
    const body = parse(TokenResource, operation, await res.json().catch(() => null));
    token = { value: body.access_token, expiresAt: clock() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  /** One authenticated request; returns the parsed JSON body (or null for an empty body). */
  async function call(operation: string, req: Request, signal: AbortSignal): Promise<{ body: unknown; status: number }> {
    const bearer = await accessToken(operation, signal);
    const res = await doFetch(req.url, {
      method: req.method,
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json", ...(req.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal,
    });
    if (!res.ok && !(req.okStatuses ?? []).includes(res.status)) {
      throw errorFromStatus("youtube", operation, res.status, await res.text().catch(() => ""));
    }
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw invalid(operation, "not json");
      }
    }
    return { body, status: res.status };
  }

  /** Runs one client operation (one or more requests) as one tracked provider call. */
  function op<T>(operation: YouTubeOperation, path: string, work: (name: string, signal: AbortSignal) => Promise<{ value: T; statusCode: number }>): Promise<T> {
    const name = YOUTUBE_OPERATION_NAMES[operation];
    return trackCall(
      onCall,
      { provider: "youtube", operation: name, requestDigest: digestRequest({ method: "POST", path }) },
      () => withTimeout((signal) => work(name, signal), timeoutMs, { provider: "youtube", operation: name }),
    );
  }

  const broadcastUrl = (params: Record<string, string>) => `${YOUTUBE_API}/liveBroadcasts?${new URLSearchParams(params).toString()}`;

  async function fetchBroadcast(name: string, broadcastId: string, signal: AbortSignal) {
    const { body, status } = await call(name, { method: "GET", url: broadcastUrl({ part: "id,snippet,status,contentDetails", id: broadcastId }) }, signal);
    const list = parse(LiveBroadcastList, name, body);
    const raw = list.items[0];
    if (!raw) throw new IntegrationError({ provider: "youtube", operation: name, retryable: false, statusCode: 404, message: `youtube ${name}: broadcast not found` });
    return { raw, status };
  }

  return {
    findBroadcastByMarker(marker) {
      return op("findBroadcastByMarker", "/youtube/v3/liveBroadcasts", async (name, signal) => {
        let pageToken: string | undefined;
        let status = 200;
        // At most four pages of 50 upcoming broadcasts (BEAM never has more than a few).
        for (let page = 0; page < 4; page++) {
          const params: Record<string, string> = { part: "id,snippet,contentDetails,status", broadcastStatus: "upcoming", broadcastType: "all", maxResults: "50" };
          if (pageToken) params.pageToken = pageToken;
          const res = await call(name, { method: "GET", url: broadcastUrl(params) }, signal);
          status = res.status;
          const list = parse(LiveBroadcastList, name, res.body);
          const hit = list.items.find((b) => b.snippet.description.includes(marker));
          if (hit) return { value: parse(BroadcastRefSchema, name, { broadcastId: hit.id, streamId: hit.contentDetails?.boundStreamId ?? null }), statusCode: status };
          if (!list.nextPageToken) break;
          pageToken = list.nextPageToken;
        }
        return { value: null, statusCode: status };
      });
    },

    createBroadcast(input) {
      return op("createBroadcast", "/youtube/v3/liveBroadcasts/insert", async (name, signal) => {
        const inserted = await call(
          name,
          {
            method: "POST",
            url: `${YOUTUBE_API}/liveBroadcasts?part=snippet,status,contentDetails`,
            body: {
              snippet: { title: input.title.slice(0, 100), description: input.description.slice(0, 5000), scheduledStartTime: input.scheduledStartAt.toISOString() },
              status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
              contentDetails: {
                enableAutoStart: true,
                enableAutoStop: true,
                recordFromStart: true,
                enableDvr: false,
                latencyPreference: "low",
                enableEmbed: true,
                monitorStream: { enableMonitorStream: false },
              },
            },
          },
          signal,
        );
        const broadcast = parse(LiveBroadcastResource, name, inserted.body);
        const streamed = await call(
          name,
          {
            method: "POST",
            url: `${YOUTUBE_API}/liveStreams?part=snippet,cdn,contentDetails`,
            body: { snippet: { title: input.title.slice(0, 100) }, cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" }, contentDetails: { isReusable: false } },
          },
          signal,
        );
        const stream = parse(LiveStreamResource, name, streamed.body);
        const bound = await call(
          name,
          { method: "POST", url: `${YOUTUBE_API}/liveBroadcasts/bind?${new URLSearchParams({ id: broadcast.id, streamId: stream.id, part: "id,contentDetails" }).toString()}` },
          signal,
        );
        return {
          value: parse(CreatedBroadcastSchema, name, { broadcastId: broadcast.id, streamId: stream.id, ingestionUrl: stream.cdn.ingestionInfo.ingestionAddress }),
          statusCode: bound.status,
        };
      });
    },

    updateBroadcast(broadcastId, patch) {
      return op("updateBroadcast", "/youtube/v3/liveBroadcasts/update", async (name, signal) => {
        const { raw } = await fetchBroadcast(name, broadcastId, signal);
        const res = await call(
          name,
          {
            method: "PUT",
            url: `${YOUTUBE_API}/liveBroadcasts?part=snippet`,
            body: {
              id: broadcastId,
              snippet: {
                title: (patch.title ?? raw.snippet.title).slice(0, 100),
                description: (patch.description ?? raw.snippet.description).slice(0, 5000),
                scheduledStartTime: (patch.scheduledStartAt?.toISOString() ?? raw.snippet.scheduledStartTime) || new Date(clock()).toISOString(),
              },
            },
          },
          signal,
        );
        return { value: undefined, statusCode: res.status };
      });
    },

    deleteBroadcast(broadcastId) {
      return op("deleteBroadcast", "/youtube/v3/liveBroadcasts/delete", async (name, signal) => {
        const res = await call(name, { method: "DELETE", url: broadcastUrl({ id: broadcastId }), okStatuses: [404] }, signal);
        return { value: undefined, statusCode: res.status };
      });
    },

    getBroadcast(broadcastId) {
      return op("getBroadcast", "/youtube/v3/liveBroadcasts/list", async (name, signal) => {
        const { raw, status } = await fetchBroadcast(name, broadcastId, signal);
        return { value: toBroadcast(raw), statusCode: status };
      });
    },

    getVideo(videoId) {
      return op("getVideo", "/youtube/v3/videos/list", async (name, signal) => {
        const res = await call(
          name,
          { method: "GET", url: `${YOUTUBE_API}/videos?${new URLSearchParams({ part: "contentDetails,processingDetails,status", id: videoId }).toString()}` },
          signal,
        );
        const raw = parse(VideoList, name, res.body).items[0];
        return { value: raw ? toVideo(raw) : null, statusCode: res.status };
      });
    },

    createMeetSpace() {
      return op("createMeetSpace", "/meet/v2/spaces", async (name, signal) => {
        const res = await call(name, { method: "POST", url: `${MEET_API}/spaces`, body: { config: { accessType: "TRUSTED" } } }, signal);
        const space = parse(MeetSpaceResource, name, res.body);
        return { value: parse(MeetSpaceSchema, name, { spaceName: space.name, meetingUri: space.meetingUri }), statusCode: res.status };
      });
    },
  };
}
