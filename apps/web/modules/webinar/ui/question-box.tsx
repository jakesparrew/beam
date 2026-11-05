"use client";
/**
 * The question box of the player (webinar spec rules 21, 37, 44): questions go to the hosts only,
 * in live, replay and on-demand. In live the hosts answer them in the stream; afterwards each
 * question becomes a follow-up task for the webinar owner, so the confirmation says "we will get
 * back to you". A muted viewer sees that their questions are paused. Texts come from the server.
 */
import { useId, useState, type FormEvent } from "react";
import { Button, Textarea } from "@beam/ui";
import { MESSAGE_MAX, type MessageOutcome } from "./chat-panel";

export type QuestionBoxLabels = {
  title: string;
  label: string;
  send: string;
  hint: string;
  sent_live: string;
  sent_later: string;
  muted: string;
  too_fast: string;
  error: string;
};

export function QuestionBox(props: { live: boolean; muted: boolean; labels: QuestionBoxLabels; onSend: (text: string) => Promise<MessageOutcome> }) {
  const { labels } = props;
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

  const muted = props.muted || outcome === "muted";
  return (
    <section aria-labelledby={`${inputId}-title`} className="flex flex-col gap-2 rounded-lg border border-border p-4" data-testid="webinar-question">
      <h2 id={`${inputId}-title`} className="font-semibold">
        {labels.title}
      </h2>
      {muted ? (
        <p className="text-sm font-medium">{labels.muted}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-sm font-medium">
            {labels.label}
          </label>
          <Textarea id={inputId} value={text} maxLength={MESSAGE_MAX} rows={3} aria-describedby={hintId} onChange={(e) => setText(e.target.value)} />
          <p id={hintId} className="text-xs text-muted-foreground">
            {labels.hint}
          </p>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" variant="outline" disabled={pending || !text.trim()}>
              {labels.send}
            </Button>
            {outcome === "ok" ? <p className="text-sm">{props.live ? labels.sent_live : labels.sent_later}</p> : null}
            {outcome && outcome !== "ok" ? <p className="text-sm text-destructive">{labels[outcome]}</p> : null}
          </div>
        </form>
      )}
    </section>
  );
}
