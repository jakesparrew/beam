"use client";

/**
 * The wellbeing check-in, one question at a time (like a short survey): tapping an answer moves
 * on, a progress bar shows where you are, "Back" goes one question back. Each question has its own
 * form (a word scale, choice cards, a reversed tension scale, mood words) and the last one is an
 * optional note with quick chips. All answers post together through the page's server action.
 */
import { useState } from "react";

export type CheckinQuestion = {
  /** Form field: energy | sleep | calm | mood. */
  name: string;
  title: string;
  hint?: string;
  style: "scale" | "cards" | "words";
  /** Five options, worst first; `value` is the stored 1-5 score. */
  options: { value: number; label: string; icon?: string }[];
};

export type CheckinFlowLabels = {
  eyebrow: string;
  title: string;
  intro: string;
  back: string;
  step: string;
  noteTitle: string;
  notePlaceholder: string;
  chips: string[];
  skip: string;
  save: string;
  private: string;
};

export function CheckinFlow({
  moment,
  bookingId,
  questions,
  labels,
  action,
}: {
  moment: "before" | "after" | "daily";
  bookingId: string | null;
  questions: CheckinQuestion[];
  labels: CheckinFlowLabels;
  action: (fd: FormData) => Promise<void>;
}) {
  const [step, setStep] = useState(-1);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const total = questions.length + 1;
  const q = step >= 0 && step < questions.length ? questions[step] : null;
  const onNote = step === questions.length;

  const choose = (name: string, value: number) => {
    setAnswers((a) => ({ ...a, [name]: value }));
    window.setTimeout(() => setStep((s) => s + 1), 180);
  };

  const card = "rounded-[1.5rem] bg-card p-6 shadow-[0_1px_2px_rgb(33_40_66/0.04),0_12px_32px_-18px_rgb(33_40_66/0.22)] sm:p-8";

  if (step === -1) {
    return (
      <section className={`${card} grid content-between gap-6`} aria-labelledby="checkin-title">
        <div>
          <p className="text-xs font-semibold tracking-[0.25em] text-[#a0621e] uppercase">{labels.eyebrow}</p>
          <h2 id="checkin-title" className="font-display mt-1 text-3xl">
            {labels.title}
          </h2>
          <p className="mt-2 text-muted-foreground first-letter:uppercase">{labels.intro}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">🔒 {labels.private}</p>
          <button type="button" onClick={() => setStep(0)} className="site-gold inline-flex h-12 items-center gap-3 rounded-full pr-1.5 pl-6 text-sm font-semibold text-[#212842]">
            {labels.step}
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-[#212842] text-[#fffaef]">
              →
            </span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`${card} grid gap-6`} aria-labelledby="checkin-q">
      <div className="grid gap-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <button type="button" onClick={() => setStep((s) => s - 1)} className="rounded-full px-2 py-1 hover:bg-muted">
            ← {labels.back}
          </button>
          <span className="tabular-nums">
            {step + 1} / {total}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className="h-full rounded-full bg-[linear-gradient(90deg,#b57627,#f7cc78)] transition-all duration-300" style={{ width: `${((step + 1) / total) * 100}%` }} />
        </div>
      </div>

      {q ? (
        <div key={q.name} className="grid animate-in gap-5 duration-300 fade-in slide-in-from-right-4">
          <div>
            <h2 id="checkin-q" className="font-display text-2xl sm:text-3xl">
              {q.title}
            </h2>
            {q.hint ? <p className="mt-1 text-sm text-muted-foreground">{q.hint}</p> : null}
          </div>
          {q.style === "scale" ? (
            <div className="grid gap-2">
              <div className="grid grid-cols-5 gap-2">
                {q.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => choose(q.name, o.value)}
                    aria-pressed={answers[q.name] === o.value}
                    className="grid h-16 place-items-center rounded-2xl border-2 border-border text-lg font-semibold transition hover:border-[#212842]/50 aria-pressed:border-[#212842] aria-pressed:bg-[#212842] aria-pressed:text-[#fffaef]"
                  >
                    {o.value}
                  </button>
                ))}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{q.options[0]!.label}</span>
                <span>{q.options[4]!.label}</span>
              </div>
            </div>
          ) : (
            <div className={`grid gap-2 ${q.style === "cards" ? "grid-cols-2 sm:grid-cols-5" : "sm:grid-cols-5"}`}>
              {q.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => choose(q.name, o.value)}
                  aria-pressed={answers[q.name] === o.value}
                  className={`flex items-center gap-3 rounded-2xl border-2 border-border px-4 text-left text-sm font-medium transition hover:border-[#212842]/50 aria-pressed:border-[#212842] aria-pressed:bg-[#fffaef] ${q.style === "cards" ? "flex-col justify-center py-4 text-center" : "h-12 justify-center"}`}
                >
                  {o.icon ? (
                    <span aria-hidden="true" className="text-2xl">
                      {o.icon}
                    </span>
                  ) : null}
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {onNote ? (
        <form action={action} className="grid animate-in gap-4 duration-300 fade-in slide-in-from-right-4">
          <input type="hidden" name="moment" value={moment} />
          {bookingId ? <input type="hidden" name="bookingId" value={bookingId} /> : null}
          {Object.entries(answers).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <h2 id="checkin-q" className="font-display text-2xl sm:text-3xl">
            {labels.noteTitle}
          </h2>
          <div className="flex flex-wrap gap-2">
            {labels.chips.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setNote((n) => (n.includes(c) ? n : n ? `${n}, ${c}` : c))}
                className="rounded-full border border-border px-3 py-1.5 text-sm hover:border-[#212842]/50 hover:bg-[#fffaef]"
              >
                + {c}
              </button>
            ))}
          </div>
          <textarea
            name="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder={labels.notePlaceholder}
            className="rounded-2xl border border-input bg-card px-4 py-3 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">🔒 {labels.private}</p>
            <button type="submit" className="site-gold inline-flex h-12 items-center rounded-full px-7 text-sm font-semibold text-[#212842]">
              {note.trim() ? labels.save : labels.skip}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
