"use client";
/**
 * Version history of a page (site spec section 5 editor): every version with its state, its
 * author ("Claude for <user>" for proposals), its publish or schedule date, and "Restore this
 * version" (rule 4: a new draft copied from version n). Proposals link to their review screen.
 */
import { useState, useTransition } from "react";
import NextLink from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { Locale } from "@beam/core/i18n";
import { createDraftFromVersion } from "../../actions/pages";
import type { HistoryRow, SiteAdminLabels } from "../../queries/admin";
import { lbl } from "./pickers";

export function VersionHistory({ L, pageId, rows, hasDraft, locale }: { L: SiteAdminLabels; pageId: string; rows: HistoryRow[]; hasDraft: boolean; locale: Locale }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" }).format(new Date(iso)) : "—");
  if (!rows.length) return <p className="text-sm text-muted-foreground">{lbl(L, "editor.history.empty")}</p>;
  const restore = (versionId: string) =>
    start(async () => {
      setError(null);
      if (hasDraft && !window.confirm(lbl(L, "editor.discardDraft"))) return;
      const res = await createDraftFromVersion({ pageId, fromVersionId: versionId, replaceExisting: hasDraft });
      if (!res.ok) setError(res.error.message);
      else router.refresh();
    });
  return (
    <div className="grid gap-2">
      {error ? (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{lbl(L, "editor.history.version", { n: "" }).trim()}</TableHead>
            <TableHead>{lbl(L, "pages.col.status")}</TableHead>
            <TableHead>{lbl(L, "diff.requestedBy", { name: "" }).trim()}</TableHead>
            <TableHead>{lbl(L, "pages.col.lastPublished")}</TableHead>
            <TableHead>
              <span className="sr-only">{lbl(L, "editor.restoreVersion")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.versionId}>
              <TableCell>{lbl(L, "editor.history.version", { n: r.version })}</TableCell>
              <TableCell>
                <Badge variant={r.isLive ? "success" : r.state === "proposed" ? "warning" : "outline"}>{r.isLive ? lbl(L, "state.liveVersion", { n: r.version }) : lbl(L, `state.${r.state}`)}</Badge>
                {r.scheduledPublishAt ? <span className="ml-2 text-xs">{lbl(L, "state.scheduled", { date: date(r.scheduledPublishAt) })}</span> : null}
              </TableCell>
              <TableCell>{r.createdBy === "claude" ? lbl(L, "state.createdByClaude", { name: r.createdByName ?? "" }) : (r.createdByName ?? "—")}</TableCell>
              <TableCell>{date(r.publishedAt)}</TableCell>
              <TableCell className="text-right">
                {r.state === "proposed" ? (
                  <NextLink className="text-sm underline" href={`/admin/site/pages/${pageId}/versions/${r.versionId}` as Route}>
                    {lbl(L, "claude.ready")}
                  </NextLink>
                ) : r.state !== "draft" ? (
                  <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => restore(r.versionId)}>
                    {lbl(L, "editor.restoreVersion")}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
