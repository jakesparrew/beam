"use client";
/**
 * Permission checklist of one role (`/admin/settings/roles/[key]`, PL-16, PL-18), grouped by
 * module with the catalogue descriptions. `persons.sensitive_read` is disabled unless the actor
 * is an owner; the owner role is read-only ("all permissions"). Saving shows the diff first.
 */
import { useMemo, useState } from "react";
import { Button, Checkbox, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@beam/ui";
import { updateRolePermissions } from "../actions";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

export type PermissionGroup = { module: string; label: string; permissions: { key: string; description: string }[] };

export function RoleEditor({
  roleKey,
  granted,
  groups,
  actorIsOwner,
  readOnly,
  labels,
  errors,
}: {
  roleKey: string;
  granted: string[];
  groups: PermissionGroup[];
  actorIsOwner: boolean;
  readOnly: boolean;
  labels: Labels;
  errors: Labels;
}) {
  const [selected, setSelected] = useState(() => new Set(granted));
  const [confirming, setConfirming] = useState(false);
  const r = useRun(errors);
  const diff = useMemo(() => {
    const before = new Set(granted);
    return { added: [...selected].filter((p) => !before.has(p)).sort(), removed: granted.filter((p) => !selected.has(p)).sort() };
  }, [granted, selected]);

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
        <fieldset key={g.module} className="grid gap-2 rounded-md border p-4" disabled={readOnly}>
          <legend className="px-1 text-sm font-semibold">{g.label}</legend>
          {g.permissions.map((p) => {
            const locked = p.key === "persons.sensitive_read" && !actorIsOwner;
            const id = `perm-${p.key}`;
            return (
              <div key={p.key} className="flex items-start gap-3">
                <Checkbox id={id} checked={readOnly || selected.has(p.key)} disabled={readOnly || locked} onCheckedChange={(v) => toggle(p.key, v === true)} />
                <label htmlFor={id} className="grid gap-0.5 text-sm">
                  <span className="font-mono text-xs">{p.key}</span>
                  <span className="text-muted-foreground">
                    {p.description}
                    {locked ? ` (${lab(labels, "owner_only")})` : ""}
                  </span>
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
          <div className="grid gap-2 text-sm">
            {diff.added.length ? (
              <p>
                <strong>{lab(labels, "added")}:</strong> <span className="font-mono text-xs">{diff.added.join(", ")}</span>
              </p>
            ) : null}
            {diff.removed.length ? (
              <p>
                <strong>{lab(labels, "removed")}:</strong> <span className="font-mono text-xs">{diff.removed.join(", ")}</span>
              </p>
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
