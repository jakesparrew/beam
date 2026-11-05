"use client";
/**
 * The AI draft panel of an inbox thread (crm spec 5.1, rules 3.51 and 3.58), crm-P10. It loads
 * its state and labels through `loadAiDraftPanel` (and polls every few seconds while a draft is
 * being made). Staff with `ai.use` request a draft for the newest inbound message; a ready draft
 * is shown in an editable box: "Send this reply" sends the edited text through `replyToThread`
 * (which records `used`), "Discard" drops it. Nothing is ever sent without that click.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Alert, AlertDescription, Button, Textarea } from "@beam/ui";
import { discardAiDraft, loadAiDraftPanel, replyToThread, requestAiDraft } from "../../inbox/actions";

type Panel = Extract<Awaited<ReturnType<typeof loadAiDraftPanel>>, { ok: true }>["data"];

/** How often a pending draft is checked again. */
const POLL_MS = 3000;
/** Polling stops after this long (the job gives up after three attempts). */
const POLL_MAX_MS = 3 * 60_000;

export function AiDraftPanel({ threadId, canWrite }: { threadId: string; canWrite: boolean }) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [pollSince, setPollSince] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, startTransition] = useTransition();

  const load = useCallback(async () => {
    const result = await loadAiDraftPanel({ threadId });
    if (!result.ok) return null;
    setPanel(result.data);
    if (result.data.state?.status === "ready") setText((current) => current || result.data.state?.draft || "");
    return result.data;
  }, [threadId]);

  useEffect(() => {
    void load().then((p) => {
      if (p?.state?.status === "pending") setPollSince(Date.now());
    });
  }, [load]);

  useEffect(() => {
    if (pollSince === null) return;
    const timer = window.setTimeout(() => {
      void load().then((p) => {
        if (p?.state?.status === "pending" && Date.now() - pollSince < POLL_MAX_MS) setTick((n) => n + 1);
        else setPollSince(null);
      });
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [pollSince, tick, load]);

  if (!panel || !panel.state) return null;
  const { state, labels } = panel;
  const L = labels;

  function request() {
    setMessage(null);
    setText("");
    startTransition(async () => {
      const result = await requestAiDraft({ messageId: state!.messageId });
      if (!result.ok) setMessage({ kind: "error", text: result.error.code === "conflict" ? L.pending_conflict : result.error.code === "forbidden" ? L.no_permission : L.error });
      const p = await load();
      if (p?.state?.status === "pending") setPollSince(Date.now());
    });
  }

  function discard() {
    setMessage(null);
    startTransition(async () => {
      const result = await discardAiDraft({ messageId: state!.messageId });
      if (!result.ok) setMessage({ kind: "error", text: L.error });
      setText("");
      await load();
    });
  }

  function send() {
    setMessage(null);
    startTransition(async () => {
      const result = await replyToThread({ threadId, body: text, usedAiDraftMessageId: state!.messageId });
      if (!result.ok) {
        setMessage({ kind: "error", text: L.error });
        return;
      }
      setMessage({ kind: "ok", text: L.sent });
      setText("");
      await load();
      router.refresh();
    });
  }

  const canRequest = panel.canRequest && !state.threadIsSensitive && state.status !== "pending" && state.status !== "used";
  const status = state.status;

  return (
    <section className="grid gap-3 rounded-md border border-dashed p-4" aria-busy={busy || status === "pending"} data-testid="ai-draft-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{L.title}</h2>
      </div>
      <p className="text-xs text-muted-foreground">{status === "ready" ? L.ready : L.hint}</p>
      {state.threadIsSensitive ? <p className="text-sm text-muted-foreground">{L.thread_sensitive}</p> : null}
      {status === "pending" ? <p className="text-sm" role="status">{L.pending}</p> : null}
      {status === "blocked_sensitive" && !state.threadIsSensitive ? <p className="text-sm text-muted-foreground">{L.blocked}</p> : null}
      {status === "failed" ? <p className="text-sm text-destructive">{L.failed}</p> : null}
      {status === "used" ? <p className="text-sm text-muted-foreground">{L.used}</p> : null}
      {status === "discarded" ? <p className="text-sm text-muted-foreground">{L.discarded}</p> : null}
      {status === "ready" ? (
        <div className="grid gap-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} maxLength={20_000} aria-label={L.title} disabled={!canWrite || busy} />
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || !text.trim()} onClick={send}>
                {busy ? L.sending : L.use}
              </Button>
              <Button variant="outline" disabled={busy} onClick={discard}>
                {L.discard}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {canRequest ? (
        <div>
          <Button variant="outline" disabled={busy} onClick={request}>
            {status === "none" ? L.request : L.regenerate}
          </Button>
        </div>
      ) : null}
      {message ? (
        <Alert variant={message.kind === "error" ? "destructive" : "default"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
