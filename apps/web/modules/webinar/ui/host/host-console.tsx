"use client";
/**
 * The host console of `/admin/webinars/[id]/host` (webinar spec 5.1, rules 10, 13, 42, 44).
 * Left: the Meet host link, YouTube Studio, live status (as text, not only colour), viewers now
 * and elapsed time, Force live / Force ended. Middle: polls and CTAs with Launch, Close, Show and
 * Hide and live results (`LivePollControls`). Right: the chat stream and the questions queue
 * with the moderation buttons (`ChatModeration`). A red banner shows when the stream is not
 * connected 15 minutes before a live webinar (pre-flight t15). The page re-renders every 5 s
 * while the webinar is published or live (`router.refresh()`), so the console needs no socket.
 * Texts come from the page (`labels`); the participant link never shows here or the Meet URL to
 * viewers (rule 13).
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, Badge, Button } from "@beam/ui";
import { forceLiveState } from "../../actions";
import { Message, failureText } from "../admin/webinar-form";
import { ChatModeration, type ChatModerationLabels, type HostMessage } from "./chat-moderation";
import { LivePollControls, type LivePollControlsLabels, type HostCtaItem, type HostPollItem } from "./live-poll-controls";

export type HostConsoleLabels = {
  meetLink: string;
  meetMissing: string;
  studioLink: string;
  status: string;
  lifecycle: string;
  lifecycleUnknown: string;
  viewers: string;
  elapsed: string;
  notStarted: string;
  waiting: string;
  preflight: string;
  /** `{error}` is replaced by the YouTube problem. */
  broadcastError: string;
  forceLive: string;
  forceEnded: string;
  forceHint: string;
  refreshing: string;
  saved: string;
  statuses: Record<string, string>;
  errors: Record<string, string>;
  items: LivePollControlsLabels;
  moderation: ChatModerationLabels;
};

export type HostConsoleProps = {
  webinarId: string;
  mode: "live" | "simulive" | "on_demand";
  status: string;
  hostMeetUrl: string | null;
  studioUrl: string | null;
  youtubeLifecycle: string | null;
  broadcastError: string | null;
  liveStarted: boolean;
  viewerCount: number;
  elapsedSec: number | null;
  preflightAlert: boolean;
  polls: HostPollItem[];
  ctas: HostCtaItem[];
  chat: HostMessage[];
  questions: HostMessage[];
  labels: HostConsoleLabels;
};

const REFRESH_MS = 5000;

export function hhmmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

export function HostConsole(props: HostConsoleProps) {
  const { labels } = props;
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const refreshing = props.status === "published" || props.status === "live";

  useEffect(() => {
    if (!refreshing) return;
    const t = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refreshing, router]);

  async function run(call: () => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>) {
    setPending(true);
    setMessage(null);
    try {
      const res = await call();
      setMessage(res.ok ? { error: false, text: labels.saved } : { error: true, text: failureText(labels.errors, res.error) });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const live = props.mode === "live" && props.status === "live";
  const waiting = props.mode === "live" && props.status === "published" && !props.liveStarted;
  return (
    <div className="grid gap-6">
      {props.preflightAlert ? (
        <Alert variant="destructive" role="alert" data-testid="host-preflight">
          <AlertDescription>{labels.preflight}</AlertDescription>
        </Alert>
      ) : null}
      {props.broadcastError ? (
        <Alert variant="destructive">
          <AlertDescription>{labels.broadcastError.replace("{error}", props.broadcastError)}</AlertDescription>
        </Alert>
      ) : null}
      <Message message={message} />
      <div className="grid gap-6 lg:grid-cols-[1fr_2fr_2fr]">
        <section className="flex flex-col gap-3" aria-label={labels.status}>
          {props.hostMeetUrl ? (
            <a href={props.hostMeetUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
              {labels.meetLink}
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">{labels.meetMissing}</p>
          )}
          {props.studioUrl ? (
            <a href={props.studioUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {labels.studioLink}
            </a>
          ) : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{labels.status}</dt>
            <dd>
              <Badge variant={live ? "default" : "secondary"} data-testid="host-status">
                {labels.statuses[props.status] ?? props.status}
              </Badge>
            </dd>
            {props.mode === "live" ? (
              <>
                <dt className="text-muted-foreground">{labels.lifecycle}</dt>
                <dd>{props.youtubeLifecycle ?? labels.lifecycleUnknown}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{labels.viewers}</dt>
            <dd data-testid="host-viewers">{props.viewerCount}</dd>
            <dt className="text-muted-foreground">{labels.elapsed}</dt>
            <dd>{props.elapsedSec === null ? labels.notStarted : hhmmss(props.elapsedSec)}</dd>
          </dl>
          {waiting ? <p className="rounded-md border border-border p-3 text-sm">{labels.waiting}</p> : null}
          {props.mode === "live" && (props.status === "published" || props.status === "live") ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {props.status === "published" ? (
                  <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void run(() => forceLiveState({ webinarId: props.webinarId, to: "live" }))}>
                    {labels.forceLive}
                  </Button>
                ) : (
                  <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void run(() => forceLiveState({ webinarId: props.webinarId, to: "ended" }))}>
                    {labels.forceEnded}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{labels.forceHint}</p>
            </div>
          ) : null}
          {refreshing ? <p className="text-xs text-muted-foreground">{labels.refreshing}</p> : null}
        </section>
        <LivePollControls polls={props.polls} ctas={props.ctas} live={live} pending={pending} labels={labels.items} run={run} />
        <ChatModeration webinarId={props.webinarId} chat={props.chat} questions={props.questions} pending={pending} labels={labels.moderation} run={run} />
      </div>
    </div>
  );
}
