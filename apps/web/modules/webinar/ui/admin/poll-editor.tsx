"use client";
/**
 * Poll editor of `/admin/webinars/[id]/interactive` (webinar spec 5.1, rules 33-35, edge cases
 * 15 and 16): key, question and option labels per page language, single or multiple choice,
 * the replay position `show_at_sec` (entered as mm:ss; empty = live launch only), how long it
 * shows, tag rules (option keys, tag key, modes) and the order, with the answer counts per mode.
 * A poll with answers keeps its key, question and options (the server answers `poll_answered`);
 * deleting it then deactivates it. Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Checkbox, FormField, Input, LocalizedInput, type LocalizedInputLabels, type LocalizedValue } from "@beam/ui";
import { deletePoll, upsertPoll } from "../../actions";
import { Message, failureText, fieldLines } from "./webinar-form";

type Locale = "nl-BE" | "fr-BE" | "en";
type WatchMode = "live" | "replay" | "on_demand";
const WATCH_MODES: readonly WatchMode[] = ["live", "replay", "on_demand"];

/** `mm:ss` (or plain seconds) -> seconds; "" -> null; invalid -> NaN. */
export function parseMmSs(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(v);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return /^\d+$/.test(v) ? Number(v) : Number.NaN;
}

export function formatMmSs(sec: number | null): string {
  if (sec === null || sec === undefined) return "";
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

export type PollItem = {
  id?: string;
  key: string;
  question: LocalizedValue<Locale>;
  options: Array<{ key: string; label: LocalizedValue<Locale> }>;
  allowMultiple: boolean;
  showAtSec: number | null;
  showForSec: number;
  tagRules: Array<{ option_keys: string[]; tag_key: string; modes: WatchMode[] }>;
  sortOrder: number;
  isActive: boolean;
  answers: Record<WatchMode, number>;
};

export type PollEditorLabels = {
  polls: string;
  addPoll: string;
  edit: string;
  key: string;
  keyHint: string;
  question: LocalizedInputLabels<Locale>;
  options: string;
  optionKey: string;
  optionLabel: LocalizedInputLabels<Locale>;
  addOption: string;
  removeOption: string;
  allowMultiple: string;
  showAt: string;
  showAtHint: string;
  showFor: string;
  tagRules: string;
  tagRuleOptions: string;
  tagRuleTag: string;
  tagRuleModes: string;
  addTagRule: string;
  removeTagRule: string;
  sortOrder: string;
  active: string;
  inactive: string;
  delete: string;
  deleted: string;
  deactivated: string;
  /** `{live}`, `{replay}`, `{on_demand}` left in. */
  answers: string;
  watchModes: Record<WatchMode, string>;
  save: string;
  saved: string;
  close: string;
  describeField: Record<string, string>;
  errors: Record<string, string>;
};

const blank = (): PollItem => ({
  key: "",
  question: {},
  options: [
    { key: "a", label: {} },
    { key: "b", label: {} },
  ],
  allowMultiple: false,
  showAtSec: null,
  showForSec: 120,
  tagRules: [],
  sortOrder: 0,
  isActive: true,
  answers: { live: 0, replay: 0, on_demand: 0 },
});

function PollForm({ webinarId, initial, locales, labels, onDone }: { webinarId: string; initial: PollItem; locales: Locale[]; labels: PollEditorLabels; onDone: () => void }) {
  const router = useRouter();
  const [poll, setPoll] = useState<PollItem>(initial);
  const [showAt, setShowAt] = useState(formatMmSs(initial.showAtSec));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string; lines?: string[] } | null>(null);
  const set = (patch: Partial<PollItem>) => setPoll((p) => ({ ...p, ...patch }));
  const answered = WATCH_MODES.some((m) => initial.answers[m] > 0);

  async function save() {
    setPending(true);
    setMessage(null);
    try {
      const res = await upsertPoll({
        webinarId,
        ...(poll.id ? { pollId: poll.id } : {}),
        key: poll.key.trim(),
        question: poll.question,
        options: poll.options.map((o) => ({ key: o.key.trim(), label: o.label })),
        allowMultiple: poll.allowMultiple,
        showAtSec: parseMmSs(showAt),
        showForSec: poll.showForSec,
        tagRules: poll.tagRules,
        sortOrder: poll.sortOrder,
      });
      if (res.ok) {
        setMessage({ error: false, text: labels.saved });
        router.refresh();
        onDone();
      } else {
        setMessage({ error: true, text: failureText(labels.errors, res.error), lines: fieldLines(res.error.fields, (f, v) => `${labels.describeField[f.split(".")[0]!] ?? f}: ${v}`) });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4 rounded-md border p-4">
      <Message message={message} />
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={labels.key} hint={labels.keyHint} required>
          <Input value={poll.key} onChange={(e) => set({ key: e.target.value })} pattern="[a-z0-9_]{1,40}" maxLength={40} disabled={answered} required />
        </FormField>
        <FormField label={labels.showAt} hint={labels.showAtHint}>
          <Input value={showAt} onChange={(e) => setShowAt(e.target.value)} placeholder="mm:ss" inputMode="numeric" />
        </FormField>
        <FormField label={labels.showFor}>
          <Input type="number" min={15} max={1800} value={poll.showForSec} onChange={(e) => set({ showForSec: Number(e.target.value) })} />
        </FormField>
      </div>
      <LocalizedInput name="question" value={poll.question} onChange={(v) => set({ question: v })} locales={locales} labels={labels.question} disabled={answered} />
      <fieldset className="grid gap-3" disabled={answered}>
        <legend className="text-sm font-medium">{labels.options}</legend>
        {poll.options.map((o, i) => (
          <div key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[10rem_1fr_auto] sm:items-start">
            <FormField label={labels.optionKey}>
              <Input value={o.key} onChange={(e) => set({ options: poll.options.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} pattern="[a-z0-9_]{1,20}" maxLength={20} />
            </FormField>
            <LocalizedInput name={`option-${i}`} value={o.label} onChange={(v) => set({ options: poll.options.map((x, j) => (j === i ? { ...x, label: v } : x)) })} locales={locales} labels={labels.optionLabel} />
            {poll.options.length > 2 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => set({ options: poll.options.filter((_, j) => j !== i) })}>
                {labels.removeOption}
              </Button>
            ) : null}
          </div>
        ))}
        {poll.options.length < 8 ? (
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ options: [...poll.options, { key: `o${poll.options.length + 1}`, label: {} }] })}>
              {labels.addOption}
            </Button>
          </div>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={poll.allowMultiple} onCheckedChange={(v) => set({ allowMultiple: v === true })} />
          {labels.allowMultiple}
        </label>
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">{labels.tagRules}</legend>
        {poll.tagRules.map((r, i) => {
          const patch = (p: Partial<PollItem["tagRules"][number]>) => set({ tagRules: poll.tagRules.map((x, j) => (j === i ? { ...x, ...p } : x)) });
          return (
            <div key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-3 sm:items-end">
              <FormField label={labels.tagRuleOptions}>
                <Input value={r.option_keys.join(",")} onChange={(e) => patch({ option_keys: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
              </FormField>
              <FormField label={labels.tagRuleTag}>
                <Input value={r.tag_key} onChange={(e) => patch({ tag_key: e.target.value.trim() })} maxLength={80} />
              </FormField>
              <fieldset className="grid gap-1">
                <legend className="text-sm">{labels.tagRuleModes}</legend>
                <div className="flex flex-wrap gap-3">
                  {WATCH_MODES.map((m) => (
                    <label key={m} className="flex items-center gap-1 text-sm">
                      <Checkbox
                        checked={r.modes.includes(m)}
                        onCheckedChange={(v) => patch({ modes: v === true ? WATCH_MODES.filter((x) => x === m || r.modes.includes(x)) : r.modes.filter((x) => x !== m) })}
                      />
                      {labels.watchModes[m]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div>
                <Button type="button" variant="ghost" size="sm" onClick={() => set({ tagRules: poll.tagRules.filter((_, j) => j !== i) })}>
                  {labels.removeTagRule}
                </Button>
              </div>
            </div>
          );
        })}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => set({ tagRules: [...poll.tagRules, { option_keys: [], tag_key: "", modes: ["live"] }] })}>
            {labels.addTagRule}
          </Button>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <FormField label={labels.sortOrder}>
          <Input type="number" min={0} max={1000} value={poll.sortOrder} onChange={(e) => set({ sortOrder: Number(e.target.value) })} className="w-24" />
        </FormField>
        <Button type="button" disabled={pending || !poll.key} onClick={() => void save()}>
          {labels.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {labels.close}
        </Button>
      </div>
    </div>
  );
}

export function PollEditor({ webinarId, polls, locales, editable, labels }: { webinarId: string; polls: PollItem[]; locales: Locale[]; editable: boolean; labels: PollEditorLabels }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function remove(id: string) {
    const res = await deletePoll({ pollId: id });
    if (res.ok) {
      setMessage({ error: false, text: res.data.deactivated ? labels.deactivated : labels.deleted });
      router.refresh();
    } else setMessage({ error: true, text: failureText(labels.errors, res.error) });
  }

  const answersText = (a: Record<WatchMode, number>) => labels.answers.replace("{live}", String(a.live)).replace("{replay}", String(a.replay)).replace("{on_demand}", String(a.on_demand));

  return (
    <section aria-labelledby="polls-title" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="polls-title" className="text-lg font-semibold">
          {labels.polls}
        </h2>
        {editable && editing !== "new" ? (
          <Button type="button" variant="outline" onClick={() => setEditing("new")}>
            {labels.addPoll}
          </Button>
        ) : null}
      </div>
      <Message message={message} />
      {editing === "new" ? <PollForm webinarId={webinarId} initial={{ ...blank(), sortOrder: polls.length }} locales={locales} labels={labels} onDone={() => setEditing(null)} /> : null}
      <ul className="grid gap-2">
        {polls.map((p) => (
          <li key={p.id} className="grid gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <code>{p.key}</code>
              <span className="font-medium">{p.question[locales[0]!] ?? Object.values(p.question)[0] ?? ""}</span>
              <Badge variant={p.isActive ? "outline" : "secondary"}>{p.isActive ? labels.active : labels.inactive}</Badge>
              <span className="text-muted-foreground">{formatMmSs(p.showAtSec) || "—"}</span>
              <span className="text-muted-foreground">{answersText(p.answers)}</span>
              {editable ? (
                <span className="ml-auto flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditing(p.id!)}>
                    {labels.edit}
                  </Button>
                  {p.isActive ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => void remove(p.id!)}>
                      {labels.delete}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </div>
            {editing === p.id ? <PollForm webinarId={webinarId} initial={p} locales={locales} labels={labels} onDone={() => setEditing(null)} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
