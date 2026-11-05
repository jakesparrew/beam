"use client";
/**
 * The "Draft with AI" tab of `/admin/campaigns/new` (email spec section 5, R4), email-P10.
 *
 * A brief, a purpose, up to three events and a segment hint go to `requestAiDraft`; the list
 * below shows the staff member's newest drafts and refreshes itself while one is `queued`. A
 * `ready` draft shows its subject and preheader per locale, the suggested audience and send time
 * and the notes; "Create draft campaign" (`acceptAiDraft`) opens the new draft campaign in the
 * editor, never scheduled. A `failed` draft says "AI unavailable, write manually".
 */
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Checkbox, Input, Label, Textarea } from "@beam/ui";
import { acceptAiDraft, discardAiDraft, requestAiDraft } from "../../actions";
import { clab, type CampaignLabels } from "./CampaignStepper";

type Locale = "nl-BE" | "fr-BE" | "en";
type Purpose = "newsletter" | "events" | "member_comms" | "b2b";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];
const MAX_SESSIONS = 3;
const POLL_MS = 4000;

export type AiDraftPanelDraft = {
  id: string;
  brief: string;
  status: "queued" | "ready" | "failed" | "accepted" | "discarded";
  error: string | null;
  purpose: Purpose;
  campaignId: string | null;
  createdAt: Date | string;
  output: {
    subject: Partial<Record<Locale, string>>;
    preheader: Partial<Record<Locale, string>>;
    document: { locales: Partial<Record<Locale, unknown[]>> };
    segment: { segmentId: string | null; description: string };
    suggestedSendAt: string;
    timingRationale: string;
    notes: string;
  } | null;
};

export type AiDraftPanelProps = {
  purposes: readonly Purpose[];
  sessions: readonly { id: string; label: string }[];
  segments: readonly { id: string; name: string }[];
  drafts: readonly AiDraftPanelDraft[];
  /** `email.ai.*` and `email.campaigns.purpose_*` labels, keys relative to `email.`. */
  labels: CampaignLabels;
  locale: Locale;
};

const STATUS_VARIANT: Record<AiDraftPanelDraft["status"], "secondary" | "success" | "destructive" | "outline"> = {
  queued: "secondary",
  ready: "success",
  failed: "destructive",
  accepted: "outline",
  discarded: "outline",
};

function brusselsText(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Brussels" }).format(d);
}

