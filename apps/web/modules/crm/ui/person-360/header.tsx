"use client";
/**
 * The 360's key facts (crm spec 5.1, rules 3.11, 3.55; the name, status and pills sit in the
 * page header): contact data, locale, tags, acquisition, partner, companies, the emergency
 * contact and the desk checks of the reception quick view. `NoteForm` and
 * `InteractionForm` are the "Add note" (with the sensitive toggle only for holders of
 * `persons.sensitive_read`) and "Log interaction" actions. Every string is a prop.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button, Checkbox, cn, Input, Label, Textarea } from "@beam/ui";
import { addNote, logInteraction } from "../../timeline/actions";
import type { ReceptionCardLabels, ReceptionCardView } from "./reception-card";

export type PersonFactsView = {
  email: string | null;
  phone: string | null;
  address: string | null;
  localeLabel: string;
  birthOn: string | null;
  preferredChannel: string | null;
  /** "2 of 4 answered", "Dismissed" ...; `null` hides the row (never shown to the client). */
  onboarding: string | null;
  acquisition: { source: string | null; campaign: string | null; date: string | null };
  partner: { id: string; name: string } | null;
  companies: Array<{ id: string; name: string; position: string | null }>;
  tags: Array<{ key: string; label: string; color: string }>;
  emergencyContact: { name: string; phone: string; relation?: string } | null;
  reception: ReceptionCardView;
};

export type PersonFactsLabels = {
  title: string;
  email: string;
  phone: string;
  address: string;
  preferredChannel: string;
  onboarding: string;
  locale: string;
  acquisition: string;
  campaign: string;
  partner: string;
  companies: string;
  emergencyContact: string;
  noEmergencyContact: string;
  tags: string;
  birthOn: string;
  /** The desk checks: terms, health declaration and, for a minor, the guardian's consent. */
  desk: string;
  reception: ReceptionCardLabels;
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-[0.75rem] font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-[0.8125rem] break-words">{children}</dd>
    </div>
  );
}

function Check({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <li className="flex items-center gap-2" data-state={ok ? "ok" : "missing"}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", ok ? "bg-[var(--status-ok)]" : "bg-[var(--status-bad)]")} />
      <span className={ok ? undefined : "font-medium text-[var(--status-bad)]"}>{ok ? yes : no}</span>
    </li>
  );
}

/**
 * The key facts of the 360's overview (owner review, November 2026): contact, language, birth
 * date, channel, origin, partner, companies, emergency contact, onboarding and tags in one
 * label/value list, with the desk checks (terms, health declaration, guardian consent) below.
 */
export function PersonFacts({ view, labels }: { view: PersonFactsView; labels: PersonFactsLabels }) {
  const r = view.reception;
  const dash = <span className="text-muted-foreground">–</span>;
  return (
    <section aria-label={labels.title} className="grid content-start gap-3 rounded-xl border border-border bg-card p-5" data-testid="person-facts">
      <h2 className="text-[0.875rem] font-semibold">{labels.title}</h2>
      <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-4 gap-y-2">
        <Row label={labels.email}>
          {view.email ? (
            <a href={`mailto:${view.email}`} className="hover:underline">
              {view.email}
            </a>
          ) : (
            dash
          )}
        </Row>
        <Row label={labels.phone}>
          {view.phone ? (
            <a href={`tel:${view.phone}`} className="tabular-nums hover:underline">
              {view.phone}
            </a>
          ) : (
            dash
          )}
        </Row>
        {view.address ? <Row label={labels.address}>{view.address}</Row> : null}
        <Row label={labels.locale}>{view.localeLabel}</Row>
        {view.birthOn ? <Row label={labels.birthOn}>{view.birthOn}</Row> : null}
        {view.preferredChannel ? <Row label={labels.preferredChannel}>{view.preferredChannel}</Row> : null}
        <Row label={labels.acquisition}>{[view.acquisition.source, view.acquisition.campaign ? `${labels.campaign}: ${view.acquisition.campaign}` : null, view.acquisition.date].filter(Boolean).join(" · ") || dash}</Row>
        {view.partner ? (
          <Row label={labels.partner}>
            <Link href={`/admin/companies/${view.partner.id}` as never} className="font-medium hover:underline">
              {view.partner.name}
            </Link>
          </Row>
        ) : null}
        {view.companies.length ? (
          <Row label={labels.companies}>
            {view.companies.map((c, i) => (
              <span key={c.id}>
                {i > 0 ? ", " : null}
                <Link href={`/admin/companies/${c.id}` as never} className="font-medium hover:underline">
                  {c.name}
                </Link>
                {c.position ? <span className="text-muted-foreground"> ({c.position})</span> : null}
              </span>
            ))}
          </Row>
        ) : null}
        <Row label={labels.emergencyContact}>
          {view.emergencyContact ? (
            [view.emergencyContact.name, view.emergencyContact.phone, view.emergencyContact.relation].filter(Boolean).join(" · ")
          ) : (
            <span className="text-muted-foreground">{labels.noEmergencyContact}</span>
          )}
        </Row>
        {view.onboarding ? <Row label={labels.onboarding}>{view.onboarding}</Row> : null}
        {view.tags.length ? (
          <Row label={labels.tags}>
            <span className="flex flex-wrap gap-1">
              {view.tags.map((t) => (
                <span key={t.key} className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-[0.6875rem] font-medium">
                  <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: t.color }} />
                  {t.label}
                </span>
              ))}
            </span>
          </Row>
        ) : null}
      </dl>
      <div className="grid gap-1.5 border-t border-border pt-3" data-testid="person-desk-checks">
        <h3 className="text-[0.75rem] font-medium text-muted-foreground">{labels.desk}</h3>
        <ul className="grid gap-1 text-[0.8125rem]">
          <Check ok={r.declarations.termsAccepted} yes={labels.reception.termsAccepted} no={labels.reception.termsMissing} />
          <Check ok={r.declarations.healthDeclarationValid} yes={labels.reception.healthValid} no={labels.reception.healthMissing} />
          {r.isMinor ? <Check ok={r.declarations.guardianConsentValid} yes={labels.reception.guardianValid} no={labels.reception.guardianMissing} /> : null}
        </ul>
      </div>
    </section>
  );
}

