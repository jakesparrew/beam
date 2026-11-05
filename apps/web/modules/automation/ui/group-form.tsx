"use client";
/**
 * The group editor of `/admin/automations/groups` (automation spec 5, R2, automation-P7): a
 * "New group" or "Edit" dialog posting `upsertGroup` (key, name, description, exclusive, lane,
 * priority). The key is fixed once the group exists, so the edit dialog shows it read-only.
 * Field errors come back from the action's `fields` and are shown under their field in the
 * catalogue's words; other errors in an alert. Refreshes the page on success.
 */
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FormField,
  Input,
  Textarea,
} from "@beam/ui";
import { upsertGroup } from "../actions";
import { errorText, fill, formStr, type ActionResultLike, type Labels } from "./outcome-badge";

export type GroupFormValue = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isExclusive: boolean;
  lane: string | null;
  priority: number;
};

export type GroupFormDialogProps = {
  /** Absent: the "New group" dialog. */
  group?: GroupFormValue;
  labels: Labels;
};

/** The words for a field error code (`group_key`, `lane`, ...), else the generic validation text. */
function fieldText(code: string | undefined, l: Labels): string | null {
  if (!code) return null;
  return l[`errors.${code}`] ?? l["errors.validation"] ?? code;
}

export function GroupFormDialog({ group, labels: l }: GroupFormDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const exclusiveId = useId();
  const exclusiveHelpId = useId();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const lane = formStr(form, "lane").trim();
    const description = formStr(form, "description").trim();
    const input = {
      ...(group ? { id: group.id } : {}),
      key: group ? group.key : formStr(form, "key").trim(),
      name: formStr(form, "name"),
      ...(description ? { description } : {}),
      isExclusive: form.get("isExclusive") === "on",
      lane: lane || null,
      priority: Number(formStr(form, "priority")),
    };
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const r = (await upsertGroup(input)) as ActionResultLike;
      if (!r.ok) {
        if (r.error.fields && Object.keys(r.error.fields).length) setFields(r.error.fields);
        else setError(errorText(r.error, l));
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setError(null);
          setFields({});
        }
      }}
    >
      <DialogTrigger asChild>
        {group ? (
          <Button variant="outline" size="sm" aria-label={fill(l["groups.edit_named"], { name: group.name })} data-testid={`group-edit-${group.key}`}>
            {l["groups.edit"]}
          </Button>
        ) : (
          <Button data-testid="group-new">{l["groups.new"]}</Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4" data-testid="group-form">
          <DialogHeader>
            <DialogTitle>{group ? l["groups.form_edit_title"] : l["groups.form_new_title"]}</DialogTitle>
            <DialogDescription>{l["groups.form_body"]}</DialogDescription>
          </DialogHeader>
          <FormField label={l["groups.field_key"]} hint={group ? undefined : l["groups.field_key_help"]} error={fieldText(fields.key, l)} required={!group}>
            <Input name="key" defaultValue={group?.key ?? ""} readOnly={!!group} autoComplete="off" pattern="[a-z][a-z0-9_]*" className="font-mono" />
          </FormField>
          <FormField label={l["groups.field_name"]} error={fieldText(fields.name, l)} required>
            <Input name="name" defaultValue={group?.name ?? ""} required maxLength={160} />
          </FormField>
          <FormField label={l["groups.field_description"]} error={fieldText(fields.description, l)}>
            <Textarea name="description" defaultValue={group?.description ?? ""} maxLength={2000} rows={2} />
          </FormField>
          <div className="grid gap-1">
            <div className="flex items-center gap-2">
              <input
                id={exclusiveId}
                type="checkbox"
                name="isExclusive"
                defaultChecked={group?.isExclusive ?? false}
                aria-describedby={exclusiveHelpId}
                className="size-4 rounded border-input accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              <label htmlFor={exclusiveId} className="text-sm font-medium">
                {l["groups.field_exclusive"]}
              </label>
            </div>
            <p id={exclusiveHelpId} className="text-xs text-muted-foreground">
              {l["groups.field_exclusive_help"]}
            </p>
          </div>
          <FormField label={l["groups.field_lane"]} hint={l["groups.field_lane_help"]} error={fieldText(fields.lane, l)}>
            <Input name="lane" defaultValue={group?.lane ?? ""} autoComplete="off" className="font-mono" />
          </FormField>
          <FormField label={l["groups.field_priority"]} hint={l["groups.field_priority_help"]} error={fieldText(fields.priority, l)} required>
            <Input name="priority" type="number" min={0} max={1000} step={1} defaultValue={group?.priority ?? 100} required />
          </FormField>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {l["common.cancel"]}
            </Button>
            <Button type="submit" disabled={busy} data-testid="group-save">
              {busy ? l["common.saving"] : l["groups.save"]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
