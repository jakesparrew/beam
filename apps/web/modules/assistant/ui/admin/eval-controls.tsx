"use client";

/** The evaluation page's controls: add a case, delete one, run the set on up to four models. */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addEvalCase, deleteEvalCase, runEvaluation } from "../../actions";

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");
const box = "rounded-xl border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AddCase({ labels }: { labels: { question: string; expectation: string; add: string } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        start(async () => {
          const r = await addEvalCase({ question: str(fd.get("question")), expectation: str(fd.get("expectation")), locale: (str(fd.get("locale")) || "nl-BE") as "nl-BE" });
          if (r.ok) {
            form.reset();
            router.refresh();
          }
        });
      }}
    >
      <input name="question" required minLength={3} maxLength={1000} placeholder={labels.question} aria-label={labels.question} className={box} />
      <input name="expectation" required minLength={3} maxLength={1000} placeholder={labels.expectation} aria-label={labels.expectation} className={box} />
      <select name="locale" className={box} aria-label="locale">
        <option value="nl-BE">NL</option>
        <option value="fr-BE">FR</option>
        <option value="en">EN</option>
      </select>
      <button type="submit" disabled={pending} className="rounded-full bg-[#212842] px-4 py-2 text-sm font-semibold text-[#fffaef] disabled:opacity-50">
        {labels.add}
      </button>
    </form>
  );
}

export function DeleteCase({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} onClick={() => start(async () => void ((await deleteEvalCase({ id })).ok && router.refresh()))} className="rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-accent" aria-label={label}>
      ×
    </button>
  );
}

export function RunEval({ models, labels }: { models: { id: string; label: string }[]; labels: { run: string; hint: string; started: string } }) {
  const [chosen, setChosen] = useState<string[]>(models.slice(0, 2).map((m) => m.id));
  const [pending, start] = useTransition();
  const [started, setStarted] = useState(false);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {models.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm has-[:checked]:border-[#212842] has-[:checked]:bg-[#212842] has-[:checked]:text-[#fffaef]">
            <input
              type="checkbox"
              className="sr-only"
              checked={chosen.includes(m.id)}
              onChange={(e) => setChosen((c) => (e.target.checked ? [...c, m.id].slice(-4) : c.filter((x) => x !== m.id)))}
            />
            {m.label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || !chosen.length}
          onClick={() => start(async () => setStarted((await runEvaluation({ models: chosen })).ok))}
          className="site-gold rounded-full px-5 py-2 text-sm font-semibold text-[#212842] disabled:opacity-50"
        >
          {labels.run}
        </button>
        <span className="text-xs text-muted-foreground">{started ? `✓ ${labels.started}. ` : ""}{labels.hint}</span>
      </div>
    </div>
  );
}
