"use client";
/**
 * The Claude panel inside the page editor (site spec section 5, rules 41-43, decision 23): an
 * instruction with a character counter, the languages and "Ask Claude"; while a request is active
 * a progress line polls `getClaudePanelState` every 2 s for up to 3 minutes; on success "Proposal
 * ready: review" links to the review screen; on failure the message for the request's
 * `error_code`. Hidden without `ai.use` (the server answers `allowed: false`).
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import NextLink from "next/link";
import type { Route } from "next";
import { Button, Checkbox, Label, Textarea } from "@beam/ui";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { cancelProposalRequest, getClaudePanelState, requestProposal } from "../../actions/proposals";
import type { SiteAdminLabels } from "../../queries/admin";
import type { EditRequestView } from "../../queries/proposals";
import { lbl } from "./pickers";

export const POLL_MS = 2000;
export const POLL_MAX_MS = 180_000;
const MAX_INSTRUCTION = 4000;

type Phase = { kind: "idle" } | { kind: "active"; request: EditRequestView; since: number } | { kind: "done"; request: EditRequestView } | { kind: "timeout" };

export function ClaudePanel({ pageId, L, locales: pageLocales }: { pageId: string; L: SiteAdminLabels; locales: Locale[] }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [instruction, setInstruction] = useState("");
  const [kind, setKind] = useState<"edit" | "new_page">("edit");
  const [locales, setLocales] = useState<Locale[]>(pageLocales.length ? pageLocales : ["nl-BE"]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    void getClaudePanelState({ pageId }).then((res) => {
      if (!alive || !res.ok) return;
      setAllowed(res.data.allowed);
      if (res.data.allowed && res.data.request && (res.data.request.status === "pending" || res.data.request.status === "running")) setPhase({ kind: "active", request: res.data.request, since: Date.now() });
    });
    return () => {
      alive = false;
    };
  }, [pageId]);

  const poll = useCallback(async (request: EditRequestView, since: number) => {
    const res = await getClaudePanelState({ pageId, editRequestId: request.editRequestId });
    if (!res.ok || !res.data.allowed || !res.data.request) return setPhase({ kind: "active", request, since });
    const next = res.data.request;
    if (next.status === "pending" || next.status === "running") {
      if (Date.now() - since >= POLL_MAX_MS) return setPhase({ kind: "timeout" });
      return setPhase({ kind: "active", request: next, since });
    }
    setPhase(next.status === "cancelled" ? { kind: "idle" } : { kind: "done", request: next });
  }, [pageId]);

  useEffect(() => {
    if (phase.kind !== "active") return;
    timer.current = setTimeout(() => void poll(phase.request, phase.since), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [phase, poll]);

  if (!allowed) return null;

  const ask = () =>
    start(async () => {
      setError(null);
      const res = await requestProposal({ pageId, instruction, locales, kind });
      if (!res.ok) return setError(res.error.code === "conflict" && res.error.message === "request_active" ? lbl(L, "claude.busy") : res.error.message);
      const view: EditRequestView = { editRequestId: res.data.editRequestId, pageId, kind, status: "pending", locales, errorCode: null, resultVersionId: null, baseVersionId: null, createdAt: new Date().toISOString(), finishedAt: null };
      setPhase({ kind: "active", request: view, since: Date.now() });
    });

  const cancel = (request: EditRequestView) =>
    start(async () => {
      const res = await cancelProposalRequest({ editRequestId: request.editRequestId });
      if (!res.ok) return setError(res.error.message);
      setPhase({ kind: "idle" });
    });

  const toggle = (l: Locale, on: boolean) => setLocales((cur) => LOCALES.filter((x) => (x === l ? on : cur.includes(x))));
  const active = phase.kind === "active";

  return (
    <section className="grid gap-2 rounded-md border p-3" aria-labelledby="claude-panel-title" data-testid="claude-panel">
      <h2 id="claude-panel-title" className="text-sm font-semibold">
        {lbl(L, "claude.title")}
      </h2>
      <Label htmlFor="claude-instruction">{lbl(L, "claude.instruction")}</Label>
      <Textarea id="claude-instruction" rows={4} maxLength={MAX_INSTRUCTION} value={instruction} disabled={active} onChange={(e) => setInstruction(e.target.value)} />
      <p className="text-xs text-muted-foreground">
        {lbl(L, "editor.counter", { count: instruction.length, max: MAX_INSTRUCTION })} · {lbl(L, "editor.noCustomerData")}
      </p>
      <fieldset className="grid gap-1">
        <legend className="text-sm">{lbl(L, "claude.locales")}</legend>
        <div className="flex flex-wrap gap-3">
          {LOCALES.map((l) => (
            <label key={l} className="flex items-center gap-1 text-sm">
              <Checkbox checked={locales.includes(l)} disabled={active} onCheckedChange={(v) => toggle(l, v === true)} />
              {l}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-wrap gap-3 text-sm">
        {(["edit", "new_page"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1">
            <input type="radio" name="claude-kind" value={k} checked={kind === k} disabled={active} onChange={() => setKind(k)} />
            {lbl(L, k === "edit" ? "claude.kindEdit" : "claude.kindNewPage")}
          </label>
        ))}
      </fieldset>
      <Button type="button" disabled={pending || active || instruction.trim().length < 3 || !locales.length} onClick={ask}>
        {lbl(L, "claude.ask")}
      </Button>
      <div aria-live="polite" className="grid gap-1 text-sm">
        {phase.kind === "active" ? (
          <>
            <p role="status">{lbl(L, "claude.running")}</p>
            {phase.request.status === "pending" ? (
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => cancel(phase.request)}>
                {lbl(L, "claude.cancel")}
              </Button>
            ) : null}
          </>
        ) : null}
        {phase.kind === "timeout" ? <p role="status">{lbl(L, "claude.timeout")}</p> : null}
        {phase.kind === "done" && phase.request.status === "succeeded" && phase.request.resultVersionId ? (
          <NextLink className="font-medium underline" href={`/admin/site/pages/${pageId}/versions/${phase.request.resultVersionId}` as Route}>
            {lbl(L, "claude.ready")}
          </NextLink>
        ) : null}
        {phase.kind === "done" && phase.request.status === "failed" ? (
          <p role="status" className="text-destructive">
            {lbl(L, `claude.error.${phase.request.errorCode ?? "ai_unavailable"}`)}
          </p>
        ) : null}
        {error ? (
          <p role="status" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
