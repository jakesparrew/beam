"use client";
/**
 * `WebinarPlayer` (webinar spec 5.3, rules 22-25, 44, section 9.3): the player shared by the token
 * page `/[locale]/w/[token]` and the portal page `/[locale]/account/webinars/[id]`.
 *
 * 1. The click-to-load notice (`PlayerNotice`, `player_notice_v1`): nothing from Google loads first.
 * 2. `POST /api/webinar/view`: the server decides the mode, the video and the start position.
 *    Refusals show their message (countdown before `starts_at - 15 min`, "waiting for the host",
 *    ended, expired, view limit, blocked, cancelled); a waiting player asks again later.
 * 3. The YouTube IFrame Player API (`next/script`, after the click, with the request nonce so the
 *    CSP's `'nonce-…' 'strict-dynamic'` admits it) on `youtube-nocookie.com`, `rel=0`,
 *    `modestbranding=1`, `playsinline=1`, controls off for live and simulive. A video id starting
 *    with `fake_` (the YouTube fake) renders the simulated player instead: a 1-second timer with
 *    the same play, pause, seek and ended events, so the watch-time e2e runs without youtube.com.
 * 4. A heartbeat every 15 s while playing, one on pause and end, and one with `keepalive` on page
 *    hide (a beacon cannot carry the `x-webinar-token` header). `409` reloads the view, `403` and
 *    `stop: 'expired'` stop the player.
 * 5. Simulive resyncs to `now - starts_at` when it drifts more than 10 s. Captions are one toggle
 *    that reloads the player with `cc_load_policy=1` and the spoken language. State changes are
 *    announced in one `aria-live="polite"` region; on a player error the unlisted
 *    `youtube.com/watch?v=` link is offered with a note that it leaves BEAM.
 *
 * Every text comes from the server as a prop (`labels`).
 */
import Script from "next/script";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Button } from "@beam/ui";
import { PlayerNotice, type PlayerNoticeLabels } from "./player-notice";

type Locale = "nl-BE" | "fr-BE" | "en";
type Mode = "live" | "replay" | "on_demand";
type PlayState = "playing" | "paused" | "buffering" | "ended";
type Refusal = "not_started" | "ended" | "expired" | "limit_reached" | "blocked" | "cancelled" | "unauthorized" | "invalid_token" | "not_registered" | "error";

export type ViewPayload = {
  viewId: string;
  mode: Mode;
  videoId: string;
  startSec: number;
  durationSec: number | null;
  controls: boolean;
  resync: boolean;
  showingStartedAt: string | null;
  viewsLeft: number | null;
  nextMs: number;
};

export type WebinarPlayerLabels = {
  notice: PlayerNoticeLabels;
  loading: string;
  /** `{time}` is replaced by the remaining time ("2 d 03:15:20"). */
  countdown: string;
  waiting: string;
  modes: Record<Mode, string>;
  nowWatching: string;
  refusals: Record<Refusal, string>;
  contact: string;
  captionsOn: string;
  captionsOff: string;
  play: string;
  pause: string;
  error: string;
  fallbackLink: string;
  fallbackNote: string;
  reloading: string;
  simulated: string;
  /** `{time}` is replaced by the position (mm:ss). */
  position: string;
  /** `{count}` views left. */
  viewsLeft: string;
};

export type WebinarPlayerProps = {
  webinarId: string;
  /** The personal access token (token page); the portal page uses the session cookie. */
  token?: string | null;
  spokenLocale: Locale;
  nonce: string | null;
  labels: WebinarPlayerLabels;
  privacyHref: string;
  contactHref: string;
};

type Phase = { kind: "notice" } | { kind: "loading" } | { kind: "refused"; code: Refusal; startsAt: string | null } | { kind: "watching"; view: ViewPayload };

/** What the heartbeat loop needs from a player (YouTube or the simulated one). */
type Adapter = { time(): number; state(): PlayState; seek(sec: number): void; destroy(): void };

