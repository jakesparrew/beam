"use client";
/**
 * The small "⋯" menu next to a session to fill on the dashboard (owner requirements 6): open the
 * session, add a booking to it, or mail likely clients. Mailing first shows who a campaign could
 * reach (`previewFillSession`) in a dialog, then on confirmation makes the segment and the
 * campaign draft (`createFillSessionDraft`) and opens the draft. Nothing is sent from here.
 */
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@beam/ui";
import { createFillSessionDraft, previewFillSession } from "../dashboard/actions";
import type { FillAudience, FillReason } from "../dashboard/fill-session";

export type FillSessionLabels = {
  /** The menu trigger's accessible name. */
  button: string;
  openSession: string;
  addBooking: string;
  mail: string;
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

export function FillSessionButton({ sessionId, labels, canMail = true }: { sessionId: string; labels: FillSessionLabels; canMail?: boolean }) {
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

  const dialogOpen = state.kind !== "idle";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={labels.button}
            title={labels.button}
            data-testid={canMail ? "fill-session" : "session-menu"}
            className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-card text-[0.875rem] leading-none text-muted-foreground hover:border-[#c9973a] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            ⋯
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem asChild>
            <a href={`/admin/sessions/${sessionId}`}>{labels.openSession}</a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`/admin/bookings/new?sessionId=${sessionId}`}>{labels.addBooking}</a>
          </DropdownMenuItem>
          {canMail ? (
            <DropdownMenuItem onSelect={() => void preview()} data-testid="fill-session-mail">
              {labels.mail}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialogOpen} onOpenChange={(o) => (o ? null : setState({ kind: "idle" }))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{labels.mail}</DialogTitle>
            <DialogDescription>{state.kind === "preview" && !state.audience.total ? labels.none : labels.consentNote}</DialogDescription>
          </DialogHeader>
          {state.kind === "busy" ? <p className="text-sm text-muted-foreground">{labels.counting}</p> : null}
          {state.kind === "error" ? (
            <p className="text-sm text-destructive" role="status">
              {state.message}
            </p>
          ) : null}
          {state.kind === "preview" ? (
            <div className="grid gap-3 text-sm" aria-live="polite" data-testid="fill-preview">
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                <dt className="font-medium">{labels.total}</dt>
                <dd className="font-semibold tabular-nums" data-testid="fill-total">
                  {state.audience.total}
                </dd>
                {(Object.keys(labels.reasons) as FillReason[]).map((r) => (
                  <div key={r} className="contents text-muted-foreground">
                    <dt>{labels.reasons[r]}</dt>
                    <dd className="tabular-nums">{state.audience.byReason[r]}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setState({ kind: "idle" })}>
                  {labels.cancel}
                </Button>
                {state.audience.total ? (
                  <Button size="sm" onClick={() => void create()} data-testid="fill-create">
                    {labels.create}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
