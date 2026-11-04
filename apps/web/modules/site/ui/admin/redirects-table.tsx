"use client";
/**
 * Redirects table (site spec section 5 `/admin/site/redirects`): from, to, source, permanent,
 * "seen at least n times" and last seen; add, edit, delete (`site.publish`), filter by source,
 * search, and CSV export of the rows shown.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Checkbox, EmptyState, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { deleteRedirect, upsertRedirect } from "../../actions/redirects";
import type { AdminRedirectRow, EditorPickers, SiteAdminLabels } from "../../queries/admin";
import { lbl, selectClass } from "./pickers";

type Draft = { id?: string; fromPath: string; mode: "page" | "url"; pageId: string; locale: Locale; url: string; isPermanent: boolean };
const empty: Draft = { fromPath: "", mode: "url", pageId: "", locale: "nl-BE", url: "", isPermanent: true };

function csv(rows: AdminRedirectRow[]): string {
  const q = (s: string | number | boolean | null) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = ["from_path", "to", "source", "is_permanent", "hits", "last_hit_at"];
  return [head.join(","), ...rows.map((r) => [r.fromPath, r.toUrl ?? `${r.toPageId}:${r.toLocale}`, r.source, r.isPermanent, r.hits, r.lastHitAt].map(q).join(","))].join("\n");
}

export function RedirectsTable({ rows, L, pickers, canEdit, locale }: { rows: AdminRedirectRow[]; L: SiteAdminLabels; pickers: EditorPickers; canEdit: boolean; locale: Locale }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" }).format(new Date(iso)) : "—");
  const save = () =>
    start(async () => {
      if (!draft) return;
      const res = await upsertRedirect({
        ...(draft.id ? { id: draft.id } : {}),
        fromPath: draft.fromPath,
        to: draft.mode === "page" ? { pageId: draft.pageId, locale: draft.locale } : { url: draft.url },
        isPermanent: draft.isPermanent,
      });
      if (res.ok) {
        setDraft(null);
        setMsg(null);
        router.refresh();
      } else setMsg(res.error.message === "live_path" ? lbl(L, "redirects.livePath") : res.error.fields ? Object.values(res.error.fields).join("; ") : res.error.message);
    });
  const download = () => {
    const blob = new Blob([csv(rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "redirects.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {canEdit ? (
          <Button type="button" onClick={() => setDraft({ ...empty })}>
            {lbl(L, "redirects.add")}
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={download} disabled={!rows.length}>
          {lbl(L, "redirects.exportCsv")}
        </Button>
      </div>
      {draft ? (
        <section className="grid gap-2 rounded-md border p-3" aria-label={lbl(L, "redirects.add")}>
          <Input aria-label={lbl(L, "redirects.from")} placeholder="/nl/oud-adres" value={draft.fromPath} onChange={(e) => setDraft({ ...draft, fromPath: e.target.value })} />
          <select aria-label={lbl(L, "redirects.to")} className={selectClass} value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft["mode"] })}>
            <option value="url">{lbl(L, "block.link.url")}</option>
            <option value="page">{lbl(L, "block.link.page")}</option>
          </select>
          {draft.mode === "url" ? (
            <Input aria-label={lbl(L, "block.link.url")} placeholder="/nl/nieuw of https://" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <select aria-label={lbl(L, "block.link.page")} className={selectClass} value={draft.pageId} onChange={(e) => setDraft({ ...draft, pageId: e.target.value })}>
                <option value="">—</option>
                {pickers.pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <select aria-label="locale" className={selectClass} value={draft.locale} onChange={(e) => setDraft({ ...draft, locale: e.target.value as Locale })}>
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={draft.isPermanent} onCheckedChange={(v) => setDraft({ ...draft, isPermanent: v === true })} />
            {lbl(L, "redirects.permanent")}
          </label>
          <div className="flex gap-2">
            <Button type="button" disabled={pending} onClick={save}>
              {lbl(L, "editor.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
              {lbl(L, "common.cancel")}
            </Button>
          </div>
          {msg ? (
            <p role="status" className="text-sm text-destructive">
              {msg}
            </p>
          ) : null}
        </section>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={lbl(L, "redirects.empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{lbl(L, "redirects.from")}</TableHead>
              <TableHead>{lbl(L, "redirects.to")}</TableHead>
              <TableHead>{lbl(L, "redirects.source")}</TableHead>
              <TableHead>{lbl(L, "redirects.permanent")}</TableHead>
              <TableHead>{lbl(L, "redirects.lastSeen")}</TableHead>
              <TableHead>
                <span className="sr-only">{lbl(L, "common.edit")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.fromPath}</TableCell>
                <TableCell className="text-sm">{r.toLabel}</TableCell>
                <TableCell>
                  <Badge variant="outline">{lbl(L, `redirects.sourceKind.${r.source}`)}</Badge>
                </TableCell>
                <TableCell>{r.isPermanent ? "308" : "307"}</TableCell>
                <TableCell className="text-xs">
                  {r.hits ? lbl(L, "redirects.seen", { count: r.hits }) : "—"}
                  <div>{date(r.lastHitAt)}</div>
                </TableCell>
                <TableCell className="text-right">
                  {canEdit ? (
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setDraft({ id: r.id, fromPath: r.fromPath, mode: r.toUrl ? "url" : "page", pageId: r.toPageId ?? "", locale: r.toLocale ?? "nl-BE", url: r.toUrl ?? "", isPermanent: r.isPermanent })}
                      >
                        {lbl(L, "common.edit")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            const res = await deleteRedirect({ id: r.id });
                            if (res.ok) router.refresh();
                            else setMsg(res.error.message);
                          })
                        }
                      >
                        {lbl(L, "editor.delete")}
                      </Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
