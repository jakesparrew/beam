"use client";
/**
 * The reply box of a thread (crm spec 5.1, rule 3.50): a reply or an internal note, with the
 * reply templates (their body in the thread's language is inserted for editing). When replying
 * is not possible (a closed Meta window, Meta switched off, no address) the reply mode is
 * disabled and the reason is shown; notes stay possible.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Textarea } from "@beam/ui";
import { addThreadNote, replyToThread } from "../../inbox/actions";

export type ReplyTemplateOption = { key: string; name: string; body: string };

export type ReplyBoxLabels = {
  reply: string;
  note: string;
  placeholderReply: string;
  placeholderNote: string;
  send: string;
  addNote: string;
  sending: string;
  template: string;
  noTemplate: string;
  error: string;
  sent: string;
  noteSaved: string;
};

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ReplyBox({
  threadId,
  templates,
  blockedReason,
  hint,
  labels,
}: {
  threadId: string;
  templates: ReplyTemplateOption[];
  /** Why a reply cannot be sent now (translated), or null. */
  blockedReason: string | null;
  /** A note under the box, such as when the Meta window closes. */
  hint: string | null;
  labels: ReplyBoxLabels;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"reply" | "note">(blockedReason ? "note" : "reply");
  const [body, setBody] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [status, setStatus] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function onTemplate(key: string) {
    setTemplateKey(key);
    const t = templates.find((x) => x.key === key);
    if (t) setBody((current) => (current.trim() ? `${current.trimEnd()}\n\n${t.body}` : t.body));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = body.trim();
    if (!text) return;
    setStatus(null);
    startTransition(async () => {
      const result =
        mode === "reply" ? await replyToThread({ threadId, body: text, ...(templateKey ? { templateKey } : {}) }) : await addThreadNote({ threadId, body: text });
      if (!result.ok) {
        setStatus({ kind: "error", text: result.error.code === "conflict" && blockedReason ? blockedReason : labels.error });
        return;
      }
      setBody("");
      setTemplateKey("");
      setStatus({ kind: "ok", text: mode === "reply" ? labels.sent : labels.noteSaved });
      router.refresh();
    });
  }

  const replyDisabled = !!blockedReason;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 rounded-md border p-4" aria-busy={pending}>
      <div role="tablist" className="flex gap-2">
        <Button type="button" role="tab" aria-selected={mode === "reply"} variant={mode === "reply" ? "default" : "outline"} disabled={replyDisabled} onClick={() => setMode("reply")}>
          {labels.reply}
        </Button>
        <Button type="button" role="tab" aria-selected={mode === "note"} variant={mode === "note" ? "default" : "outline"} onClick={() => setMode("note")}>
          {labels.note}
        </Button>
      </div>
      {blockedReason ? (
        <Alert>
          <AlertDescription>{blockedReason}</AlertDescription>
        </Alert>
      ) : null}
      {mode === "reply" && templates.length > 0 ? (
        <label className="flex items-center gap-2 text-sm">
          <span>{labels.template}</span>
          <select className={selectClass} value={templateKey} onChange={(e) => onTemplate(e.target.value)}>
            <option value="">{labels.noTemplate}</option>
            {templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Textarea
        name="body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        maxLength={20_000}
        placeholder={mode === "reply" ? labels.placeholderReply : labels.placeholderNote}
        aria-label={mode === "reply" ? labels.reply : labels.note}
      />
      {hint && mode === "reply" ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <div className="flex items-center justify-between gap-3">
        <span role="status" className={status?.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {status?.text ?? ""}
        </span>
        <Button type="submit" disabled={pending || !body.trim() || (mode === "reply" && replyDisabled)}>
          {pending ? labels.sending : mode === "reply" ? labels.send : labels.addNote}
        </Button>
      </div>
    </form>
  );
}