type YTPlayer = { getCurrentTime(): number; getPlayerState(): number; seekTo(s: number, allow: boolean): void; destroy(): void };
type YTNamespace = { Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer };
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const CC_LANG: Record<Locale, string> = { "nl-BE": "nl", "fr-BE": "fr", en: "en" };
const YT_STATE: Record<number, PlayState> = { 0: "ended", 1: "playing", 2: "paused", 3: "buffering" };
const RESYNC_DRIFT_SEC = 10;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function remaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const hms = [Math.floor((s % 86_400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
  return d > 0 ? `${d} d ${hms}` : hms;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(onChange: () => void): () => void {
  const q = window.matchMedia?.(REDUCED_MOTION);
  if (!q) return () => undefined;
  q.addEventListener("change", onChange);
  return () => q.removeEventListener("change", onChange);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia?.(REDUCED_MOTION).matches ?? false,
    () => false,
  );
}

export function WebinarPlayer(props: WebinarPlayerProps) {
  const { webinarId, token, labels } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "notice" });
  const [announce, setAnnounce] = useState("");
  const headingId = useId();

  const headers = useCallback((): HeadersInit => ({ "content-type": "application/json", ...(token ? { "x-webinar-token": token } : {}) }), [token]);

  const loadView = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const res = await fetch("/api/webinar/view", { method: "POST", headers: headers(), body: JSON.stringify({ webinarId }), credentials: "same-origin" });
      const body = (await res.json()) as Partial<ViewPayload> & { error?: Refusal; startsAt?: string | null };
      if (body.error || !body.viewId) {
        const code: Refusal = body.error ?? "error";
        setPhase({ kind: "refused", code: code in labels.refusals ? code : "error", startsAt: body.startsAt ?? null });
        setAnnounce(labels.refusals[code] ?? labels.refusals.error);
        return;
      }
      setPhase({ kind: "watching", view: body as ViewPayload });
      setAnnounce(`${labels.modes[body.mode as Mode]}. ${labels.nowWatching}`);
    } catch {
      setPhase({ kind: "refused", code: "error", startsAt: null });
    }
  }, [headers, labels, webinarId]);

  return (
    <div className="flex flex-col gap-3">
      <p aria-live="polite" role="status" className="sr-only">
        {announce}
      </p>
      {phase.kind === "notice" && <PlayerNotice labels={labels.notice} privacyHref={props.privacyHref} headingId={headingId} onAccept={() => void loadView()} />}
      {phase.kind === "loading" && <p className="flex aspect-video w-full items-center justify-center rounded-lg border border-border">{labels.loading}</p>}
      {phase.kind === "refused" && <RefusalCard phase={phase} labels={labels} contactHref={props.contactHref} onRetry={loadView} />}
      {phase.kind === "watching" && (
        <Watching
          key={phase.view.viewId}
          view={phase.view}
          props={props}
          headers={headers}
          onReload={() => {
            setAnnounce(labels.reloading);
            void loadView();
          }}
          onStop={(code) => {
            setPhase({ kind: "refused", code, startsAt: null });
            setAnnounce(labels.refusals[code]);
          }}
        />
      )}
    </div>
  );
}

function RefusalCard({ phase, labels, contactHref, onRetry }: { phase: Extract<Phase, { kind: "refused" }>; labels: WebinarPlayerLabels; contactHref: string; onRetry: () => Promise<void> }) {
  const reduced = useReducedMotion();
  const [now, setNow] = useState(() => Date.now());
  const startsAt = phase.startsAt ? new Date(phase.startsAt).getTime() : null;
  const waiting = phase.code === "not_started";

  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => setNow(Date.now()), reduced ? 60_000 : 1000);
    // Ask again: at 15 minutes before the start, else about once a minute (the view route is per-IP limited).
    const until = startsAt ? startsAt - 15 * 60_000 - Date.now() : 0;
    const retryMs = until > 60_000 ? Math.min(until, 30 * 60_000) : 45_000 + Math.floor(Math.random() * 30_000);
    const retry = setTimeout(() => void onRetry(), retryMs);
    return () => {
      clearInterval(tick);
      clearTimeout(retry);
    };
  }, [waiting, reduced, startsAt, onRetry]);

  const countdown = waiting && startsAt !== null && startsAt - now > 15 * 60_000;
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted p-6 text-center">
      {waiting ? (
        <p className="text-lg font-semibold text-foreground" data-testid="webinar-countdown">
          {countdown && startsAt !== null ? fill(labels.countdown, { time: remaining(startsAt - now) }) : labels.waiting}
        </p>
      ) : (
        <>
          <p className="text-lg font-semibold text-foreground">{labels.refusals[phase.code]}</p>
          {phase.code !== "ended" && (
            <a href={contactHref} className="text-sm underline underline-offset-2">
              {labels.contact}
            </a>
          )}
        </>
      )}
    </div>
  );
}

