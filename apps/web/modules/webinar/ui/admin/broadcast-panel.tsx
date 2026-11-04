"use client";
/**
 * The broadcast panel and lifecycle buttons of `/admin/webinars/[id]` (webinar spec 5.1, rules
 * 9-12, edge cases 6, 7 and 22). `BroadcastPanel`: the YouTube broadcast id and lifecycle, the
 * "creating YouTube broadcast" state while `publish_requested_at` is set, `broadcast_error` in
 * red, the hosts' Meet link, the recording and "Use different YouTube video". `LifecycleActions`:
 * Publish (lists what is missing), Cancel (reason, notify), Archive, Duplicate to dates and Force
 * live / ended. Every text comes from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge, Button, Checkbox, FormField, Input, Textarea } from "@beam/ui";
import { archiveWebinar, cancelWebinar, duplicateWebinar, forceLiveState, publishWebinar, setWebinarVideo } from "../../actions";
import { Message, brusselsToIso, failureText, fieldLines, formText, selectClass } from "./webinar-form";

type Msg = { error: boolean; text: string; lines?: string[] } | null;
type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

export type BroadcastPanelProps = {
  webinarId: string;
  mode: "live" | "simulive" | "on_demand";
  status: string;
  youtubeVideoId: string | null;
  youtubeLifecycle: string | null;
  recordingVideoId: string | null;
  durationLabel: string | null;
  hostMeetUrl: string | null;
  publishing: boolean;
  /** The error text to show in red (already mapped from `broadcast_error`), or null. */
  errorText: string | null;
  labels: {
    title: string;
    videoId: string;
    lifecycle: string;
    lifecycleUnknown: string;
    creating: string;
    none: string;
    studio: string;
    meet: string;
    meetNone: string;
    recording: string;
    recordingNone: string;
    useOther: string;
    field: string;
    fieldBroadcast: string;
    fieldRecording: string;
    videoIdLabel: string;
    set: string;
    setDone: string;
    errors: Record<string, string>;
  };
};

export function BroadcastPanel(p: BroadcastPanelProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Msg>(null);
  const L = p.labels;

  async function onSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setPending(true);
    try {
      const res = await setWebinarVideo({ webinarId: p.webinarId, field: formText(f, "field"), videoId: formText(f, "videoId") });
      if (res.ok) {
        setMessage({ error: false, text: L.setDone });
        setOpen(false);
        router.refresh();
      } else setMessage({ error: true, text: failureText(L.errors, res.error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="broadcast-title" className="grid gap-3 rounded-md border p-4">
      <h2 id="broadcast-title" className="text-lg font-semibold">
        {L.title}
      </h2>
      <Message message={message} />
      {p.errorText ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {p.errorText}
        </p>
      ) : null}
      {p.mode === "live" ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted-foreground">{L.videoId}</dt>
          <dd>
            {p.publishing ? (
              <span role="status" className="inline-flex items-center gap-2">
                <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
                {L.creating}
              </span>
            ) : p.youtubeVideoId ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <code>{p.youtubeVideoId}</code>
                <a className="underline" href={`https://studio.youtube.com/video/${p.youtubeVideoId}/livestreaming`} target="_blank" rel="noreferrer noopener">
                  {L.studio}
                </a>
              </span>
            ) : (
              L.none
            )}
          </dd>
          <dt className="text-muted-foreground">{L.lifecycle}</dt>
          <dd>
            <Badge variant="outline">{p.youtubeLifecycle ?? L.lifecycleUnknown}</Badge>
          </dd>
          <dt className="text-muted-foreground">{L.meet}</dt>
          <dd>
            {p.hostMeetUrl ? (
              <a className="underline" href={p.hostMeetUrl} target="_blank" rel="noreferrer noopener">
                {p.hostMeetUrl}
              </a>
            ) : (
              L.meetNone
            )}
          </dd>
        </dl>
      ) : null}
      <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
        <dt className="text-muted-foreground">{L.recording}</dt>
        <dd>{p.recordingVideoId ? <span><code>{p.recordingVideoId}</code>{p.durationLabel ? ` · ${p.durationLabel}` : ""}</span> : L.recordingNone}</dd>
      </dl>
      {p.status !== "cancelled" && p.status !== "archived" ? (
        open ? (
          <form onSubmit={(e) => void onSet(e)} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <FormField label={L.field}>
              <select name="field" className={selectClass} defaultValue={p.mode === "live" ? "youtube_video_id" : "recording_video_id"}>
                {p.mode === "live" ? <option value="youtube_video_id">{L.fieldBroadcast}</option> : null}
                <option value="recording_video_id">{L.fieldRecording}</option>
              </select>
            </FormField>
            <FormField label={L.videoIdLabel} required>
              <Input name="videoId" pattern="[A-Za-z0-9_-]{11}" maxLength={11} minLength={11} required />
            </FormField>
            <Button type="submit" disabled={pending}>
              {L.set}
            </Button>
          </form>
        ) : (
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
              {L.useOther}
            </Button>
          </div>
        )
      ) : null}
    </section>
  );
}

export type LifecycleActionsProps = {
  webinarId: string;
  version: number;
  mode: "live" | "simulive" | "on_demand";
  status: string;
  canPublish: boolean;
  canCancel: boolean;
  canArchive: boolean;
  canDuplicate: boolean;
  labels: {
    publish: string;
    publishing: string;
    published: string;
    publishingStarted: string;
    publishFailed: string;
    cancel: string;
    cancelReason: string;
    cancelNotify: string;
    cancelConfirm: string;
    cancelled: string;
    archive: string;
    archived: string;
    duplicate: string;
    duplicateHint: string;
    duplicateDate: string;
    duplicateAdd: string;
    duplicateRemove: string;
    duplicateSubmit: string;
    /** `{count}` left in. */
    duplicated: string;
    forceLive: string;
    forceEnded: string;
    forced: string;
    missingFor: string;
    fieldNames: Record<string, string>;
    localeNames: Record<string, string>;
    errors: Record<string, string>;
  };
};

