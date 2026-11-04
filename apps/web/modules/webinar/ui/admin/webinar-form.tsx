"use client";
/**
 * The webinar details form (webinar spec 5.1 `/admin/webinars/new` and `/admin/webinars/[id]`):
 * mode, slug, title and description per page language (`LocalizedInput` limited to the chosen
 * languages), languages, spoken language, start in Brussels time, planned duration and owner;
 * on an existing webinar also the series key, replay, thresholds, interaction and the Meet link.
 * Saves with the optimistic `version` (a stale save says "changed by someone else"). Every text
 * comes from the page; this file also holds the small client helpers the other admin editors use.
 */
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, LocalizedInput, type LocalizedInputLabels, type LocalizedValue } from "@beam/ui";
import { createWebinar, updateWebinar } from "../../actions";

type Locale = "nl-BE" | "fr-BE" | "en";
type Mode = "live" | "simulive" | "on_demand";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];

// ---------------------------------------------------------------------------------------------
// Shared client helpers
// ---------------------------------------------------------------------------------------------

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const brusselsParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Brussels",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Brussels wall-clock offset of an instant in ms. */
function brusselsOffset(instant: number): number {
  const p = Object.fromEntries(brusselsParts.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - Math.floor(instant / 60_000) * 60_000;
}

/** `YYYY-MM-DDTHH:mm` in Brussels -> ISO instant (the browser's own time zone plays no part). */
export function brusselsToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let utc = guess - brusselsOffset(guess);
  utc = guess - brusselsOffset(utc);
  return new Date(utc).toISOString();
}

export type ActionFailure = { code: string; message: string; fields?: Record<string, string> };

/** The text of a failed action: the specific message key when known, else the code's. */
export function failureText(errors: Record<string, string>, error: ActionFailure): string {
  const key = error.message.split(":")[0]!;
  return errors[key] ?? errors[error.code] ?? errors.internal ?? error.code;
}

/** `{ field: 'fr-BE,en' }` problems as readable lines. */
export function fieldLines(fields: Record<string, string> | undefined, describe: (field: string, value: string) => string): string[] {
  return Object.entries(fields ?? {}).map(([f, v]) => describe(f, v));
}

