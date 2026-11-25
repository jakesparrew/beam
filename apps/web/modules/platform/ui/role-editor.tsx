"use client";
/**
 * Roles screens (`/admin/settings/roles`, `/admin/settings/roles/[key]`; PL-16, PL-18, owner's
 * review section 11): the permission checklist of one role, grouped by module with a plain
 * sentence per permission and a warning mark on the dangerous ones; the form that creates a
 * custom role; rename and delete of a custom role. A permission the actor does not hold is only
 * granted by an Administrator (the server enforces it); the Administrator role is read-only.
 * Saving shows the changes first.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Checkbox, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input } from "@beam/ui";
import { createRole, deleteRole, renameRole, updateRolePermissions } from "../actions";
import { formValue } from "./login-form";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

export type PermissionGroup = { module: string; label: string; permissions: { key: string; description: string; dangerous: boolean }[] };

export function RoleEditor({
  roleKey,
  granted,
  groups,
  actorPermissions,
  actorIsOwner,
  readOnly,
  labels,
  errors,
}: {
  roleKey: string;
  granted: string[];
  groups: PermissionGroup[];
  /** The actor's own permissions: anything else is only granted by an Administrator. */
  actorPermissions: string[];
  actorIsOwner: boolean;
  readOnly: boolean;
  labels: Labels;
  errors: Labels;
}) {
  const [selected, setSelected] = useState(() => new Set(granted));
  const [confirming, setConfirming] = useState(false);
  const r = useRun(errors);
  const describe = useMemo(() => new Map(groups.flatMap((g) => g.permissions.map((p) => [p.key, p.description || p.key] as const))), [groups]);
  const diff = useMemo(() => {
    const before = new Set(granted);
    return { added: [...selected].filter((p) => !before.has(p)).sort(), removed: granted.filter((p) => !selected.has(p)).sort() };
  }, [granted, selected]);
  const own = useMemo(() => new Set(actorPermissions), [actorPermissions]);

  const toggle = (key: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <div className="grid gap-6">
      {groups.map((g) => (
        <fieldset key={g.module} className="grid gap-3 rounded-md border p-4" disabled={readOnly}>
          <legend className="px-1 text-sm font-semibold">{g.label}</legend>
          {g.permissions.map((p) => {
            const locked = !actorIsOwner && !own.has(p.key) && !granted.includes(p.key);
            const id = `perm-${p.key}`;
            return (
              <div key={p.key} className="flex items-start gap-3">
                <Checkbox id={id} checked={readOnly || selected.has(p.key)} disabled={readOnly || locked} onCheckedChange={(v) => toggle(p.key, v === true)} />
                <label htmlFor={id} className="grid gap-1 text-sm" title={p.key}>
                  <span>
                    {p.description || p.key}
                    {locked ? <span className="text-muted-foreground"> ({lab(labels, "owner_only")})</span> : null}
                  </span>
                  {p.dangerous ? (
                    <span className="flex items-center gap-2">
                      <Badge variant="warning">{lab(labels, "dangerous")}</Badge>
                      <span className="text-xs text-muted-foreground">{lab(labels, "dangerous_hint")}</span>
                    </span>
                  ) : null}
                </label>
              </div>
            );
          })}
        </fieldset>
      ))}
      <Feedback ok={r.ok} error={r.error} />
      {readOnly ? null : (
        <div>
          <Button type="button" disabled={r.pending || (diff.added.length === 0 && diff.removed.length === 0)} onClick={() => setConfirming(true)}>
            {lab(labels, "save")}
          </Button>
        </div>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{lab(labels, "confirm_title")}</DialogTitle>
            <DialogDescription>{lab(labels, "confirm_description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            {diff.added.length ? (
              <div>
                <strong>{lab(labels, "added")}:</strong>
                <ul className="list-disc pl-5">
                  {diff.added.map((p) => (
                    <li key={p}>{describe.get(p) ?? p}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {diff.removed.length ? (
              <div>
                <strong>{lab(labels, "removed")}:</strong>
                <ul className="list-disc pl-5">
                  {diff.removed.map((p) => (
                    <li key={p}>{describe.get(p) ?? p}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {lab(labels, "cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={r.pending}
              onClick={() => void r.run(() => updateRolePermissions({ roleKey, permissions: [...selected] }), lab(labels, "saved"), () => setConfirming(false))}
            >
              {lab(labels, "confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Creates a custom role and opens it, so the administrator ticks its permissions next. */
export function CreateRoleForm({ labels, errors }: { labels: Labels; errors: Labels }) {
  const r = useRun(errors);
  const router = useRouter();
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const description = formValue(form, "description");
    await r.run(
      () => createRole({ name: formValue(form, "name"), ...(description ? { description } : {}) }),
      lab(labels, "created"),
      (data) => router.push(`/admin/settings/roles/${data.roleKey}`),
    );
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-2xl gap-3 rounded-md border p-4" noValidate aria-labelledby="new-role-title">
      <h2 id="new-role-title" className="text-lg font-medium">
        {lab(labels, "new_title")}
      </h2>
      <p className="text-sm text-muted-foreground">{lab(labels, "new_intro")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lab(labels, "name")}>
          <Input name="name" required minLength={2} maxLength={60} />
        </FormField>
        <FormField label={lab(labels, "description")}>
          <Input name="description" maxLength={300} />
        </FormField>
      </div>
      <Feedback ok={r.ok} error={r.error} />
      <div>
        <Button type="submit" disabled={r.pending}>
          {lab(labels, "create")}
        </Button>
      </div>
    </form>
  );
}

/** Rename and delete of a custom role; deleting a role someone still holds is refused. */
export function CustomRoleDetails({ role, labels, errors }: { role: { key: string; name: string; description: string; holders: number }; labels: Labels; errors: Labels }) {
  const rename = useRun(errors);
  const remove = useRun(errors);
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await rename.run(() => renameRole({ roleKey: role.key, name: formValue(form, "name"), description: formValue(form, "description") }), lab(labels, "renamed"));
  }
  return (
    <div className="grid max-w-2xl gap-4 rounded-md border p-4">
      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-3" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={lab(labels, "name")}>
            <Input name="name" required minLength={2} maxLength={60} defaultValue={role.name} />
          </FormField>
          <FormField label={lab(labels, "description")}>
            <Input name="description" maxLength={300} defaultValue={role.description} />
          </FormField>
        </div>
        <Feedback ok={rename.ok} error={rename.error} />
        <div>
          <Button type="submit" variant="outline" disabled={rename.pending}>
            {lab(labels, "rename")}
          </Button>
        </div>
      </form>
      <div className="grid gap-2 border-t pt-4">
        <p className="text-sm text-muted-foreground">{role.holders > 0 ? lab(labels, "delete_blocked", { count: role.holders }) : lab(labels, "delete_intro")}</p>
        <Feedback ok={null} error={remove.error} />
        <div>
          <Button type="button" variant="destructive" disabled={remove.pending} onClick={() => setConfirming(true)}>
            {lab(labels, "delete")}
          </Button>
        </div>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{lab(labels, "delete_confirm_title", { name: role.name })}</DialogTitle>
            <DialogDescription>{lab(labels, "delete_confirm_description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {lab(labels, "cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.pending}
              onClick={() =>
                void remove.run(
                  () => deleteRole({ roleKey: role.key }),
                  null,
                  () => router.push("/admin/settings/roles"),
                ).then(() => setConfirming(false))
              }
            >
              {lab(labels, "delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
