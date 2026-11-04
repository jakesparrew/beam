"use client";

/**
 * Endings (rule F5; forms-P5): kind (`result`, `thank_you`, `redirect`), title and body, score
 * and dimensions shown, up to four CTAs (booking, event, product, experience, webinar, URL) and the
 * result email texts. CTA targets are checked at publish and nightly (P7); a broken one is listed
 * on the overview.
 */
import { CTA_KINDS, FORM_LIMITS, type Cta, type Ending } from "@beam/core/forms";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { Button, Input, LocalizedInput, Switch } from "@beam/ui";
import { selectClass } from "./condition-builder";
import { textLabels } from "./field-editor";
import { lbl, type Labels } from "./issues-panel";

export type EndingEditorProps = {
  endings: Ending[];
  onChange: (e: Ending[]) => void;
  locales: Locale[];
  localeNames: Record<Locale, string>;
  dimensionKeys: readonly string[];
  labels: Labels;
  /** `cta_warnings` of the overview, to flag broken CTAs. */
  brokenCtas?: readonly { endingKey: string; ctaKey: string; reason: string }[];
};

const TARGET: Record<Cta["kind"], keyof Cta | null> = {
  booking: "sessionTemplateId",
  experience: "sessionTemplateId",
  event: "sessionId",
  product: "productId",
  webinar: "webinarId",
  url: "url",
};