export function Message({ message }: { message: { error: boolean; text: string; lines?: string[] } | null }): ReactNode {
  if (!message) return null;
  return (
    <Alert variant={message.error ? "destructive" : "default"} role={message.error ? "alert" : "status"}>
      <AlertDescription>
        <p>{message.text}</p>
        {message.lines?.length ? (
          <ul className="mt-1 list-disc pl-5">
            {message.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------

export type WebinarFormValues = {
  webinarId?: string;
  version?: number;
  status?: string;
  mode: Mode;
  slug: string;
  title: LocalizedValue<Locale>;
  description: LocalizedValue<Locale>;
  locales: Locale[];
  spokenLocale: Locale;
  /** Brussels wall time `YYYY-MM-DDTHH:mm` or "". */
  startsAt: string;
  plannedDurationMinutes: number;
  ownerUserId: string;
  seriesKey: string;
  isReplayEnabled: boolean;
  isReplayGated: boolean;
  replayUntilAt: string;
  replayViewLimit: string;
  onDemandAccessDays: string;
  attendedMinutes: number;
  conversionWindowDays: number;
  isChatEnabled: boolean;
  isQuestionsEnabled: boolean;
  hostMeetUrl: string;
};

export type WebinarFormLabels = {
  mode: string;
  modes: Record<Mode, string>;
  modeHints: Record<Mode, string>;
  slug: string;
  slugHint: string;
  title: LocalizedInputLabels<Locale>;
  description: LocalizedInputLabels<Locale>;
  locales: string;
  localeNames: Record<Locale, string>;
  spokenLocale: string;
  startsAt: string;
  startsAtHint: string;
  duration: string;
  owner: string;
  seriesKey: string;
  seriesHint: string;
  replay: string;
  isReplayEnabled: string;
  isReplayGated: string;
  replayUntil: string;
  replayViewLimit: string;
  onDemandAccessDays: string;
  thresholds: string;
  attendedMinutes: string;
  conversionWindow: string;
  interaction: string;
  chatEnabled: string;
  questionsEnabled: string;
  meetUrl: string;
  meetHint: string;
  save: string;
  saveDraft: string;
  saving: string;
  saved: string;
  created: string;
  errors: Record<string, string>;
  /** `{field}: missing {locales}` with the placeholders left in. */
  missingFor: string;
  fieldNames: Record<string, string>;
};

const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v.trim() : "");
const intOrNull = (v: string): number | null => (v === "" ? null : Number.parseInt(v, 10));

export function WebinarForm({ initial, owners, labels }: { initial: WebinarFormValues; owners: Array<{ id: string; label: string }>; labels: WebinarFormLabels }) {
  const router = useRouter();
  const isNew = !initial.webinarId;
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [locales, setLocales] = useState<Locale[]>(initial.locales);
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string; lines?: string[] } | null>(null);

  const describe = (field: string, value: string) =>
    labels.missingFor.replace("{field}", labels.fieldNames[field] ?? field).replace("{locales}", value.split(",").map((l) => labels.localeNames[l as Locale] ?? l).join(", "));

  const toggleLocale = (l: Locale, on: boolean) => setLocales((cur) => (on ? LOCALES.filter((x) => x === l || cur.includes(x)) : cur.filter((x) => x !== l)));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const startsLocal = str(f.get("startsAt"));
    const startsAt = mode === "on_demand" || !startsLocal ? null : brusselsToIso(startsLocal);
    setPending(true);
    setMessage(null);
    try {
      const common = {
        slug: str(f.get("slug")),
        title,
        description,
        locales,
        spokenLocale: str(f.get("spokenLocale")) as Locale,
        plannedDurationMinutes: Number(str(f.get("plannedDurationMinutes"))),
      };
      const res = isNew
        ? await createWebinar({ ...common, mode, ownerUserId: str(f.get("ownerUserId")), ...(startsAt ? { startsAt } : {}) })
        : await updateWebinar({
            ...common,
            webinarId: initial.webinarId,
            version: initial.version,
            startsAt,
            ownerUserId: str(f.get("ownerUserId")),
            seriesKey: str(f.get("seriesKey")) || null,
            isReplayEnabled: f.get("isReplayEnabled") === "on",
            isReplayGated: f.get("isReplayGated") === "on",
            replayUntilAt: str(f.get("replayUntilAt")) ? brusselsToIso(str(f.get("replayUntilAt"))) : null,
            replayViewLimit: intOrNull(str(f.get("replayViewLimit"))),
            onDemandAccessDays: intOrNull(str(f.get("onDemandAccessDays"))),
            attendedMinSec: Number(str(f.get("attendedMinutes"))) * 60,
            conversionWindowDays: Number(str(f.get("conversionWindowDays"))),
            isChatEnabled: f.get("isChatEnabled") === "on",
            isQuestionsEnabled: f.get("isQuestionsEnabled") === "on",
            hostMeetUrl: str(f.get("hostMeetUrl")) || null,
          });
      if (res.ok) {
        if (isNew) {
          const { webinarId } = res.data as { webinarId: string };
          router.push(`/admin/webinars/${webinarId}` as Route);
        } else {
          setMessage({ error: false, text: labels.saved });
          router.refresh();
        }
      } else {
        setMessage({ error: true, text: failureText(labels.errors, res.error), lines: fieldLines(res.error.fields, describe) });
      }
    } finally {
      setPending(false);
    }
  }

  const check = (name: keyof WebinarFormValues, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox name={name} defaultChecked={initial[name] as boolean} />
      {label}
    </label>
  );

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-5" noValidate>
      <Message message={message} />
      {isNew ? (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{labels.mode}</legend>
          {(["live", "simulive", "on_demand"] as const).map((m) => (
            <label key={m} className="flex items-start gap-2 text-sm">
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="mt-1" />
              <span>
                <span className="font-medium">{labels.modes[m]}</span>
                <span className="block text-muted-foreground">{labels.modeHints[m]}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={labels.slug} hint={labels.slugHint} required>
          <Input name="slug" defaultValue={initial.slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={80} required readOnly={!isNew && initial.status !== "draft"} />
        </FormField>
        <FormField label={labels.owner} required>
          <select name="ownerUserId" defaultValue={initial.ownerUserId} className={selectClass} required>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{labels.locales}</legend>
        <div className="flex flex-wrap gap-4">
          {LOCALES.map((l) => (
            <label key={l} className="flex items-center gap-2 text-sm">
              <Checkbox checked={locales.includes(l)} onCheckedChange={(v) => toggleLocale(l, v === true)} aria-label={labels.localeNames[l]} />
              <span lang={l}>{labels.localeNames[l]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <LocalizedInput name="title" value={title} onChange={setTitle} locales={locales} labels={labels.title} />
      <LocalizedInput name="description" value={description} onChange={setDescription} locales={locales} labels={labels.description} multiline />
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={labels.spokenLocale}>
          <select name="spokenLocale" defaultValue={initial.spokenLocale} className={selectClass}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {labels.localeNames[l]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.startsAt} hint={mode === "on_demand" ? labels.startsAtHint : undefined}>
          <Input name="startsAt" type="datetime-local" defaultValue={initial.startsAt} disabled={mode === "on_demand"} />
        </FormField>
        <FormField label={labels.duration} required>
          <Input name="plannedDurationMinutes" type="number" min={5} max={480} defaultValue={initial.plannedDurationMinutes} required />
        </FormField>
      </div>
      {!isNew ? (
        <>
          <FormField label={labels.seriesKey} hint={labels.seriesHint}>
            <Input name="seriesKey" defaultValue={initial.seriesKey} pattern="[a-z0-9-]{3,60}" maxLength={60} />
          </FormField>
          <fieldset className="grid gap-3 rounded-md border p-4">
            <legend className="px-1 text-sm font-medium">{labels.replay}</legend>
            {check("isReplayEnabled", labels.isReplayEnabled)}
            {check("isReplayGated", labels.isReplayGated)}
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label={labels.replayUntil}>
                <Input name="replayUntilAt" type="datetime-local" defaultValue={initial.replayUntilAt} />
              </FormField>
              <FormField label={labels.replayViewLimit}>
                <Input name="replayViewLimit" type="number" min={1} max={50} defaultValue={initial.replayViewLimit} />
              </FormField>
              <FormField label={labels.onDemandAccessDays}>
                <Input name="onDemandAccessDays" type="number" min={1} max={365} defaultValue={initial.onDemandAccessDays} />
              </FormField>
            </div>
          </fieldset>
          <fieldset className="grid gap-3 rounded-md border p-4">
            <legend className="px-1 text-sm font-medium">{labels.thresholds}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={labels.attendedMinutes}>
                <Input name="attendedMinutes" type="number" min={1} max={60} defaultValue={initial.attendedMinutes} />
              </FormField>
              <FormField label={labels.conversionWindow}>
                <Input name="conversionWindowDays" type="number" min={1} max={365} defaultValue={initial.conversionWindowDays} />
              </FormField>
            </div>
          </fieldset>
          <fieldset className="grid gap-3 rounded-md border p-4">
            <legend className="px-1 text-sm font-medium">{labels.interaction}</legend>
            {check("isChatEnabled", labels.chatEnabled)}
            {check("isQuestionsEnabled", labels.questionsEnabled)}
            <FormField label={labels.meetUrl} hint={labels.meetHint}>
              <Input name="hostMeetUrl" type="url" defaultValue={initial.hostMeetUrl} placeholder="https://meet.google.com/" />
            </FormField>
          </fieldset>
        </>
      ) : null}
      <div>
        <Button type="submit" disabled={pending || locales.length === 0}>
          {pending ? labels.saving : isNew ? labels.saveDraft : labels.save}
        </Button>
      </div>
    </form>
  );
}
