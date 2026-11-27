"use client";
/**
 * The blocked-places form and delete button (booking spec 5.1 `/admin/sessions/holds`, R11):
 * places held for staff, partners, hosts or speakers, or blocked, with a company (partner holds)
 * and a staff note. `inline` is the one-row form of the session page, where the session is
 * already known (places, kind, note, save); the holds page shows the session picker too.
 * `upsertHold` refuses a hold smaller than its bookings; `deleteHold` offers the freed places to
 * the waiting list. Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, FormField, Input, cn } from "@beam/ui";
import { deleteHold, upsertHold } from "../actions/sessions";

const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v : "");

type Kind = "staff" | "partner" | "host" | "speaker" | "blocked";
const KINDS = ["staff", "partner", "host", "speaker", "blocked"] as const;

export type HoldFormValues = { id?: string; sessionId: string; kind: Kind; quantity: number; companyId: string; note: string };

export type HoldFormLabels = {
  session: string;
  kind: string;
  kinds: Record<Kind, string>;
  quantity: string;
  company: string;
  none: string;
  note: string;
  noteHint: string;
  save: string;
  saving: string;
  saved: string;
  errors: Record<string, string>;
};

const control = "h-9 rounded-lg border border-input bg-card px-2.5 text-[0.8125rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function HoldForm({
  initial,
  sessions,
  companies,
  labels,
  inline = false,
}: {
  initial: HoldFormValues;
  sessions: Array<{ id: string; label: string }>;
  companies: Array<{ id: string; label: string }>;
  labels: HoldFormLabels;
  inline?: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>(initial.kind);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (k: string) => str(f.get(k)).trim();
    setPending(true);
    setMessage(null);
    try {
      const res = await upsertHold({
        ...(initial.id ? { id: initial.id } : {}),
        sessionId: initial.id ? initial.sessionId : text("sessionId"),
        kind,
        quantity: Number(text("quantity")),
        companyId: text("companyId") || null,
        note: text("note") || null,
      });
      if (res.ok) {
        setMessage({ error: false, text: labels.saved });
        router.refresh();
      } else {
        const reason = res.error.code === "conflict" ? res.error.message : res.error.code;
        setMessage({ error: true, text: labels.errors[reason] ?? labels.errors.validation ?? reason });
      }
    } finally {
      setPending(false);
    }
  }

  const status = message ? (
    <p role={message.error ? "alert" : "status"} className={cn("text-[0.75rem] font-medium", message.error ? "text-[var(--status-bad)]" : "text-[var(--status-ok)]")}>
      {message.text}
    </p>
  ) : null;
  const kindSelect = (
    <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={cn(control, "w-full")}>
      {KINDS.map((k) => (
        <option key={k} value={k}>
          {labels.kinds[k]}
        </option>
      ))}
    </select>
  );
  const companySelect = (
    <select name="companyId" defaultValue={initial.companyId} className={cn(control, "w-full")}>
      <option value="">{labels.none}</option>
      {companies.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}
        </option>
      ))}
    </select>
  );

  if (inline) {
    // The session page: the session is known, so one row (places, kind, note) and the save button.
    return (
      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-1.5" noValidate>
        <input type="hidden" name="sessionId" value={initial.sessionId} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-[0.75rem] font-medium text-muted-foreground">
            {labels.quantity}
            <Input name="quantity" type="number" min={1} defaultValue={initial.quantity} required className="h-9 w-20 bg-card tabular-nums" />
          </label>
          <label className="grid gap-1 text-[0.75rem] font-medium text-muted-foreground">
            {labels.kind}
            {kindSelect}
          </label>
          {companies.length ? (
            <label className="grid gap-1 text-[0.75rem] font-medium text-muted-foreground">
              {labels.company}
              {companySelect}
            </label>
          ) : null}
          <label className="grid min-w-48 flex-1 gap-1 text-[0.75rem] font-medium text-muted-foreground">
            {labels.note}
            <Input name="note" defaultValue={initial.note} maxLength={2000} aria-describedby="hold-note-hint" className="h-9 bg-card" />
          </label>
          <Button type="submit" className="h-9" disabled={pending}>
            {pending ? labels.saving : labels.save}
          </Button>
        </div>
        <p id="hold-note-hint" className="text-[0.75rem] text-muted-foreground">
          {labels.noteHint}
        </p>
        {status}
      </form>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_6rem_minmax(0,1fr)]">
        <FormField label={labels.session} required>
          <select name="sessionId" defaultValue={initial.sessionId} className={cn(control, "w-full")} disabled={!!initial.id} required>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.kind}>{kindSelect}</FormField>
        <FormField label={labels.quantity} required>
          <Input name="quantity" type="number" min={1} defaultValue={initial.quantity} required className="h-9 tabular-nums" />
        </FormField>
        <FormField label={labels.company} required={kind === "partner"}>
          {companySelect}
        </FormField>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <FormField label={labels.note} className="min-w-64 flex-1">
          <Input name="note" defaultValue={initial.note} maxLength={2000} aria-describedby="hold-note-hint" className="h-9" />
        </FormField>
        <Button type="submit" className="h-9" disabled={pending || sessions.length === 0}>
          {pending ? labels.saving : labels.save}
        </Button>
      </div>
      <p id="hold-note-hint" className="text-[0.75rem] text-muted-foreground">
        {labels.noteHint}
      </p>
      {status}
    </form>
  );
}

export function DeleteHoldButton({ id, label, errors }: { id: string; label: string; errors: Record<string, string> }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      {error ? (
        <span role="alert" className="text-[0.75rem] text-[var(--status-bad)]">
          {error}
        </span>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 text-muted-foreground hover:text-[var(--status-bad)]"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError(null);
          void deleteHold({ id })
            .then((res) => {
              if (res.ok) router.refresh();
              else setError(errors[res.error.code === "conflict" ? res.error.message : res.error.code] ?? res.error.code);
            })
            .finally(() => setPending(false));
        }}
      >
        {label}
      </Button>
    </span>
  );
}
