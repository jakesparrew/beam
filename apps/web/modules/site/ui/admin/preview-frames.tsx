"use client";
/**
 * Rendered previews of the base and the reviewed version side by side (site spec section 5 review
 * screen, "toggle to rendered previews (two iframes)"). Both load `/<prefix>/preview/<versionId>`,
 * which requires a staff session with `site.edit` and answers `noindex`, `private, no-store`. The
 * frames load only when the toggle is switched on.
 */
import { useState } from "react";
import { Checkbox } from "@beam/ui";
import type { SiteAdminLabels } from "../../queries/admin";
import { lbl } from "./pickers";

export function PreviewFrames({ L, base, versionId, version, prefix }: { L: SiteAdminLabels; base: { versionId: string; version: number } | null; versionId: string; version: number; prefix: string }) {
  const [on, setOn] = useState(false);
  return (
    <section className="grid gap-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={on} onCheckedChange={(v) => setOn(v === true)} data-testid="preview-toggle" />
        {lbl(L, "diff.renderedToggle")}
      </label>
      {on ? (
        <div className={`grid gap-3 ${base ? "xl:grid-cols-2" : ""}`}>
          {base ? (
            <figure className="grid gap-1">
              <figcaption className="text-xs text-muted-foreground">{lbl(L, "diff.base", { n: base.version })}</figcaption>
              <iframe title={lbl(L, "diff.base", { n: base.version })} src={`/${prefix}/preview/${base.versionId}`} className="h-[70vh] w-full rounded-md border" loading="lazy" />
            </figure>
          ) : null}
          <figure className="grid gap-1">
            <figcaption className="text-xs text-muted-foreground">{lbl(L, "editor.history.version", { n: version })}</figcaption>
            <iframe title={lbl(L, "editor.history.version", { n: version })} src={`/${prefix}/preview/${versionId}`} className="h-[70vh] w-full rounded-md border" loading="lazy" />
          </figure>
        </div>
      ) : null}
    </section>
  );
}
