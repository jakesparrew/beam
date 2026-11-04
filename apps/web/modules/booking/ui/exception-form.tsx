"use client";
/**
 * The exception form and delete button (booking spec 5.1 `/admin/sessions/exceptions`, R4):
 * closed day, public holiday or special opening hours, for every template or a selection.
 * `upsertException` returns the sessions of that date that keep live bookings; they are shown
 * as conflicts (nothing is cancelled automatically). Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, Label, LocalizedInput, Textarea, type LocalizedInputLabels, type LocalizedValue } from "@beam/ui";
import { deleteException, upsertException } from "../actions/templates";

type Locale = "nl-BE" | "fr-BE" | "en";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];
type Kind = "closed" | "holiday" | "special_hours";

export type ExceptionFormValues = {
  id?: string;
  onDate: string;
  kind: Kind;
  templateIds: string[];
  opensAt: string;
  closesAt: string;
  name: LocalizedValue<Locale>;
  note: string;
};

export type ExceptionFormLabels = {
  date: string;
  kind: string;
  kinds: Record<Kind, string>;
  templates: string;
  allTemplates: string;
  opensAt: string;
  closesAt: string;
  name: LocalizedInputLabels<Locale>;
  note: string;
  noteHint: string;
  save: string;
  saving: string;
  saved: string;
  delete: string;
  conflictsTitle: string;
  errors: Record<string, string>;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A conflict line resolved by the page with `{time}` left in and the count rendered as `999`
 * (`one` for a single booking), e.g. "{time}: 999 bookings".
 */
export type ConflictLabels = { one: string; other: string };

export function conflictLine(labels: ConflictLabels, time: string, count: number): string {
  return (count === 1 ? labels.one : labels.other).replace("{time}", time).replace("999", String(count));
}

export function ExceptionForm({
  initial,
  templates,
  labels,
  conflictLabels,
}: {
  initial: ExceptionFormValues;
  templates: Array<{ id: string; label: string }>;
  labels: ExceptionFormLabels;
  conflictLabels: ConflictLabels;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>(initial.kind);
  const [name, setName] = useState(initial.name);
  const [selected, setSelected] = useState<string[]>(initial.templateIds);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ conflicts: Array<{ startsAt: Date; liveBookings: number }> } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (k: string) => String(form.get(k) ?? "").trim();
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await upsertException({
        ...(initial.id ? { id: initial.id } : {}),
        onDate: text("onDate"),
        kind,
        templateIds: selected.length ? selected : null,
        opensAt: kind === "special_hours" ? text("opensAt") : null,
        closesAt: kind === "special_hours" ? text("closesAt") : null,
        name,
        note: text("note") || null,
      });
      if (!res.ok) {
        const reason = res.error.code === "conflict" ? res.error.message : res.error.code;
        setError(labels.errors[reason] ?? labels.errors.validation ?? reason);
        return;
      }
      setResult({ conflicts: res.data.conflicts });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const time = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d));

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {result ? (
        <Alert role="status">
          <AlertDescription>
            <p>{labels.saved}</p>
            {result.conflicts.length ? (
              <>
                <p className="mt-2 font-medium">{labels.conflictsTitle}</p>
                <ul className="list-disc pl-4">
                  {result.conflicts.map((c) => (
                    <li key={String(c.startsAt)}>{conflictLine(conflictLabels, time(c.startsAt), c.liveBookings)}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={labels.date} required>
          <Input name="onDate" type="date" defaultValue={initial.onDate} required />
        </FormField>
        <FormField label={labels.kind}>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={selectClass}>
            {(["closed", "holiday", "special_hours"] as const).map((k) => (
              <option key={k} value={k}>
                {labels.kinds[k]}
              </option>
            ))}
          </select>
        </FormField>
        {kind === "special_hours" ? (
          <div className="grid grid-cols-2 gap-2">
            <FormField label={labels.opensAt} required>
              <Input name="opensAt" type="time" defaultValue={initial.opensAt} required />
            </FormField>
            <FormField label={labels.closesAt} required>
              <Input name="closesAt" type="time" defaultValue={initial.closesAt} required />
            </FormField>
          </div>
        ) : null}
      </div>
      <LocalizedInput name="name" value={name} onChange={setName} locales={LOCALES} labels={labels.name} />
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{labels.templates}</legend>
        <p className="text-xs text-muted-foreground">{labels.allTemplates}</p>
        <div className="flex flex-wrap gap-3">
          {templates.map((t) => (
            <Label key={t.id} className="flex min-h-11 items-center gap-2">
              <Checkbox checked={selected.includes(t.id)} onCheckedChange={(on) => setSelected((cur) => (on === true ? [...cur, t.id] : cur.filter((x) => x !== t.id)))} />
              {t.label}
            </Label>
          ))}
        </div>
      </fieldset>
      <FormField label={labels.note} hint={labels.noteHint}>
        <Textarea name="note" defaultValue={initial.note} maxLength={2000} rows={2} />
      </FormField>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? labels.saving : labels.save}
        </Button>
      </div>
    </form>
  );
}

export function DeleteExceptionButton({ id, label, error }: { id: string; label: string; error: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void deleteException({ id })
            .then((res) => {
              setFailed(!res.ok);
              if (res.ok) router.refresh();
            })
            .finally(() => setPending(false));
        }}
      >
        {label}
      </Button>
      {failed ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
