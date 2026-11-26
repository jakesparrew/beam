"use client";
/**
 * "Fill this session" on the dashboard (owner requirements 6): first shows who a campaign could
 * reach (`previewFillSession`), then on confirmation makes the segment and the campaign draft
 * (`createFillSessionDraft`) and opens the draft. Nothing is sent from here.
 */
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@beam/ui";
import { createFillSessionDraft, previewFillSession } from "../dashboard/actions";
import type { FillAudience, FillReason } from "../dashboard/fill-session";

export type FillSessionLabels = {
  button: string;
  counting: string;
  total: string;
  /** In display order. */
  reasons: Record<FillReason, string>;
  consentNote: string;
  none: string;
  create: string;
  cancel: string;
  error: string;
  errors: Partial<Record<string, string>>;
};

type State = { kind: "idle" } | { kind: "busy" } | { kind: "preview"; audience: FillAudience } | { kind: "error"; message: string };

export function FillSessionButton({ sessionId, labels }: { sessionId: string; labels: FillSessionLabels }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  const fail = (code: string) => setState({ kind: "error", message: labels.errors[code] ?? labels.error });

  async function preview() {
    setState({ kind: "busy" });
    const result = await previewFillSession({ sessionId });
    if (result.ok) setState({ kind: "preview", audience: result.data });
    else fail(result.error.code);
  }

  async function create() {
    setState({ kind: "busy" });
    const result = await createFillSessionDraft({ sessionId });
    if (result.ok) router.push(`/admin/campaigns/${result.data.campaignId}` as Route);
    else fail(result.error.code);
  }

  if (state.kind !== "preview") {
    return (
      <div className="flex items-center gap-2">
        {state.kind === "error" ? (
          <span className="text-sm text-destructive" role="status">
            {state.message}
          </span>
        ) : null}
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-[0.75rem]" disabled={state.kind === "busy"} onClick={() => void preview()} data-testid="fill-session">
          {state.kind === "busy" ? labels.counting : labels.button}
        </Button>
      </div>
    );
  }

  const { audience } = state;
  return (
    <div className="grid w-full gap-2 rounded-xl border bg-muted/40 p-3 text-sm" aria-live="polite" data-testid="fill-preview">
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <dt className="font-medium">{labels.total}</dt>
        <dd className="font-semibold tabular-nums" data-testid="fill-total">
          {audience.total}
        </dd>
        {(Object.keys(labels.reasons) as FillReason[]).map((r) => (
          <div key={r} className="contents text-muted-foreground">
            <dt>{labels.reasons[r]}</dt>
            <dd className="tabular-nums">{audience.byReason[r]}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{audience.total ? labels.consentNote : labels.none}</p>
      <div className="flex gap-2">
        {audience.total ? (
          <Button size="sm" onClick={() => void create()} data-testid="fill-create">
            {labels.create}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setState({ kind: "idle" })}>
          {labels.cancel}
        </Button>
      </div>
    </div>
  );
}
