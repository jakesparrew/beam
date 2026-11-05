"use client";
/**
 * The live chat of the player (webinar spec rules 21, 37, 38, 44): the visible messages with the
 * sender's first name and last initial, and a composer (1-500 characters) that warns not to share
 * health details. A muted viewer sees "The host has paused your chat" instead of the composer.
 * The list itself is not a live region (it would flood screen readers); new polls and CTAs are
 * announced by the player. Texts come from the server (`labels`).
 */
import { useId, useState, type FormEvent } from "react";
import { Button, Textarea } from "@beam/ui";

export type ChatPanelLine = { id: string; name: string; text: string; at: string; mine: boolean };
export type MessageOutcome = "ok" | "muted" | "too_fast" | "error";

export type ChatPanelLabels = {
  title: string;
  label: string;
  send: string;
  hint: string;
  empty: string;
  muted: string;
  too_fast: string;
  error: string;
  you: string;
  anonymous: string;
  /** `{count}` characters typed. */
  count: string;
};

export const MESSAGE_MAX = 500;

export function ChatPanel(props: { lines: ChatPanelLine[]; muted: boolean; labels: ChatPanelLabels; onSend: (text: string) => Promise<MessageOutcome> }) {
  const { lines, muted, labels } = props;
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<MessageOutcome | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || pending) return;
    setPending(true);
    try {
      const out = await props.onSend(value);
      setOutcome(out);
      if (out === "ok") setText("");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby={`${inputId}-title`} className="flex flex-col gap-3 rounded-lg border border-border p-4" data-testid="webinar-chat">
      <h2 id={`${inputId}-title`} className="font-semibold">
        {labels.title}
      </h2>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <ol className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm" tabIndex={0} aria-label={labels.title}>
          {lines.map((l) => (
            <li key={l.id}>
              <span className="font-medium">{l.mine ? labels.you : l.name || labels.anonymous}</span>
              {": "}
              <span className="break-words">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
      {muted || outcome === "muted" ? (
        <p className="text-sm font-medium" data-testid="webinar-chat-muted">
          {labels.muted}
        </p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-sm font-medium">
            {labels.label}
          </label>
          <Textarea id={inputId} value={text} maxLength={MESSAGE_MAX} rows={2} aria-describedby={hintId} onChange={(e) => setText(e.target.value)} />
          <p id={hintId} className="text-xs text-muted-foreground">
            {labels.hint} {labels.count.replace("{count}", String(text.length))}
          </p>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={pending || !text.trim()}>
              {labels.send}
            </Button>
            {outcome && outcome !== "ok" ? <p className="text-sm text-destructive">{labels[outcome]}</p> : null}
          </div>
        </form>
      )}
    </section>
  );
}
