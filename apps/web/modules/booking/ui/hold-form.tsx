"use client";
/**
 * The capacity hold form and delete button (booking spec 5.1 `/admin/sessions/holds`, R11):
 * session, kind (staff, partner, host, speaker, blocked), places, company (partner holds) and a
 * staff note. `upsertHold` refuses a hold smaller than its bookings; `deleteHold` offers the
 * freed places to the waiting list. Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input, Textarea } from "@beam/ui";
import { deleteHold, upsertHold } from "../actions/sessions";

const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v : "");

type Kind = "staff" | "partner" | "host" | "speaker" | "blocked";

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

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function HoldForm({
  initial,
  sessions,
  companies,
  labels,
}: {
  initial: HoldFormValues;
  sessions: Array<{ id: string; label: string }>;
  companies: Array<{ id: string; label: string }>;
  labels: HoldFormLabels;
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

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      {message ? (
        <Alert variant={message.error ? "destructive" : "default"} role={message.error ? "alert" : "status"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={labels.session} required>
          <select name="sessionId" defaultValue={initial.sessionId} className={selectClass} disabled={!!initial.id} required>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.kind}>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={selectClass}>
            {(["staff", "partner", "host", "speaker", "blocked"] as const).map((k) => (
              <option key={k} value={k}>
                {labels.kinds[k]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.quantity} required>
          <Input name="quantity" type="number" min={1} defaultValue={initial.quantity} required />
        </FormField>
        <FormField label={labels.company} required={kind === "partner"}>
          <select name="companyId" defaultValue={initial.companyId} className={selectClass}>
            <option value="">{labels.none}</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label={labels.note} hint={labels.noteHint}>
        <Textarea name="note" defaultValue={initial.note} maxLength={2000} rows={2} />
      </FormField>
      <div>
        <Button type="submit" disabled={pending || sessions.length === 0}>
          {pending ? labels.saving : labels.save}
        </Button>
      </div>
    </form>
  );
}

export function DeleteHoldButton({ id, label, errors }: { id: string; label: string; errors: Record<string, string> }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
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
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
