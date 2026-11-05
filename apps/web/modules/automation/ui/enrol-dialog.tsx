"use client";
/**
 * "Enrol in..." dialog of the person page (automation spec 5, A-37, edge case 20): automation
 * picker over every active automation, the anchor input when the definition has a data anchor,
 * and the warnings of the chosen automation before confirming (audience mismatch, marketing
 * purpose not reachable, already in it, exclusive journey that will exit `moved`, processing
 * restricted). The staff override never bypasses consent: the warning says the marketing steps
 * will be skipped. Posts `enrolPerson`; a refused entry is shown in words, success refreshes.
 */
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input } from "@beam/ui";
import { enrolPerson } from "../actions";
import { errorText, formStr, type ActionResultLike, type Labels } from "./outcome-badge";

export type EnrolChoice = { id: string; name: string; needsAnchor: boolean; warnings: string[] };

/** A `datetime-local` value (browser time, Europe/Brussels for staff) as an ISO instant. */
export function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function EnrolDialog(p: { personId: string; options: EnrolChoice[]; labels: Labels }) {
  const l = p.labels;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(p.options[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const anchorId = useId();
  const warnId = useId();
  const selected = p.options.find((o) => o.id === choice) ?? null;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const anchorAt = selected.needsAnchor ? localToIso(formStr(form, "anchorAt")) : undefined;
      const r = (await enrolPerson({ personId: p.personId, automationId: selected.id, ...(anchorAt ? { anchorAt } : {}) })) as ActionResultLike<{ status: string; outcome?: string }>;
      if (!r.ok) setError(errorText(r.error, l));
      else if (r.data.status !== "enrolled") setError(l[`panel.refused.${r.data.outcome ?? ""}`] ?? l["panel.refused.generic"] ?? "");
      else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="automation-enrol-open">
          {l["panel.enrol"]}
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="automation-enrol-dialog">
        <DialogHeader>
          <DialogTitle>{l["panel.enrol_title"]}</DialogTitle>
          <DialogDescription>{l["panel.enrol_body"]}</DialogDescription>
        </DialogHeader>
        {p.options.length ? (
          <form onSubmit={(e) => void submit(e)} className="grid gap-4">
            <div className="grid gap-1">
              <label htmlFor={selectId} className="text-sm font-medium">
                {l["panel.automation"]}
              </label>
              <select
                id={selectId}
                name="automationId"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                aria-describedby={selected?.warnings.length ? warnId : undefined}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                data-testid="automation-enrol-select"
              >
                {p.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
            {selected?.needsAnchor ? (
              <div className="grid gap-1">
                <label htmlFor={anchorId} className="text-sm font-medium">
                  {l["panel.anchor"]}
                </label>
                <Input id={anchorId} name="anchorAt" type="datetime-local" required data-testid="automation-enrol-anchor" />
                <small className="text-muted-foreground">{l["panel.anchor_hint"]}</small>
              </div>
            ) : null}
            {selected?.warnings.length ? (
              <ul id={warnId} className="grid gap-1 rounded-md border border-warning bg-warning/10 p-3 text-sm" data-testid="automation-enrol-warnings">
                {selected.warnings.map((w) => (
                  <li key={w} data-warning={w}>
                    {l[`panel.warning.${w}`] ?? w}
                  </li>
                ))}
              </ul>
            ) : null}
            {error ? (
              <Alert variant="destructive" data-testid="automation-enrol-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={busy || !selected} data-testid="automation-enrol-submit">
                {busy ? l["common.saving"] : l["panel.enrol_submit"]}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{l["panel.no_options"]}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
