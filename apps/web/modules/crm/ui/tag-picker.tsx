"use client";
/**
 * Tags in the back office (crm spec 5.1): `TagPicker` adds or removes one tag for the selected
 * persons (at most 5000), `TagsManager` is `/admin/persons/tags` (create, rename in three
 * locales, recolour, delete non-system tags). Every string is a prop.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FormField,
  Input,
  LocalizedInput,
  type DataTableColumn,
  type LocalizedInputLabels,
} from "@beam/ui";
import { createTag, deleteTag, tagPersons, untagPersons, updateTag } from "../actions";

export type TagOption = { id: string; key: string; label: string; color: string };

export type TagPickerLabels = { tag: string; add: string; remove: string; choose: string; changed: string; limit: string; error: string };

export function TagPicker({ tags, selected, labels, onDone }: { tags: TagOption[]; selected: string[]; labels: TagPickerLabels; onDone?: () => void }) {
  const router = useRouter();
  const [tagId, setTagId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const tooMany = selected.length > 5000;

  async function run(kind: "add" | "remove") {
    if (!tagId || !selected.length || tooMany) return;
    setPending(true);
    const result = await (kind === "add" ? tagPersons : untagPersons)({ tagId, personIds: selected });
    setPending(false);
    if (result.ok) {
      setMessage(`${labels.changed} (${result.data.changed})`);
      onDone?.();
      router.refresh();
    } else setMessage(labels.error);
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="tag-picker">
      <label className="sr-only" htmlFor="bulk-tag">
        {labels.tag}
      </label>
      <select
        id="bulk-tag"
        value={tagId}
        onChange={(e) => setTagId(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
      >
        <option value="">{labels.choose}</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <Button type="button" size="sm" disabled={pending || !tagId || !selected.length || tooMany} onClick={() => void run("add")}>
        {labels.add}
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={pending || !tagId || !selected.length || tooMany} onClick={() => void run("remove")}>
        {labels.remove}
      </Button>
      {tooMany ? <span role="status">{labels.limit}</span> : message ? <span role="status">{message}</span> : null}
    </div>
  );
}

export type TagView = { id: string; key: string; name: Record<string, string | undefined>; color: string; description: string | null; isSystem: boolean; count: number };

export type TagsManagerLabels = {
  title: string;
  empty: string;
  colKey: string;
  colName: string;
  colColor: string;
  colCount: string;
  colSystem: string;
  actions: string;
  create: string;
  rename: string;
  recolour: string;
  delete: string;
  description: string;
  systemLocked: string;
  keyHint: string;
  save: string;
  cancel: string;
  yes: string;
  no: string;
  missingLocales: string;
  keyTaken: string;
  error: string;
  pagination: string;
  previous: string;
  next: string;
  localized: LocalizedInputLabels;
};

type Editing = { mode: "create" } | { mode: "edit"; tag: TagView };

export function TagsManager({ tags, canEdit, locale, labels }: { tags: TagView[]; canEdit: boolean; locale: string; labels: TagsManagerLabels }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [name, setName] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const open = (e: Editing) => {
    setEditing(e);
    setName(e.mode === "edit" ? { ...e.tag.name } : {});
    setError(null);
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const str = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string).trim() : "");
    const input = { key: str("key"), name, color: str("color").toLowerCase(), ...(str("description") ? { description: str("description") } : {}) };
    setPending(true);
    const result = editing.mode === "create" ? await createTag(input) : await updateTag({ ...input, id: editing.tag.id });
    setPending(false);
    if (result.ok) {
      setEditing(null);
      router.refresh();
    } else if (result.error.code === "conflict" && result.error.message === "tag_key_taken") setError(labels.keyTaken);
    else if (result.error.code === "conflict") setError(labels.systemLocked);
    else if (result.error.code === "validation" && Object.keys(result.error.fields ?? {}).some((f) => f.startsWith("name"))) setError(labels.missingLocales);
    else setError(labels.error);
  }

  async function remove(tag: TagView) {
    setPending(true);
    const result = await deleteTag({ id: tag.id });
    setPending(false);
    if (result.ok) router.refresh();
    else setError(result.error.code === "conflict" ? labels.systemLocked : labels.error);
  }

  const label = (t: TagView) => t.name[locale] ?? t.key;
  const columns: DataTableColumn<TagView>[] = [
    { key: "key", header: labels.colKey, className: "font-mono text-xs", cell: (t) => t.key },
    {
      key: "name",
      header: labels.colName,
      cell: (t) => (
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="inline-block size-3 rounded-full" style={{ backgroundColor: t.color }} />
          {label(t)}
        </span>
      ),
    },
    { key: "color", header: labels.colColor, className: "font-mono text-xs", cell: (t) => t.color },
    { key: "count", header: labels.colCount, align: "right", cell: (t) => t.count },
    { key: "system", header: labels.colSystem, cell: (t) => (t.isSystem ? <Badge variant="secondary">{labels.yes}</Badge> : labels.no) },
  ];
  if (canEdit) {
    columns.push({
      key: "actions",
      header: labels.actions,
      cell: (t) => (
        <span className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => open({ mode: "edit", tag: t })}>
            {labels.rename}
          </Button>
          {t.isSystem ? null : (
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => void remove(t)}>
              {labels.delete}
            </Button>
          )}
        </span>
      ),
    });
  }

  return (
    <div className="grid gap-4">
      {canEdit ? (
        <div>
          <Button type="button" onClick={() => open({ mode: "create" })}>
            {labels.create}
          </Button>
        </div>
      ) : null}
      {error && !editing ? <p role="status">{error}</p> : null}
      <DataTable
        columns={columns}
        rows={tags}
        rowKey={(t) => t.id}
        emptyState={<EmptyState title={labels.empty} />}
        labels={{ pagination: labels.pagination, previous: labels.previous, next: labels.next }}
      />
      <Dialog open={!!editing} onOpenChange={(o) => (o ? null : setEditing(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.mode === "edit" ? labels.rename : labels.create}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => void save(e)} className="grid gap-4">
            <FormField label={labels.colKey} hint={labels.keyHint} required>
              <Input
                name="key"
                defaultValue={editing?.mode === "edit" ? editing.tag.key : ""}
                readOnly={editing?.mode === "edit" && editing.tag.isSystem}
                pattern="[a-z0-9][a-z0-9_:\-]{1,62}"
                required
              />
            </FormField>
            <LocalizedInput name="name" value={name} onChange={setName} locales={["nl-BE", "fr-BE", "en"] as const} labels={labels.localized} />
            <FormField label={labels.recolour}>
              <Input name="color" type="color" defaultValue={editing?.mode === "edit" ? editing.tag.color : "#64748b"} />
            </FormField>
            <FormField label={labels.description}>
              <Input name="description" defaultValue={editing?.mode === "edit" ? (editing.tag.description ?? "") : ""} maxLength={500} />
            </FormField>
            {error ? <p role="status">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                {labels.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {labels.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