export function AiDraftPanel(props: AiDraftPanelProps) {
  const { labels } = props;
  const l = (k: string) => clab(labels, `ai.${k}`);
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [purpose, setPurpose] = useState<Purpose>(props.purposes[0] ?? "newsletter");
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [segmentId, setSegmentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const pending = props.drafts.some((d) => d.status === "queued");

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, router]);

  function toggleSession(id: string, on: boolean) {
    setSessionIds((ids) => (on ? (ids.includes(id) || ids.length >= MAX_SESSIONS ? ids : [...ids, id]) : ids.filter((x) => x !== id)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const result = await requestAiDraft({ brief, purpose, sessionIds, ...(segmentId ? { segmentId } : {}) });
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: "error", text: result.error.code === "forbidden" ? l("no_permission") : l("error_generic") });
      return;
    }
    setBrief("");
    setNotice({ kind: "ok", text: l("requested") });
    router.refresh();
  }

  return (
    <div className="grid gap-6" data-testid="ai-draft-panel">
      <p className="text-sm text-muted-foreground">{l("intro")}</p>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4 rounded-md border p-4" data-testid="ai-draft-form">
        <div className="grid gap-1">
          <Label htmlFor="ai-brief">{l("brief")}</Label>
          <Textarea id="ai-brief" value={brief} onChange={(e) => setBrief(e.target.value)} minLength={10} maxLength={4000} rows={5} required />
          <p className="text-xs text-muted-foreground">{l("brief_hint")}</p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ai-purpose">{l("purpose")}</Label>
          <select id="ai-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)} className="h-9 rounded-md border bg-background px-2 text-sm">
            {props.purposes.map((p) => (
              <option key={p} value={p}>
                {clab(labels, `campaigns.purpose_${p}`)}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{l("sessions")}</legend>
          {props.sessions.length === 0 ? <p className="text-sm text-muted-foreground">{l("sessions_none")}</p> : null}
          {props.sessions.map((s) => {
            const checked = sessionIds.includes(s.id);
            return (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={checked} disabled={!checked && sessionIds.length >= MAX_SESSIONS} onCheckedChange={(v) => toggleSession(s.id, v === true)} />
                {s.label}
              </label>
            );
          })}
        </fieldset>
        <div className="grid gap-1">
          <Label htmlFor="ai-segment">{l("segment")}</Label>
          <select id="ai-segment" value={segmentId} onChange={(e) => setSegmentId(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">{l("segment_none")}</option>
            {props.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {notice ? (
          <Alert variant={notice.kind === "error" ? "destructive" : "default"} role="status">
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        ) : null}
        <div>
          <Button type="submit" disabled={busy || brief.trim().length < 10} data-testid="ai-draft-request">
            {l("request")}
          </Button>
        </div>
      </form>

      <section className="grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{l("drafts_title")}</h2>
          <Button variant="ghost" size="sm" onClick={() => router.refresh()}>
            {l("refresh")}
          </Button>
        </div>
        {props.drafts.length === 0 ? <p className="text-sm text-muted-foreground">{l("drafts_empty")}</p> : null}
        {props.drafts.map((d) => (
          <DraftCard key={d.id} draft={d} labels={labels} locale={props.locale} />
        ))}
      </section>
    </div>
  );
}

function DraftCard({ draft, labels, locale }: { draft: AiDraftPanelDraft; labels: CampaignLabels; locale: Locale }) {
  const l = (k: string) => clab(labels, `ai.${k}`);
  const router = useRouter();
  const [name, setName] = useState(() => (draft.output?.subject[locale] ?? draft.brief).slice(0, 160));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const o = draft.output;

  async function accept() {
    setBusy(true);
    setError(null);
    const result = await acceptAiDraft({ draftId: draft.id, campaignName: name });
    setBusy(false);
    if (result.ok) router.push(`/admin/campaigns/${result.data.campaignId}?step=content` as never);
    else setError(result.error.code === "forbidden" ? l("no_permission") : l("error_generic"));
  }

  async function discard() {
    setBusy(true);
    const result = await discardAiDraft({ draftId: draft.id });
    setBusy(false);
    if (result.ok) router.refresh();
    else setError(l("error_generic"));
  }

  return (
    <article className="grid gap-3 rounded-md border p-4" data-testid="ai-draft" data-status={draft.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="line-clamp-2 text-sm">{draft.brief}</p>
        <Badge variant={STATUS_VARIANT[draft.status]}>{l(`status_${draft.status}`)}</Badge>
      </div>
      {draft.status === "failed" ? (
        <Alert variant="destructive">
          <AlertDescription>{draft.error === "budget" ? l("error_budget") : l("unavailable")}</AlertDescription>
        </Alert>
      ) : null}
      {o && draft.status === "ready" ? (
        <div className="grid gap-3 text-sm">
          <dl className="grid gap-2">
            {LOCALES.map((loc) => (
              <div key={loc} className="grid gap-0.5">
                <dt className="text-xs font-medium text-muted-foreground">
                  {loc} · {l("subject")} / {l("preheader")}
                </dt>
                <dd>
                  <strong>{o.subject[loc]}</strong>
                  <span className="text-muted-foreground"> · {o.preheader[loc]}</span>
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    ({l("blocks")}: {o.document.locales[loc]?.length ?? 0})
                  </span>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            <span className="font-medium">{l("suggested_segment")}: </span>
            {o.segment.description}
          </p>
          <p>
            <span className="font-medium">{l("suggested_send_at")}: </span>
            {brusselsText(o.suggestedSendAt, locale)}. {o.timingRationale}
          </p>
          {o.notes ? (
            <p>
              <span className="font-medium">{l("notes")}: </span>
              {o.notes}
            </p>
          ) : null}
          <div className="grid gap-1">
            <Label htmlFor={`ai-name-${draft.id}`}>{l("campaign_name")}</Label>
            <Input id={`ai-name-${draft.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} required />
            <p className="text-xs text-muted-foreground">{l("accept_note")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void accept()} disabled={busy || !name.trim()} data-testid="ai-draft-accept">
              {l("accept")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => void discard()} disabled={busy}>
              {l("discard")}
            </Button>
          </div>
        </div>
      ) : null}
      {draft.status === "queued" || draft.status === "failed" ? (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => void discard()} disabled={busy}>
            {l("discard")}
          </Button>
        </div>
      ) : null}
      {draft.status === "accepted" && draft.campaignId ? (
        <div>
          <Button variant="secondary" size="sm" onClick={() => router.push(`/admin/campaigns/${draft.campaignId}?step=content` as never)}>
            {l("open_campaign")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </article>
  );
}