function Watching(input: {
  view: ViewPayload;
  props: WebinarPlayerProps;
  headers: () => HeadersInit;
  onReload: () => void;
  onStop: (code: Refusal) => void;
}) {
  const { view, props, headers, onReload, onStop } = input;
  const { labels } = props;
  const fake = view.videoId.startsWith("fake_");
  const [captions, setCaptions] = useState(false);
  const [failed, setFailed] = useState(false);
  const [apiReady, setApiReady] = useState(() => typeof window !== "undefined" && !!window.YT?.Player);
  const adapter = useRef<Adapter | null>(null);
  const lastPos = useRef(view.startSec);
  /** Where a reloaded player (captions toggle) starts: state, so rendering never reads a ref. */
  const [resumeAt, setResumeAt] = useState(view.startSec);

  const send = useCallback(
    async (state: PlayState, keepalive = false) => {
      const a = adapter.current;
      if (!a) return;
      const toSec = Math.max(0, Math.floor(a.time()));
      const body = { webinarId: props.webinarId, viewId: view.viewId, mode: view.mode, fromSec: Math.max(0, Math.floor(lastPos.current)), toSec, state };
      try {
        const res = await fetch("/api/webinar/heartbeat", { method: "POST", headers: headers(), body: JSON.stringify(body), keepalive, credentials: "same-origin" });
        if (res.status === 429) return;
        lastPos.current = toSec;
        if (keepalive) return;
        const out = (await res.json().catch(() => ({}))) as { stop?: string };
        if (res.status === 409 || out.stop === "mode_changed") return onReload();
        if (res.status === 403 || out.stop === "blocked" || out.stop === "cancelled") return onStop(out.stop === "cancelled" ? "cancelled" : "blocked");
        if (out.stop === "expired") return onStop("expired");
      } catch {
        // Lost telemetry never affects the registration (edge case 4); the next beat tries again.
      }
    },
    [headers, onReload, onStop, props.webinarId, view.mode, view.viewId],
  );

  const onState = useCallback(
    (state: PlayState) => {
      if (state === "paused" || state === "ended") void send(state);
    },
    [send],
  );

  // The heartbeat every 15 s while playing, the simulive resync, and the beat on page hide.
  useEffect(() => {
    const beat = setInterval(() => {
      const a = adapter.current;
      if (!a || a.state() !== "playing") return;
      if (view.resync && view.showingStartedAt) {
        const expected = (Date.now() - new Date(view.showingStartedAt).getTime()) / 1000;
        if (Math.abs(a.time() - expected) > RESYNC_DRIFT_SEC) a.seek(expected);
      }
      void send("playing");
    }, view.nextMs || 15_000);
    const hide = () => {
      if (adapter.current?.state() === "playing") void send("playing", true);
    };
    window.addEventListener("pagehide", hide);
    return () => {
      clearInterval(beat);
      window.removeEventListener("pagehide", hide);
    };
  }, [send, view.nextMs, view.resync, view.showingStartedAt]);

  useEffect(() => () => adapter.current?.destroy(), []);

  const toggleCaptions = () => {
    const current = adapter.current;
    // Replay and on-demand resume where the viewer was; simulive at the showing position; a live stream plays its live edge.
    if (view.controls && current) setResumeAt(current.time());
    else if (view.resync && view.showingStartedAt) setResumeAt((Date.now() - new Date(view.showingStartedAt).getTime()) / 1000);
    adapter.current?.destroy();
    adapter.current = null;
    setCaptions((c) => !c);
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        <span className="rounded-md border border-border px-2 py-0.5">{labels.modes[view.mode]}</span>
        {view.viewsLeft !== null && <span className="ml-2 text-muted-foreground">{fill(labels.viewsLeft, { count: view.viewsLeft })}</span>}
      </p>
      {fake ? (
        <SimulatedPlayer key={`${captions}`} view={view} startSec={resumeAt} labels={labels} adapterRef={adapter} onState={onState} />
      ) : (
        <>
          {!apiReady && (
            <Script
              src="https://www.youtube.com/iframe_api"
              strategy="afterInteractive"
              nonce={props.nonce ?? undefined}
              onLoad={() => {
                if (window.YT?.Player) setApiReady(true);
                window.onYouTubeIframeAPIReady = () => setApiReady(true);
              }}
            />
          )}
          {failed ? (
            <div role="alert" className="rounded-lg border border-border p-4 text-sm">
              <p>{labels.error}</p>
              <p>
                <a href={`https://www.youtube.com/watch?v=${view.videoId}`} rel="noopener noreferrer" target="_blank" className="underline underline-offset-2">
                  {labels.fallbackLink}
                </a>{" "}
                <span className="text-muted-foreground">{labels.fallbackNote}</span>
              </p>
            </div>
          ) : (
            apiReady && (
              <YouTubeFrame key={`${captions}`} view={view} startSec={resumeAt} captions={captions} spokenLocale={props.spokenLocale} adapterRef={adapter} onState={onState} onError={() => setFailed(true)} />
            )
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" aria-pressed={captions} onClick={toggleCaptions}>
          {captions ? labels.captionsOff : labels.captionsOn}
        </Button>
      </div>
    </div>
  );
}

function YouTubeFrame(input: {
  view: ViewPayload;
  startSec: number;
  captions: boolean;
  spokenLocale: Locale;
  adapterRef: RefObject<Adapter | null>;
  onState: (s: PlayState) => void;
  onError: () => void;
}) {
  const { view, startSec, captions, spokenLocale, adapterRef, onState, onError } = input;
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !window.YT?.Player) return;
    let state: PlayState = "paused";
    const player = new window.YT.Player(el.current, {
      host: "https://www.youtube-nocookie.com",
      videoId: view.videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        controls: view.controls ? 1 : 0,
        disablekb: view.controls ? 0 : 1,
        start: Math.floor(startSec),
        ...(captions ? { cc_load_policy: 1, cc_lang_pref: CC_LANG[spokenLocale] } : {}),
      },
      events: {
        onStateChange: (e: { data: number }) => {
          state = YT_STATE[e.data] ?? state;
          onState(state);
        },
        onError: () => onError(),
      },
    });
    adapterRef.current = {
      time: () => player.getCurrentTime?.() ?? 0,
      state: () => state,
      seek: (s) => player.seekTo(s, true),
      destroy: () => player.destroy(),
    };
    return () => {
      adapterRef.current = null;
      player.destroy();
    };
  }, [view, startSec, captions, spokenLocale, adapterRef, onState, onError]);
  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
      <div ref={el} />
    </div>
  );
}