export function LifecycleActions(p: LifecycleActionsProps) {
  const router = useRouter();
  const L = p.labels;
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<Msg>(null);
  const [panel, setPanel] = useState<"cancel" | "duplicate" | null>(null);
  const [dates, setDates] = useState<string[]>([""]);

  const describe = (field: string, value: string) => {
    // `poll:<key>.question` -> "Poll <key>.question" (the catalogue text keeps a `{key}` slot).
    const item = /^(poll|cta):(.+)$/.exec(field);
    const name = item ? (L.fieldNames[item[1]!] ?? item[1]!).replace("{key}", item[2]!) : (L.fieldNames[field] ?? field);
    const isLocales = value.split(",").every((l) => l in L.localeNames);
    if (!isLocales) return `${name}: ${L.errors[value] ?? value}`;
    return L.missingFor.replace("{field}", name).replace("{locales}", value.split(",").map((l) => L.localeNames[l]).join(", "));
  };

  async function run(key: string, call: () => Promise<Result>, done: (data: unknown) => string) {
    setPending(key);
    setMessage(null);
    try {
      const res = await call();
      if (res.ok) {
        setMessage({ error: false, text: done(res.data) });
        setPanel(null);
        router.refresh();
      } else {
        const lines = fieldLines(res.error.fields, describe);
        setMessage({ error: true, text: key === "publish" && lines.length ? L.publishFailed : failureText(L.errors, res.error), lines });
      }
    } finally {
      setPending(null);
    }
  }

  function onCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void run("cancel", () => cancelWebinar({ webinarId: p.webinarId, reason: formText(f, "reason"), notify: f.get("notify") === "on" }), () => L.cancelled);
  }

  function onDuplicate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startsAt = dates.map(brusselsToIso).filter((d): d is string => !!d);
    void run("duplicate", () => duplicateWebinar({ webinarId: p.webinarId, startsAt }), (data) =>
      L.duplicated.replace("{count}", String((data as { webinarIds: string[] }).webinarIds.length)),
    );
  }

  return (
    <section className="grid gap-3" aria-live="polite">
      <Message message={message} />
      <div className="flex flex-wrap gap-2">
        {p.canPublish ? (
          <Button
            type="button"
            disabled={!!pending}
            onClick={() =>
              void run("publish", () => publishWebinar({ webinarId: p.webinarId, version: p.version }), (data) =>
                (data as { status: string }).status === "publishing" ? L.publishingStarted : L.published,
              )
            }
          >
            {pending === "publish" ? L.publishing : L.publish}
          </Button>
        ) : null}
        {p.status === "published" && p.mode !== "on_demand" ? (
          <Button type="button" variant="outline" disabled={!!pending} onClick={() => void run("live", () => forceLiveState({ webinarId: p.webinarId, to: "live" }), () => L.forced)}>
            {L.forceLive}
          </Button>
        ) : null}
        {p.status === "live" ? (
          <Button type="button" variant="outline" disabled={!!pending} onClick={() => void run("ended", () => forceLiveState({ webinarId: p.webinarId, to: "ended" }), () => L.forced)}>
            {L.forceEnded}
          </Button>
        ) : null}
        {p.canDuplicate ? (
          <Button type="button" variant="outline" onClick={() => setPanel(panel === "duplicate" ? null : "duplicate")} aria-expanded={panel === "duplicate"}>
            {L.duplicate}
          </Button>
        ) : null}
        {p.canArchive ? (
          <Button type="button" variant="outline" disabled={!!pending} onClick={() => void run("archive", () => archiveWebinar({ webinarId: p.webinarId }), () => L.archived)}>
            {L.archive}
          </Button>
        ) : null}
        {p.canCancel ? (
          <Button type="button" variant="destructive" onClick={() => setPanel(panel === "cancel" ? null : "cancel")} aria-expanded={panel === "cancel"}>
            {L.cancel}
          </Button>
        ) : null}
      </div>
      {panel === "cancel" ? (
        <form onSubmit={onCancel} className="grid gap-3 rounded-md border p-4">
          <FormField label={L.cancelReason} required>
            <Textarea name="reason" minLength={3} maxLength={500} rows={2} required />
          </FormField>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="notify" defaultChecked />
            {L.cancelNotify}
          </label>
          <div>
            <Button type="submit" variant="destructive" disabled={!!pending}>
              {L.cancelConfirm}
            </Button>
          </div>
        </form>
      ) : null}
      {panel === "duplicate" ? (
        <form onSubmit={onDuplicate} className="grid gap-3 rounded-md border p-4">
          <p className="text-sm text-muted-foreground">{L.duplicateHint}</p>
          {dates.map((d, i) => (
            <div key={i} className="flex items-end gap-2">
              <FormField label={`${L.duplicateDate} ${i + 1}`} required>
                <Input type="datetime-local" value={d} onChange={(e) => setDates((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} required />
              </FormField>
              {dates.length > 1 ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setDates((cur) => cur.filter((_, j) => j !== i))}>
                  {L.duplicateRemove}
                </Button>
              ) : null}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {dates.length < 26 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setDates((cur) => [...cur, ""])}>
                {L.duplicateAdd}
              </Button>
            ) : null}
            <Button type="submit" disabled={!!pending || dates.some((d) => !d)}>
              {L.duplicateSubmit}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
