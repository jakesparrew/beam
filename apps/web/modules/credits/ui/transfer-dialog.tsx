"use client";
/**
 * `transferCredits` (rule 34): units to another person, chosen with `PersonPicker` (also used by
 * the new-grant form), which searches through the `findCreditPersons` action.
 */
import { useState } from "react";
import { Button, FormField, Input } from "@beam/ui";
import { findCreditPersons, transferCredits } from "../actions";
import { ActionDialog, fill, ReasonField, type Labels, str } from "./adjust-dialog";

export type PickedPerson = { id: string; name: string; email: string | null };

/** Search a person by name or email; the chosen id travels in a hidden input named `name`. */
export function PersonPicker({ name, labels: l, initial, error, excludeId }: { name: string; labels: Labels; initial?: PickedPerson | null; error?: string; excludeId?: string }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickedPerson[] | null>(null);
  const [picked, setPicked] = useState<PickedPerson | null>(initial ?? null);
  const [busy, setBusy] = useState(false);

  async function search() {
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      const r = await findCreditPersons({ q });
      setResults(r.ok ? r.data.filter((p) => p.id !== excludeId).map((p) => ({ id: p.id, name: p.name, email: p.email })) : []);
    } finally {
      setBusy(false);
    }
  }

  if (picked) {
    return (
      <div className="grid gap-1">
        <input type="hidden" name={name} value={picked.id} />
        <p className="text-sm font-medium">{l["admin.person_picker.label"]}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{fill(l["admin.person_picker.selected"], { name: picked.email ? `${picked.name} (${picked.email})` : picked.name })}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(null)}>
            {l["admin.person_picker.change"]}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <input type="hidden" name={name} value="" />
      <FormField label={l["admin.person_picker.label"]} hint={l["admin.person_picker.search"]} error={error ?? null} required>
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
        />
      </FormField>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => void search()} disabled={busy}>
          {l["admin.person_picker.find"]}
        </Button>
      </div>
      {results ? (
        results.length ? (
          <ul className="grid gap-1" aria-live="polite">
            {results.map((p) => (
              <li key={p.id}>
                <Button type="button" variant="ghost" className="h-auto w-full justify-start py-2 text-left" onClick={() => setPicked(p)}>
                  <span className="font-medium">{p.name}</span>
                  {p.email ? <span className="ml-2 text-muted-foreground">{p.email}</span> : null}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {l["admin.person_picker.no_results"]}
          </p>
        )
      ) : null}
    </div>
  );
}

export function TransferDialog({ grantId, ownerPersonId, maxUnits, labels: l }: { grantId: string; ownerPersonId: string; maxUnits: number; labels: Labels }) {
  return (
    <ActionDialog
      trigger={l["admin.transfer.open"]!}
      title={l["admin.transfer.title"]!}
      description={l["admin.transfer.description"]}
      submitLabel={l["admin.transfer.submit"]!}
      labels={l}
      onSubmit={(f, clientKey) =>
        transferCredits({
          grantId,
          toPersonId: str(f, "toPersonId", ""),
          units: Number(f.get("units")),
          reason: str(f, "reason", ""),
          clientKey,
        })
      }
    >
      {(fields) => (
        <>
          <PersonPicker name="toPersonId" labels={l} excludeId={ownerPersonId} error={fields.toPersonId} />
          <FormField label={l["admin.transfer.units"]} error={fields.units ?? null} required>
            <Input name="units" type="number" min={1} max={maxUnits} step={1} required inputMode="numeric" />
          </FormField>
          <ReasonField labels={l} error={fields.reason} />
        </>
      )}
    </ActionDialog>
  );
}
