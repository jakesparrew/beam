"use client";
/**
 * The move-stage dialog (crm spec 5.1, rule 3.47): a stage list limited to the allowed moves,
 * and a required reason when the target is `lost`. The board opens it for a drop on `lost` and
 * for the keyboard "Move" button; the detail page opens it from its header. A stale `version`
 * or a refused transition shows the server's reason. Callers give it a `key` per opened target,
 * so its state starts fresh each time.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Textarea } from "@beam/ui";
import type { OpportunityStage } from "@beam/db/schema";
import { moveOpportunityStage } from "../../pipeline/actions";

export type StageDialogLabels = {
  title: string;
  description: string;
  stage: string;
  lostReason: string;
  submit: string;
  saving: string;
  cancel: string;
  error: string;
  stale: string;
  notAllowed: string;
  reasonRequired: string;
  stages: Record<string, string>;
};

export type StageTarget = { id: string; version: number; stage: string; title: string };

type StageKey = OpportunityStage;

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function StageDialog({
  target,
  initialStage,
  allowed,
  labels,
  onClose,
}: {
  target: StageTarget | null;
  /** The pre-selected stage (a drop target), else the first allowed one. */
  initialStage?: string;
  /** The stages `target.stage` may move to (rule 3.47). */
  allowed: readonly string[];
  labels: StageDialogLabels;
  onClose: () => void;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<string>(initialStage ?? allowed[0] ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);


  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target) return;
    const form = new FormData(event.currentTarget);
    const raw = form.get("lostReason");
    const reason = typeof raw === "string" ? raw.trim() : "";
    if (stage === "lost" && !reason) {
      setError(labels.reasonRequired);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await moveOpportunityStage({ id: target.id, version: target.version, stage: stage as StageKey, ...(stage === "lost" ? { lostReason: reason } : {}) });
      if (result.ok) {
        onClose();
        router.refresh();
        return;
      }
      const m = result.error.message;
      setError(m === "stale_version" ? labels.stale : m === "stage_transition_not_allowed" || m === "same_stage" ? labels.notAllowed : m === "lost_reason_required" ? labels.reasonRequired : labels.error);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{target ? `${target.title}: ${labels.description}` : labels.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <FormField label={labels.stage} required>
            <select name="stage" value={stage} onChange={(e) => setStage(e.target.value)} className={selectClass}>
              {allowed.map((s) => (
                <option key={s} value={s}>
                  {labels.stages[s] ?? s}
                </option>
              ))}
            </select>
          </FormField>
          {stage === "lost" ? (
            <FormField label={labels.lostReason} required>
              <Textarea name="lostReason" maxLength={500} rows={3} required />
            </FormField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {labels.cancel}
            </Button>
            <Button type="submit" disabled={pending || !stage}>
              {pending ? labels.saving : labels.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The detail page's "Move stage" button with its dialog. */
export function MoveStageButton({ target, allowed, labels, buttonLabel }: { target: StageTarget; allowed: string[]; labels: StageDialogLabels; buttonLabel: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {buttonLabel}
      </Button>
      <StageDialog key={open ? "open" : "closed"} target={open ? target : null} allowed={allowed} labels={labels} onClose={() => setOpen(false)} />
    </>
  );
}
