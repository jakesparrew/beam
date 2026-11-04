"use client";
/**
 * The 360 header (crm spec 5.1, rules 3.11, 3.55): name, customer number, status (derived vs
 * override), member badge, locale, tags, contact data, acquisition, partner, companies, the
 * emergency contact and the declaration badges, beside the reception quick view. `NoteForm` and
 * `InteractionForm` are the "Add note" (with the sensitive toggle only for holders of
 * `persons.sensitive_read`) and "Log interaction" actions. Every string is a prop.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Card, CardContent, Checkbox, Input, Label, Textarea } from "@beam/ui";
import { addNote, logInteraction } from "../../timeline/actions";
import { ReceptionCard, type ReceptionCardLabels, type ReceptionCardView } from "./reception-card";

export type PersonHeaderView = {
  id: string;
  name: string;
  customerNumberLabel: string;
  statusLabel: string;
  derivedLabel: string | null;
  overrideLabel: string | null;
  isMember: boolean;
  isTester: boolean;
  localeLabel: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  birthOn: string | null;
  acquisition: { source: string | null; campaign: string | null; date: string | null };
  partner: { id: string; name: string } | null;
  companies: Array<{ id: string; name: string; position: string | null }>;
  tags: Array<{ key: string; label: string; color: string }>;
  emergencyContact: { name: string; phone: string; relation?: string } | null;
  banners: string[];
  reception: ReceptionCardView;
};

export type PersonHeaderLabels = {
  member: string;
  tester: string;
  locale: string;
  contact: string;
  acquisition: string;
  campaign: string;
  partner: string;
  companies: string;
  emergencyContact: string;
  noEmergencyContact: string;
  tags: string;
  birthOn: string;
  reception: ReceptionCardLabels;
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function PersonHeader({ view, labels }: { view: PersonHeaderView; labels: PersonHeaderLabels }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_minmax(16rem,22rem)]" data-testid="person-header">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{view.name || "—"}</h1>
          <span className="text-sm text-muted-foreground">{view.customerNumberLabel}</span>
          <Badge variant={view.overrideLabel ? "warning" : "outline"} data-testid="person-status" title={view.derivedLabel ?? undefined}>
            {view.statusLabel}
          </Badge>
          {view.isMember ? <Badge variant="success">{labels.member}</Badge> : null}
          {view.isTester ? <Badge variant="secondary">{labels.tester}</Badge> : null}
        </div>
        {view.overrideLabel || view.derivedLabel ? (
          <p className="text-sm text-muted-foreground">{[view.overrideLabel, view.derivedLabel].filter(Boolean).join(" · ")}</p>
        ) : null}
        {view.banners.map((b) => (
          <p key={b} role="status" className="rounded-md border border-warning bg-warning/15 px-3 py-2 text-sm">
            {b}
          </p>
        ))}
        {view.tags.length ? (
          <div className="flex flex-wrap gap-1" aria-label={labels.tags}>
            {view.tags.map((t) => (
              <Badge key={t.key} variant="outline" style={{ borderColor: t.color }}>
                {t.label}
              </Badge>
            ))}
          </div>
        ) : null}
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
          <Row label={labels.contact}>{[view.email, view.phone, view.address].filter(Boolean).join(" · ") || "—"}</Row>
          <Row label={labels.locale}>{view.localeLabel}</Row>
          {view.birthOn ? <Row label={labels.birthOn}>{view.birthOn}</Row> : null}
          <Row label={labels.acquisition}>{[view.acquisition.source, view.acquisition.campaign ? `${labels.campaign}: ${view.acquisition.campaign}` : null, view.acquisition.date].filter(Boolean).join(" · ") || "—"}</Row>
          {view.partner ? (
            <Row label={labels.partner}>
              <Link href={`/admin/companies/${view.partner.id}` as never} className="underline-offset-4 hover:underline">
                {view.partner.name}
              </Link>
            </Row>
          ) : null}
          {view.companies.length ? (
            <Row label={labels.companies}>
              {view.companies.map((c, i) => (
                <span key={c.id}>
                  {i > 0 ? ", " : null}
                  <Link href={`/admin/companies/${c.id}` as never} className="underline-offset-4 hover:underline">
                    {c.name}
                  </Link>
                  {c.position ? ` (${c.position})` : null}
                </span>
              ))}
            </Row>
          ) : null}
          <Row label={labels.emergencyContact}>
            {view.emergencyContact ? [view.emergencyContact.name, view.emergencyContact.phone, view.emergencyContact.relation].filter(Boolean).join(" · ") : labels.noEmergencyContact}
          </Row>
        </dl>
      </div>
      <ReceptionCard card={view.reception} labels={labels.reception} compact />
    </div>
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

/** A collapsible action block of the 360 page. */
export function ActionBlock({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="py-3">
        <details>
          <summary className="cursor-pointer text-sm font-medium">{title}</summary>
          <div className="pt-3">{children}</div>
        </details>
      </CardContent>
    </Card>
  );
}
