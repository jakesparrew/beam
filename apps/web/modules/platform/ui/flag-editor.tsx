"use client";
/**
 * One feature flag (`/admin/settings/flags`, PL-43): state radio (off, testers, on), the staff
 * testers (checkboxes of staff users) and the customer testers (person ids; the crm person
 * search fills them once crm's `searchPersons` is built, until then an id field), plus the
 * customer tester switch (`setCustomerTester`, writes `persons.is_tester` through crm).
 */
import { useState, type FormEvent } from "react";
import { Button, Checkbox, FormField, Input, RadioGroup, RadioGroupItem, Textarea } from "@beam/ui";
import { setCustomerTester, updateFlag } from "../actions";
import { formValue } from "./login-form";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

export type FlagEditorRow = { key: string; owner: string; description: string; state: "off" | "testers" | "on"; userIds: string[]; personIds: string[]; updatedAt: string | null; updatedBy: string | null };

const STATES = ["off", "testers", "on"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function FlagEditor({ flag, staff, labels, errors }: { flag: FlagEditorRow; staff: { id: string; name: string }[]; labels: Labels; errors: Labels }) {
  const [state, setState] = useState(flag.state);
  const [userIds, setUserIds] = useState(() => new Set(flag.userIds));
  const [persons, setPersons] = useState(flag.personIds.join("\n"));
  const r = useRun(errors);
  const personIds = persons.split(/\s+/).map((p) => p.trim()).filter(Boolean);
  const badPerson = personIds.find((p) => !UUID.test(p));

  async function save() {
    await r.run(() => updateFlag({ key: flag.key, state, userIds: [...userIds], personIds }), lab(labels, "saved"));
  }

  return (
    <section className="grid gap-3 rounded-md border p-4" aria-labelledby={`flag-${flag.key}`} data-flag={flag.key}>
      <header className="grid gap-1">
        <h2 id={`flag-${flag.key}`} className="font-mono text-sm font-semibold">
          {flag.key}
        </h2>
        <p className="text-sm text-muted-foreground">{flag.description}</p>
        <p className="text-xs text-muted-foreground">
          {lab(labels, "owner_module", { module: flag.owner })}
          {flag.updatedAt ? ` · ${lab(labels, "last_change", { who: flag.updatedBy ?? "–", when: new Date(flag.updatedAt).toLocaleString() })}` : ""}
        </p>
      </header>
      <RadioGroup value={state} onValueChange={(v) => setState(v as typeof state)} aria-label={lab(labels, "state")} className="flex gap-4">
        {STATES.map((s) => (
          <div key={s} className="flex items-center gap-2">
            <RadioGroupItem value={s} id={`${flag.key}-${s}`} />
            <label htmlFor={`${flag.key}-${s}`} className="text-sm">
              {lab(labels, `state_${s}`)}
            </label>
          </div>
        ))}
      </RadioGroup>
      {state === "testers" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="grid gap-1">
            <legend className="text-sm font-medium">{lab(labels, "staff_testers")}</legend>
            {staff.map((s) => (
              <div key={s.id} className="flex items-center gap-2">
                <Checkbox
                  id={`${flag.key}-u-${s.id}`}
                  checked={userIds.has(s.id)}
                  onCheckedChange={(v) =>
                    setUserIds((cur) => {
                      const next = new Set(cur);
                      if (v === true) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    })
                  }
                />
                <label htmlFor={`${flag.key}-u-${s.id}`} className="text-sm">
                  {s.name}
                </label>
              </div>
            ))}
          </fieldset>
          <FormField label={lab(labels, "person_testers")} hint={lab(labels, "person_ids_hint")} error={badPerson ? lab(labels, "invalid_id", { id: badPerson }) : null}>
            <Textarea rows={4} value={persons} onChange={(e) => setPersons(e.target.value)} className="font-mono text-xs" />
          </FormField>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">{lab(labels, "tester_counts", { users: userIds.size, persons: personIds.length })}</p>
      <Feedback ok={r.ok} error={r.error} />
      <div>
        <Button type="button" size="sm" disabled={r.pending || !!badPerson} onClick={() => void save()}>
          {lab(labels, "save")}
        </Button>
      </div>
    </section>
  );
}

/** Marks a customer as tester (`persons.is_tester`), so every `testers` flag is on for them. */
export function CustomerTesterForm({ labels, errors }: { labels: Labels; errors: Labels }) {
  const r = useRun(errors);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await r.run(() => setCustomerTester({ personId: formValue(form, "personId").trim(), isTester: formValue(form, "isTester") === "on" }), lab(labels, "tester_saved"));
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-xl gap-3 rounded-md border p-4" noValidate>
      <h2 className="text-lg font-medium">{lab(labels, "customer_tester_title")}</h2>
      <FormField label={lab(labels, "person_id")} hint={lab(labels, "person_ids_hint")}>
        <Input name="personId" className="font-mono text-xs" required />
      </FormField>
      <div className="flex items-center gap-2">
        <input id="customer-is-tester" type="checkbox" name="isTester" defaultChecked className="size-4" />
        <label htmlFor="customer-is-tester" className="text-sm">
          {lab(labels, "is_tester")}
        </label>
      </div>
      <Feedback ok={r.ok} error={r.error} />
      <div>
        <Button type="submit" size="sm" disabled={r.pending}>
          {lab(labels, "save")}
        </Button>
      </div>
    </form>
  );
}
