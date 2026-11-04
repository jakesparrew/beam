"use client";
/**
 * The task form (crm spec 5.1: `/admin/tasks`, the company page and the person 360 "Add task").
 * Create or edit; the related person or company is fixed by the caller. Without `tasks.all` the
 * owner is the signed-in user only (rule 3.42), and the form says so.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Textarea } from "@beam/ui";
import { createTask, updateTask } from "../actions";

export type TaskFormLabels = {
  titleNew: string;
  titleEdit: string;
  title: string;
  kind: string;
  due: string;
  priority: string;
  owner: string;
  notes: string;
  ownOnly: string;
  save: string;
  saving: string;
  cancel: string;
  error: string;
  forbidden: string;
};

export type TaskFormValues = {
  id?: string;
  title: string;
  kind: string;
  /** `YYYY-MM-DDTHH:mm` in Brussels time, or empty. */
  dueLocal: string;
  priority: string;
  ownerUserId: string;
  notes: string;
  /** The edited task's own relations (kept on save). */
  personId?: string | null;
  companyId?: string | null;
};

type Option = { value: string; label: string };

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Brussels wall time `YYYY-MM-DDTHH:mm` to a UTC ISO string (DST-aware, without a date library). */
export function brusselsLocalToIso(local: string): string | undefined {
  if (!local) return undefined;
  const asUtc = new Date(`${local}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(asUtc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const offset = shown - asUtc.getTime();
  return new Date(asUtc.getTime() - offset).toISOString();
}

export function TaskForm({
  initial,
  personId,
  companyId,
  canAssignOthers,
  owners,
  kinds,
  priorities,
  labels,
  onDone,
}: {
  initial: TaskFormValues;
  personId?: string;
  companyId?: string;
  canAssignOthers: boolean;
  owners: Option[];
  kinds: Option[];
  priorities: Option[];
  labels: TaskFormLabels;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const get = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const dueAt = brusselsLocalToIso(get("dueLocal"));
    const relatedPerson = initial.id ? initial.personId : personId;
    const relatedCompany = initial.id ? initial.companyId : companyId;
    const body = {
      title: get("title"),
      kind: get("kind"),
      priority: get("priority"),
      ownerUserId: canAssignOthers ? get("ownerUserId") : initial.ownerUserId,
      ...(dueAt ? { dueAt } : {}),
      ...(relatedPerson ? { personId: relatedPerson } : {}),
      ...(relatedCompany ? { companyId: relatedCompany } : {}),
      ...(get("notes") ? { notes: get("notes") } : {}),
    };
    setPending(true);
    setError(null);
    try {
      const result = initial.id ? await updateTask({ ...body, id: initial.id }) : await createTask(body);
      if (result.ok) {
        onDone?.();
        router.refresh();
        return;
      }
      setError(result.error.code === "forbidden" ? labels.forbidden : labels.error);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial.id ? labels.titleEdit : labels.titleNew}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <FormField label={labels.title} required>
            <Input name="title" defaultValue={initial.title} maxLength={200} required />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={labels.kind}>
              <select name="kind" defaultValue={initial.kind} className={selectClass}>
                {kinds.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={labels.priority}>
              <select name="priority" defaultValue={initial.priority} className={selectClass}>
                {priorities.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={labels.due}>
              <Input type="datetime-local" name="dueLocal" defaultValue={initial.dueLocal} />
            </FormField>
          </div>
          <FormField label={labels.owner} hint={canAssignOthers ? undefined : labels.ownOnly}>
            <select name="ownerUserId" defaultValue={initial.ownerUserId} className={selectClass} disabled={!canAssignOthers}>
              {owners.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={labels.notes}>
            <Textarea name="notes" defaultValue={initial.notes} maxLength={5000} rows={3} />
          </FormField>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? labels.saving : labels.save}
            </Button>
            {onDone ? (
              <Button type="button" variant="outline" onClick={onDone}>
                {labels.cancel}
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