function CtaRow({ cta, onChange, onRemove, p, broken }: { cta: Cta; onChange: (c: Cta) => void; onRemove: () => void; p: EndingEditorProps; broken: string | null }) {
  const tl = textLabels(p.labels, p.localeNames);
  const target = TARGET[cta.kind];
  return (
    <div className="grid gap-2 rounded-md border p-2" data-cta={cta.key}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "builder.key")}
          <Input className="h-8 w-32 font-mono" value={cta.key} onChange={(e) => onChange({ ...cta, key: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs">
          {lbl(p.labels, "builder.ending.cta_kind")}
          <select className={selectClass} value={cta.kind} onChange={(e) => onChange({ key: cta.key, label: cta.label, kind: e.target.value as Cta["kind"] })}>
            {CTA_KINDS.map((k) => (
              <option key={k} value={k}>
                {lbl(p.labels, `builder.cta.${k}`)}
              </option>
            ))}
          </select>
        </label>
        {target ? (
          <label className="grid gap-1 text-xs">
            {lbl(p.labels, target === "url" ? "builder.ending.cta_url" : "builder.ending.cta_target")}
            <Input className="h-8 w-80 font-mono" value={(cta[target] as string | undefined) ?? ""} onChange={(e) => onChange({ ...cta, [target]: e.target.value || undefined })} />
          </label>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          {lbl(p.labels, "builder.remove")}
        </Button>
      </div>
      {broken ? (
        <p className="text-xs text-destructive" role="note">
          {lbl(p.labels, `builder.cta_warning.${broken}`)}
        </p>
      ) : null}
      <LocalizedInput name={`cta-${cta.key}`} value={cta.label} locales={p.locales} labels={tl("builder.ending.cta_label")} onChange={(label) => onChange({ ...cta, label: label as LocalizedText })} />
    </div>
  );
}

export function EndingEditor(p: EndingEditorProps) {
  const { endings, onChange, labels } = p;
  const tl = textLabels(labels, p.localeNames);
  const set = (i: number, patch: Partial<Ending>) => onChange(endings.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const nextKey = (base: string, taken: readonly string[]) => {
    let n = taken.length + 1;
    while (taken.includes(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  };
  return (
    <div className="grid gap-4">
      {endings.map((e, i) => (
        <section key={i} id={`ending-${e.key}`} className="grid gap-3 rounded-md border p-3" aria-label={e.key}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs">
              {lbl(labels, "builder.key")}
              <Input className="h-8 w-40 font-mono" value={e.key} onChange={(ev) => set(i, { key: ev.target.value })} />
            </label>
            <label className="grid gap-1 text-xs">
              {lbl(labels, "builder.ending.kind")}
              <select className={selectClass} value={e.kind} onChange={(ev) => set(i, { kind: ev.target.value as Ending["kind"] })}>
                {(["result", "thank_you", "redirect"] as const).map((k) => (
                  <option key={k} value={k}>
                    {lbl(labels, `builder.ending.kind_${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(endings.filter((_, j) => j !== i))}>
              {lbl(labels, "builder.remove")}
            </Button>
          </div>
          <LocalizedInput name={`ending-${e.key}-title`} value={e.title} locales={p.locales} labels={tl("builder.ending.title")} onChange={(title) => set(i, { title: title as LocalizedText })} />
          <LocalizedInput name={`ending-${e.key}-body`} multiline value={e.body} locales={p.locales} labels={tl("builder.ending.body")} onChange={(body) => set(i, { body: body as LocalizedText })} />
          {e.kind === "redirect" ? (
            <label className="grid gap-1 text-sm">
              {lbl(labels, "builder.ending.redirect_url")}
              <Input className="font-mono" value={e.redirectUrl ?? ""} onChange={(ev) => set(i, { redirectUrl: ev.target.value || undefined })} />
            </label>
          ) : null}
          {e.kind === "result" ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={e.showScore} onCheckedChange={(v) => set(i, { showScore: v })} aria-label={lbl(labels, "builder.ending.show_score")} />
                {lbl(labels, "builder.ending.show_score")}
              </label>
              {p.dimensionKeys.length ? (
                <fieldset className="flex flex-wrap gap-3">
                  <legend className="text-sm">{lbl(labels, "builder.ending.show_dimensions")}</legend>
                  {p.dimensionKeys.map((k) => (
                    <label key={k} className="flex items-center gap-1 text-sm">
                      <input type="checkbox" checked={e.showDimensions.includes(k)} onChange={(ev) => set(i, { showDimensions: ev.target.checked ? [...e.showDimensions, k] : e.showDimensions.filter((x) => x !== k) })} />
                      {k}
                    </label>
                  ))}
                </fieldset>
              ) : null}
            </>
          ) : null}
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{lbl(labels, "builder.ending.ctas")}</legend>
            {e.ctas.map((c, ci) => (
              <CtaRow
                key={ci}
                cta={c}
                p={p}
                broken={p.brokenCtas?.find((w) => w.endingKey === e.key && w.ctaKey === c.key)?.reason ?? null}
                onChange={(next) => set(i, { ctas: e.ctas.map((x, j) => (j === ci ? next : x)) })}
                onRemove={() => set(i, { ctas: e.ctas.filter((_, j) => j !== ci) })}
              />
            ))}
            {e.ctas.length < FORM_LIMITS.ctas ? (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => set(i, { ctas: [...e.ctas, { key: nextKey("cta", e.ctas.map((c) => c.key)), kind: "url", label: {} }] })}>
                  {lbl(labels, "builder.ending.add_cta")}
                </Button>
              </div>
            ) : null}
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{lbl(labels, "builder.ending.email")}</legend>
            {e.email ? (
              <>
                <LocalizedInput name={`ending-${e.key}-subject`} value={e.email.subject} locales={p.locales} labels={tl("builder.ending.email_subject")} onChange={(subject) => set(i, { email: { ...e.email!, subject: subject as LocalizedText } })} />
                <LocalizedInput name={`ending-${e.key}-intro`} multiline value={e.email.intro} locales={p.locales} labels={tl("builder.ending.email_intro")} onChange={(intro) => set(i, { email: { ...e.email!, intro: intro as LocalizedText } })} />
                <div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => set(i, { email: undefined })}>
                    {lbl(labels, "builder.ending.remove_email")}
                  </Button>
                </div>
              </>
            ) : (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => set(i, { email: { subject: {}, intro: {} } })}>
                  {lbl(labels, "builder.ending.add_email")}
                </Button>
              </div>
            )}
          </fieldset>
        </section>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange([...endings, { key: nextKey("ending", endings.map((e) => e.key)), kind: "thank_you", title: {}, body: {}, showScore: false, showDimensions: [], ctas: [] }])}
        >
          {lbl(labels, "builder.ending.add")}
        </Button>
      </div>
    </div>
  );
}