/** The YouTube fake's player: a 1-second timer with play, pause, seek and ended (A5). */
function SimulatedPlayer(input: { view: ViewPayload; startSec: number; labels: WebinarPlayerLabels; adapterRef: RefObject<Adapter | null>; onState: (s: PlayState) => void }) {
  const { view, startSec, labels, adapterRef, onState } = input;
  const pos = useRef(startSec);
  const state = useRef<PlayState>("paused");
  const [shown, setShown] = useState({ pos: startSec, state: "paused" as PlayState });

  useEffect(() => {
    adapterRef.current = {
      time: () => pos.current,
      state: () => state.current,
      seek: (s) => {
        pos.current = Math.max(0, s);
        setShown((x) => ({ ...x, pos: pos.current }));
      },
      destroy: () => undefined,
    };
    const timer = setInterval(() => {
      if (state.current !== "playing") return;
      pos.current += 1;
      if (view.durationSec && view.controls && pos.current >= view.durationSec) {
        pos.current = view.durationSec;
        state.current = "ended";
        onState("ended");
      }
      setShown({ pos: pos.current, state: state.current });
    }, 1000);
    return () => {
      clearInterval(timer);
      adapterRef.current = null;
    };
  }, [adapterRef, onState, view.controls, view.durationSec]);

  const toggle = () => {
    state.current = state.current === "playing" ? "paused" : "playing";
    setShown({ pos: pos.current, state: state.current });
    onState(state.current);
  };

  return (
    <div role="group" aria-label={labels.simulated} data-testid="webinar-fake-player" data-state={shown.state} className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted">
      <p className="text-sm text-muted-foreground">{labels.simulated}</p>
      <p className="font-mono text-2xl" data-testid="webinar-fake-position">
        {fill(labels.position, { time: mmss(shown.pos) })}
      </p>
      <Button type="button" onClick={toggle}>
        {shown.state === "playing" ? labels.pause : labels.play}
      </Button>
    </div>
  );
}
