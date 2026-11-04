"use client";
/**
 * Pickers of the page editor (site spec section 5): media, page links, products, event sessions
 * and forms, plus the label helper the admin client components share. Options come from
 * `getEditorPickers()` on the server; every string comes from the `site.admin` catalogue.
 */
import { useId } from "react";
import { Input, Label } from "@beam/ui";
import { PORTAL_ROUTES, type Link } from "@beam/core/site";
import type { EditorPickers, SiteAdminLabels } from "../../queries/admin";

export const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** A label from the flattened `site.admin` catalogue with `{name}` parameters filled in. */
export function lbl(L: SiteAdminLabels, key: string, params?: Record<string, string | number>): string {
  const template = L[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

type SelectProps = { label: string; value: string; onChange: (v: string) => void; options: { id: string; label: string; hint?: string }[]; empty?: string; required?: boolean };

export function OptionSelect({ label, value, onChange, options, empty, required }: SelectProps) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)} aria-required={required}>
        <option value="">{empty ?? "—"}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.hint ? `${o.label} (${o.hint})` : o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function MediaPicker({ L, pickers, label, value, onChange }: { L: SiteAdminLabels; pickers: EditorPickers; label: string; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const chosen = pickers.media.find((m) => m.id === value);
  return (
    <div className="grid gap-1">
      <OptionSelect label={label} value={value ?? ""} onChange={(v) => onChange(v || undefined)} options={pickers.media.map((m) => ({ id: m.id, label: m.label, hint: `${m.width}×${m.height}` }))} />
      {chosen ? (
        // Admin thumbnail of a public image; `next/image` is for the public site.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/public/files/${chosen.fileId}`} alt={chosen.alt.en ?? chosen.label} width={96} height={Math.max(1, Math.round((96 * chosen.height) / chosen.width))} className="rounded border" />
      ) : null}
      {chosen && !chosen.isDecorative && !(chosen.alt["nl-BE"] && chosen.alt["fr-BE"] && chosen.alt.en) ? <p className="text-xs text-destructive">{lbl(L, "media.altIncomplete")}</p> : null}
    </div>
  );
}

/** Link target: a page, a site path or https URL, or a portal route. */
export function LinkPicker({ L, pickers, label, value, onChange }: { L: SiteAdminLabels; pickers: EditorPickers; label: string; value: Link | undefined; onChange: (v: Link) => void }) {
  const id = useId();
  const kind = value?.kind ?? "page";
  return (
    <fieldset className="grid gap-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-3 text-sm">
        {(["page", "url", "portal"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1">
            <input
              type="radio"
              name={`${id}-kind`}
              checked={kind === k}
              onChange={() => onChange(k === "page" ? { kind: "page", pageId: pickers.pages[0]?.id ?? "" } : k === "url" ? { kind: "url", href: "" } : { kind: "portal", route: "home" })}
            />
            {lbl(L, `block.link.${k}`)}
          </label>
        ))}
      </div>
      {value?.kind === "url" ? (
        <Input aria-label={lbl(L, "block.link.url")} value={value.href} placeholder="https://" onChange={(e) => onChange({ kind: "url", href: e.target.value })} />
      ) : value?.kind === "portal" ? (
        <select aria-label={lbl(L, "block.link.portal")} className={selectClass} value={value.route} onChange={(e) => onChange({ kind: "portal", route: e.target.value as (typeof PORTAL_ROUTES)[number] })}>
          {PORTAL_ROUTES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      ) : (
        <select aria-label={lbl(L, "block.link.page")} className={selectClass} value={value?.kind === "page" ? value.pageId : ""} onChange={(e) => onChange({ kind: "page", pageId: e.target.value })}>
          <option value="">—</option>
          {pickers.pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({lbl(L, `status.${p.status}`)})
            </option>
          ))}
        </select>
      )}
    </fieldset>
  );
}

export function ProductMultiPicker({ label, pickers, value, onChange }: { label: string; pickers: EditorPickers; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="grid gap-1 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      {pickers.products.map((p) => (
        <label key={p.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.includes(p.id)} onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))} />
          {p.label} <span className="text-muted-foreground">{p.hint}</span>
        </label>
      ))}
    </fieldset>
  );
}
