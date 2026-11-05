"use client";
/**
 * Person page enrolment controls (automation spec 5, A-36, A-38): the "Move to..." dialog (from
 * one active enrolment to another automation, with the anchor input when the target needs one
 * and the target's warnings) posting `movePerson`, and the per-enrolment Exit button (confirm
 * dialog with an optional note) posting `exitEnrolment`. Both refresh the page on success and
 * show an error in the catalogue's words otherwise.
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
  Input,
  Textarea,
} from "@beam/ui";
import { exitEnrolment, movePerson } from "../actions";
import { localToIso, type EnrolChoice } from "./enrol-dialog";
import { errorText, fill, formStr, type ActionResultLike, type Labels } from "./outcome-badge";

export type MoveSource = { enrolmentId: string; automationId: string; name: string };

function useSubmit(l: Labels) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(call: () => Promise<ActionResultLike>, onOk: () => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await call();
      if (!r.ok) setError(errorText(r.error, l));
      else {
        onOk();
        router.refresh();
      }
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function MoveDialog(p: { personId: string; sources: MoveSource[]; targets: EnrolChoice[]; defaultFrom?: string; labels: Labels }) {
  const l = p.labels;
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(p.defaultFrom ?? p.sources[0]?.enrolmentId ?? "");
  const source = p.sources.find((s) => s.enrolmentId === from) ?? null;
  const targets = p.targets.filter((t) => t.id !== source?.automationId);
  const [to, setTo] = useState("");
  const target = targets.find((t) => t.id === to) ?? targets[0] ?? null;
  const { busy, error, run } = useSubmit(l);
  const fromId = useId();
  const toId = useId();
  const anchorId = useId();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!source || !target) return;
    const anchorAt = target.needsAnchor ? localToIso(formStr(new FormData(e.currentTarget), "anchorAt")) : undefined;
    void run(
      () => movePerson({ personId: p.personId, fromEnrolmentId: source.enrolmentId, toAutomationId: target.id, ...(anchorAt ? { anchorAt } : {}) }),
      () => setOpen(false),
    );
  }

  if (!p.sources.length) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="automation-move-open">
          {l["panel.move"]}
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="automation-move-dialog">
        <DialogHeader>
          <DialogTitle>{l["panel.move_title"]}</DialogTitle>
          <DialogDescription>{l["panel.move_body"]}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1">
            <label htmlFor={fromId} className="text-sm font-medium">
              {l["panel.from"]}
            </label>
            <select id={fromId} value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm" data-testid="automation-move-from">
              {p.sources.map((s) => (
                <option key={s.enrolmentId} value={s.enrolmentId}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <label htmlFor={toId} className="text-sm font-medium">
              {l["panel.to"]}
            </label>
            <select id={toId} value={target?.id ?? ""} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm" data-testid="automation-move-to">
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {target?.needsAnchor ? (
            <div className="grid gap-1">
              <label htmlFor={anchorId} className="text-sm font-medium">
                {l["panel.anchor"]}
              </label>
              <Input id={anchorId} name="anchorAt" type="datetime-local" required data-testid="automation-move-anchor" />
              <small className="text-muted-foreground">{l["panel.anchor_hint"]}</small>
            </div>
          ) : null}
          {target?.warnings.filter((w) => w !== "exclusive").length ? (
            <ul className="grid gap-1 rounded-md border border-warning bg-warning/10 p-3 text-sm" data-testid="automation-move-warnings">
              {target.warnings
                .filter((w) => w !== "exclusive")
                .map((w) => (
                  <li key={w} data-warning={w}>
                    {l[`panel.warning.${w}`] ?? w}
                  </li>
                ))}
            </ul>
          ) : null}
          {error ? (
            <Alert variant="destructive" data-testid="automation-move-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={busy || !source || !target} data-testid="automation-move-submit">
              {busy ? l["common.saving"] : l["panel.move_submit"]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ExitEnrolmentButton(p: { enrolmentId: string; automationName: string; labels: Labels }) {
  const l = p.labels;
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useSubmit(l);
  const noteId = useId();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = formStr(new FormData(e.currentTarget), "note").trim();
    void run(() => exitEnrolment({ enrolmentId: p.enrolmentId, ...(note ? { note } : {}) }), () => setOpen(false));
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="automation-exit-open" data-exit-for={p.enrolmentId}>
          {l["panel.exit"]}
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="automation-exit-dialog">
        <DialogHeader>
          <DialogTitle>{fill(l["panel.exit_title"], { name: p.automationName })}</DialogTitle>
          <DialogDescription>{l["panel.exit_body"]}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1">
            <label htmlFor={noteId} className="text-sm font-medium">
              {l["panel.note"]}
            </label>
            <Textarea id={noteId} name="note" maxLength={500} rows={2} />
          </div>
          {error ? (
            <Alert variant="destructive" data-testid="automation-exit-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={busy} data-testid="automation-exit-submit">
              {busy ? l["common.saving"] : l["panel.exit_submit"]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
