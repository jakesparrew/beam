"use client";
/**
 * SEO tab of the editor (site rule 5, section 5): title (1-70 characters) and description
 * (50-170) with counters, social sharing image and the noindex switch, per locale.
 */
import { useId } from "react";
import { Checkbox, Input, Label, Textarea } from "@beam/ui";
import { SEO_DESCRIPTION_MAX, SEO_DESCRIPTION_MIN, SEO_TITLE_MAX, SEO_TITLE_MIN, type PageSeo } from "@beam/core/site";
import type { EditorPickers, SiteAdminLabels } from "../../queries/admin";
import { lbl, MediaPicker } from "./pickers";

function Counter({ L, count, min, max }: { L: SiteAdminLabels; count: number; min: number; max: number }) {
  const bad = count < min || count > max;
  return (
    <p className={`text-xs ${bad ? "text-destructive" : "text-muted-foreground"}`} aria-live="polite">
      {lbl(L, "editor.counter", { count, max })}
    </p>
  );
}

export function SeoFields({ L, pickers, value, onChange }: { L: SiteAdminLabels; pickers: EditorPickers; value: PageSeo | undefined; onChange: (v: PageSeo) => void }) {
  const titleId = useId();
  const descId = useId();
  const noindexId = useId();
  const seo: PageSeo = value ?? { title: "", description: "" };
  const set = (patch: Partial<PageSeo>) => {
    const next = { ...seo, ...patch } as PageSeo & Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) if (v === undefined || v === false) delete next[k];
    onChange(next);
  };
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <Label htmlFor={titleId}>{lbl(L, "editor.seoTitle")}</Label>
        <Input id={titleId} value={seo.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
        <Counter L={L} count={seo.title.trim().length} min={SEO_TITLE_MIN} max={SEO_TITLE_MAX} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={descId}>{lbl(L, "editor.seoDescription")}</Label>
        <Textarea id={descId} value={seo.description} maxLength={400} onChange={(e) => set({ description: e.target.value })} />
        <Counter L={L} count={seo.description.trim().length} min={SEO_DESCRIPTION_MIN} max={SEO_DESCRIPTION_MAX} />
      </div>
      <MediaPicker L={L} pickers={pickers} label={lbl(L, "editor.ogImage")} value={seo.ogImageMediaId} onChange={(v) => set({ ogImageMediaId: v })} />
      <div className="flex items-center gap-2">
        <Checkbox id={noindexId} checked={!!seo.noindex} onCheckedChange={(v) => set({ noindex: v === true ? true : undefined })} />
        <Label htmlFor={noindexId}>{lbl(L, "editor.noindex")}</Label>
      </div>
    </div>
  );
}