export type NoteFormLabels = { title: string; body: string; sensitive: string; save: string; saved: string; error: string };

export function NoteForm({ personId, canSensitive, labels }: { personId: string; canSensitive: boolean; labels: NoteFormLabels }) {
  const router = useRouter();
  const id = useId();
  const [body, setBody] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await addNote({ personId, body, isSensitive: canSensitive && sensitive });
    setBusy(false);
    if (!result.ok) setMessage(labels.error);
    else {
      setBody("");
      setSensitive(false);
      setMessage(labels.saved);
      router.refresh();
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-2" data-testid="note-form" aria-label={labels.title}>
      <Label htmlFor={`${id}-body`}>{labels.body}</Label>
      <Textarea id={`${id}-body`} value={body} maxLength={10_000} required onChange={(e) => setBody(e.target.value)} />
      {canSensitive ? (
        <div className="flex items-center gap-2">
          <Checkbox id={`${id}-sensitive`} checked={sensitive} onCheckedChange={(v) => setSensitive(v === true)} />
          <Label htmlFor={`${id}-sensitive`}>{labels.sensitive}</Label>
        </div>
      ) : null}
      <div>
        <Button type="submit" size="sm" disabled={busy || !body.trim()}>
          {labels.save}
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </form>
  );
}

export type InteractionFormLabels = {
  title: string;
  channel: string;
  purpose: string;
  summary: string;
  occurredAt: string;
  save: string;
  saved: string;
  error: string;
  channels: Record<string, string>;
  purposes: Record<string, string>;
};

type Channel = "call" | "email" | "whatsapp" | "in_person" | "meeting" | "other";
type Purpose = "service" | "sales_follow_up" | "reactivation" | "b2b";

export function InteractionForm({ personId, labels }: { personId: string; labels: InteractionFormLabels }) {
  const router = useRouter();
  const id = useId();
  const [channel, setChannel] = useState<Channel>("call");
  const [purpose, setPurpose] = useState<Purpose>("service");
  const [summary, setSummary] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await logInteraction({ personId, channel, purpose, summary, ...(occurredAt ? { occurredAt: new Date(occurredAt).toISOString() } : {}) });
    setBusy(false);
    if (!result.ok) setMessage(labels.error);
    else {
      setSummary("");
      setOccurredAt("");
      setMessage(labels.saved);
      router.refresh();
    }
  }

  const select = "h-9 rounded-md border bg-background px-2 text-sm";
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-2" data-testid="interaction-form" aria-label={labels.title}>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-channel`}>{labels.channel}</Label>
          <select id={`${id}-channel`} className={select} value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {Object.entries(labels.channels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-purpose`}>{labels.purpose}</Label>
          <select id={`${id}-purpose`} className={select} value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
            {Object.entries(labels.purposes).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-at`}>{labels.occurredAt}</Label>
          <Input id={`${id}-at`} type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </div>
      </div>
      <Label htmlFor={`${id}-summary`}>{labels.summary}</Label>
      <Textarea id={`${id}-summary`} value={summary} maxLength={2000} required onChange={(e) => setSummary(e.target.value)} />
      <div>
        <Button type="submit" size="sm" disabled={busy || !summary.trim()}>
          {labels.save}
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </form>
  );
}

/** A collapsible action block of the 360 page: a quiet one-line summary that opens its form. */
export function ActionBlock({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-border bg-card">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-[0.8125rem] font-semibold [&::-webkit-details-marker]:hidden">
          {title}
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <div className="border-t border-border px-4 py-3">{children}</div>
      </details>
    </div>
  );
}
