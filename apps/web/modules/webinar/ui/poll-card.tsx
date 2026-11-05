"use client";
/**
 * The viewer's poll card (webinar spec rules 33-35, 44): a `fieldset` with a `legend`, radio
 * buttons for a single choice and checkboxes for several, keyboard operable, with a visible focus
 * ring from `@beam/ui`. After an answer (or when the viewer answered earlier in this mode) the
 * card shows the chosen options instead of the form. It never takes focus by itself: the player
 * announces a new poll through its one `aria-live` region. Texts come from the server (`labels`).
 */
import { useId, useState, type FormEvent } from "react";
import { Button } from "@beam/ui";

export type PollCardPoll = { id: string; question: string; options: Array<{ key: string; label: string }>; allowMultiple: boolean };
export type PollAnswerOutcome = "ok" | "already_answered" | "closed" | "error";

export type PollCardLabels = {
  title: string;
  single: string;
  multiple: string;
  submit: string;
  answered: string;
  already_answered: string;
  closed: string;
  error: string;
  /** `{question}` is replaced by the poll question. */
  announce: string;
  /** `{answer}` is replaced by the chosen labels. */
  your_answer: string;
};

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");

export function PollCard(props: {
  poll: PollCardPoll;
  /** The viewer's earlier answer in this mode, or null. */
  answered: string[] | null;
  labels: PollCardLabels;
  onSubmit: (optionKeys: string[]) => Promise<PollAnswerOutcome>;
}) {
  const { poll, labels } = props;
  const name = useId();
  const [chosen, setChosen] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<PollAnswerOutcome | null>(null);
  const answer = props.answered ?? (outcome === "ok" ? chosen : null);

  const toggle = (key: string, checked: boolean) =>
    setChosen((c) => (poll.allowMultiple ? (checked ? [...c, key] : c.filter((k) => k !== key)) : checked ? [key] : c));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen.length || pending) return;
    setPending(true);
    try {
      setOutcome(await props.onSubmit(chosen));
    } finally {
      setPending(false);
    }
  }

  const labelOf = (key: string) => poll.options.find((o) => o.key === key)?.label ?? key;
  return (
    <section aria-label={labels.title} className="rounded-lg border border-border bg-card p-4" data-testid="webinar-poll">
      {answer ? (
        <div className="space-y-1">
          <p className="font-medium">{poll.question}</p>
          <p className="text-sm">{fill(labels.your_answer, { answer: answer.map(labelOf).join(", ") })}</p>
          <p className="text-sm text-muted-foreground">{outcome === "already_answered" ? labels.already_answered : labels.answered}</p>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <fieldset className="space-y-2">
            <legend className="font-medium">{poll.question}</legend>
            <p className="text-sm text-muted-foreground">{poll.allowMultiple ? labels.multiple : labels.single}</p>
            {poll.options.map((o) => (
              <label key={o.key} className="flex items-center gap-2 text-sm">
                <input
                  type={poll.allowMultiple ? "checkbox" : "radio"}
                  name={name}
                  value={o.key}
                  checked={chosen.includes(o.key)}
                  onChange={(e) => toggle(o.key, e.target.checked)}
                  className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
                {o.label}
              </label>
            ))}
          </fieldset>
          <Button type="submit" size="sm" disabled={!chosen.length || pending}>
            {labels.submit}
          </Button>
          {outcome && outcome !== "ok" ? <p className="text-sm text-destructive">{labels[outcome]}</p> : null}
        </form>
      )}
    </section>
  );
}
