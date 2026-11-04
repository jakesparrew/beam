"use client";
/**
 * CTA editor of `/admin/webinars/[id]/interactive` (webinar spec 5.1, rules 34 and 36): key,
 * button text per page language, https link, replay position (mm:ss; empty = live only), how
 * long it shows and the order, with shown and clicked counts. Once shown, key and link are fixed
 * (`cta_shown`) and deleting deactivates it. Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, FormField, Input, LocalizedInput, type LocalizedInputLabels, type LocalizedValue } from "@beam/ui";
import { deleteCta, upsertCta } from "../../actions";
import { formatMmSs, parseMmSs } from "./poll-editor";
import { Message, failureText, fieldLines } from "./webinar-form";

type Locale = "nl-BE" | "fr-BE" | "en";
type Counts = { live: number; replay: number; on_demand: number };

export type CtaItem = {
  id?: string;
  key: string;
  label: LocalizedValue<Locale>;
  url: string;
  showAtSec: number | null;
  showForSec: number;
  sortOrder: number;
  isActive: boolean;
  shown: Counts;
  clicked: Counts;
};

export type CtaEditorLabels = {
  ctas: string;
  addCta: string;
  edit: string;
  key: string;
  keyHint: string;
  label: LocalizedInputLabels<Locale>;
  url: string;
  showAt: string;
  showAtHint: string;
  showFor: string;
  sortOrder: string;
  active: string;
  inactive: string;
  delete: string;
  deleted: string;
  deactivated: string;
  /** `{shown}` and `{clicked}` left in. */
  counts: string;
  save: string;
  saved: string;
  close: string;
  errors: Record<string, string>;
};

const total = (c: Counts) => c.live + c.replay + c.on_demand;

function CtaForm({ webinarId, initial, locales, labels, onDone }: { webinarId: string; initial: CtaItem; locales: Locale[]; labels: CtaEditorLabels; onDone: () => void }) {
  const router = useRouter();
  const [cta, setCta] = useState(initial);
  const [showAt, setShowAt] = useState(formatMmSs(initial.showAtSec));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string; lines?: string[] } | null>(null);
  const shown = total(initial.shown) + total(initial.clicked) > 0;
  const set = (patch: Partial<CtaItem>) => setCta((c) => ({ ...c, ...patch }));

  async function save() {
    setPending(true);
    setMessage(null);
    try {
      const res = await upsertCta({
        webinarId,
        ...(cta.id ? { ctaId: cta.id } : {}),
        key: cta.key.trim(),
        label: cta.label,
        url: cta.url.trim(),
        showAtSec: parseMmSs(showAt),
        showForSec: cta.showForSec,
        sortOrder: cta.sortOrder,
      });
      if (res.ok) {
        setMessage({ error: false, text: labels.saved });
        router.refresh();
        onDone();
      } else setMessage({ error: true, text: failureText(labels.errors, res.error), lines: fieldLines(res.error.fields, (f, v) => `${f}: ${v}`) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4 rounded-md border p-4">
      <Message message={message} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={labels.key} hint={labels.keyHint} required>
          <Input value={cta.key} onChange={(e) => set({ key: e.target.value })} pattern="[a-z0-9_]{1,40}" maxLength={40} disabled={shown} required />
        </FormField>
        <FormField label={labels.url} required>
          <Input type="url" value={cta.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://" maxLength={2000} disabled={shown} required />
        </FormField>
      </div>
      <LocalizedInput name="label" value={cta.label} onChange={(v) => set({ label: v })} locales={locales} labels={labels.label} />
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={labels.showAt} hint={labels.showAtHint}>
          <Input value={showAt} onChange={(e) => setShowAt(e.target.value)} placeholder="mm:ss" inputMode="numeric" />
        </FormField>
        <FormField label={labels.showFor}>
          <Input type="number" min={15} max={7200} value={cta.showForSec} onChange={(e) => set({ showForSec: Number(e.target.value) })} />
        </FormField>
        <FormField label={labels.sortOrder}>
          <Input type="number" min={0} max={1000} value={cta.sortOrder} onChange={(e) => set({ sortOrder: Number(e.target.value) })} />
        </FormField>
      </div>
      <div className="flex gap-3">
        <Button type="button" disabled={pending || !cta.key || !cta.url} onClick={() => void save()}>
          {labels.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {labels.close}
        </Button>
      </div>
    </div>
  );
}

export function CtaEditor({ webinarId, ctas, locales, editable, labels }: { webinarId: string; ctas: CtaItem[]; locales: Locale[]; editable: boolean; labels: CtaEditorLabels }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const blank: CtaItem = { key: "", label: {}, url: "https://", showAtSec: null, showForSec: 300, sortOrder: ctas.length, isActive: true, shown: { live: 0, replay: 0, on_demand: 0 }, clicked: { live: 0, replay: 0, on_demand: 0 } };

  async function remove(id: string) {
    const res = await deleteCta({ ctaId: id });
    if (res.ok) {
      setMessage({ error: false, text: res.data.deactivated ? labels.deactivated : labels.deleted });
      router.refresh();
    } else setMessage({ error: true, text: failureText(labels.errors, res.error) });
  }

  return (
    <section aria-labelledby="ctas-title" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ctas-title" className="text-lg font-semibold">
          {labels.ctas}
        </h2>
        {editable && editing !== "new" ? (
          <Button type="button" variant="outline" onClick={() => setEditing("new")}>
            {labels.addCta}
          </Button>
        ) : null}
      </div>
      <Message message={message} />
      {editing === "new" ? <CtaForm webinarId={webinarId} initial={blank} locales={locales} labels={labels} onDone={() => setEditing(null)} /> : null}
      <ul className="grid gap-2">
        {ctas.map((c) => (
          <li key={c.id} className="grid gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <code>{c.key}</code>
              <span className="font-medium">{c.label[locales[0]!] ?? Object.values(c.label)[0] ?? ""}</span>
              <span className="truncate text-muted-foreground">{c.url}</span>
              <Badge variant={c.isActive ? "outline" : "secondary"}>{c.isActive ? labels.active : labels.inactive}</Badge>
              <span className="text-muted-foreground">{formatMmSs(c.showAtSec) || "—"}</span>
              <span className="text-muted-foreground">{labels.counts.replace("{shown}", String(total(c.shown))).replace("{clicked}", String(total(c.clicked)))}</span>
              {editable ? (
                <span className="ml-auto flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditing(c.id!)}>
                    {labels.edit}
                  </Button>
                  {c.isActive ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => void remove(c.id!)}>
                      {labels.delete}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </div>
            {editing === c.id ? <CtaForm webinarId={webinarId} initial={c} locales={locales} labels={labels} onDone={() => setEditing(null)} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
