"use client";
/**
 * One WordPress import (site spec section 5, rules 52-53, 65-66; `site.publish`): status, counts
 * and the conversion report; the mapping table (decision, language, translation group, the
 * `redirect_only` target) while the import is `parsed`, and for `error` items before a retry;
 * "Apply import", "Retry failed items" and "Publish complete imported pages". The screen refreshes
 * every 3 seconds while a job works on the import.
 */
import { useEffect, useState, useTransition } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, EmptyState, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { LOCALES, type Locale } from "@beam/core/i18n";
import type { PublishIssue } from "@beam/core/site";
import { applyWordpressImport, publishImportedPages, retryImportErrors, updateImportItem } from "../../actions/wordpress";
import type { EditorPickers, SiteAdminLabels } from "../../queries/admin";
import type { ImportItemDecision, ImportItemRow, WordpressImportDetail } from "../../queries/wordpress";
import { ImportCounts, importStatusVariant, lblOr } from "./imports-table";
import { lbl, selectClass } from "./pickers";

const DECISIONS: ImportItemDecision[] = ["import", "skip", "redirect_only"];

function ItemRow({ item, L, pages, editable }: { item: ImportItemRow; L: SiteAdminLabels; pages: EditorPickers["pages"]; editable: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState(item.decision);
  const [target, setTarget] = useState(item.redirectToPageId ?? "");
  const save = (patch: { decision?: ImportItemDecision; locale?: Locale | null; translationGroup?: string | null; redirectToPageId?: string | null }) =>
    start(async () => {
      const next = { decision: patch.decision ?? decision, redirectToPageId: (patch.redirectToPageId ?? target) || null };
      if (next.decision === "redirect_only" && !next.redirectToPageId) return;
      const res = await updateImportItem({ itemId: item.itemId, ...patch, ...next });
      setError(res.ok ? null : res.error.message);
      if (res.ok) router.refresh();
    });
  const canEdit = editable && (item.status === "pending" || item.status === "error");
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{item.title}</div>
        <div className="text-xs text-muted-foreground">
          {lbl(L, item.wpType === "attachment" ? "nav.media" : `kind.${item.wpType === "post" ? "post" : "standard"}`)} · #{item.wpId}
        </div>
      </TableCell>
      <TableCell className="max-w-56 truncate font-mono text-xs" title={item.wpPath}>
        {item.wpPath}
      </TableCell>
      <TableCell>{item.wpStatus}</TableCell>
      <TableCell>
        {canEdit ? (
          <select
            aria-label={lbl(L, "newPage.locales")}
            className={selectClass}
            defaultValue={item.locale ?? ""}
            disabled={pending}
            onChange={(e) => save({ locale: (e.target.value || null) as Locale | null })}
          >
            <option value="">—</option>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        ) : (
          (item.locale ?? "—")
        )}
      </TableCell>
      <TableCell>
        {canEdit && item.wpType !== "attachment" ? (
          <Input aria-label={lbl(L, "import.col.translationGroup")} defaultValue={item.translationGroup ?? ""} disabled={pending} onBlur={(e) => e.target.value !== (item.translationGroup ?? "") && save({ translationGroup: e.target.value || null })} />
        ) : (
          (item.translationGroup ?? "—")
        )}
      </TableCell>
      <TableCell>
        {canEdit ? (
          <div className="grid gap-1">
            <select
              aria-label={lbl(L, "import.col.decision")}
              className={selectClass}
              value={decision}
              disabled={pending}
              onChange={(e) => {
                const d = e.target.value as ImportItemDecision;
                setDecision(d);
                if (d !== "redirect_only") save({ decision: d });
              }}
            >
              {DECISIONS.map((d) => (
                <option key={d} value={d}>
                  {lbl(L, `import.decision.${d}`)}
                </option>
              ))}
            </select>
            {decision === "redirect_only" ? (
              <select
                aria-label={lbl(L, "redirects.to")}
                className={selectClass}
                value={target}
                disabled={pending}
                onChange={(e) => {
                  setTarget(e.target.value);
                  save({ decision: "redirect_only", redirectToPageId: e.target.value });
                }}
              >
                <option value="">—</option>
                {pages
                  .filter((p) => p.status !== "archived")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </select>
            ) : null}
          </div>
        ) : (
          lbl(L, `import.decision.${item.decision}`)
        )}
      </TableCell>
      <TableCell>
        <Badge variant={item.status === "error" ? "destructive" : item.status === "imported" ? "default" : "outline"}>{lbl(L, `import.itemStatus.${item.status}`)}</Badge>
        {item.targetPageId ? (
          <NextLink href={`/admin/site/pages/${item.targetPageId}`} className="ml-2 text-xs underline-offset-4 hover:underline">
            {item.targetPageSlug ?? lbl(L, "common.edit")}
          </NextLink>
        ) : null}
        {item.message || error ? <div className="text-xs text-muted-foreground">{error ?? item.message}</div> : null}
      </TableCell>
    </TableRow>
  );
}

export function ImportMapping({ detail, items, L, pages, locale }: { detail: WordpressImportDetail; items: ImportItemRow[]; L: SiteAdminLabels; pages: EditorPickers["pages"]; locale: Locale }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ pageId: string; issues: PublishIssue[] }[]>([]);

  useEffect(() => {
    if (!detail.busy) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [detail.busy, router]);

  const run = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>) =>
    start(async () => {
      const res = await fn();
      setMsg(res.ok ? null : (res.error?.message ?? "error"));
      router.refresh();
    });

  const editable = detail.status === "parsed" || detail.status === "done" || detail.status === "failed";
  const convert = detail.report.convert;
  const fmt = new Intl.NumberFormat(locale);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={importStatusVariant(detail.status)}>{lbl(L, `import.status.${detail.status}`)}</Badge>
        <span className="text-sm text-muted-foreground">
          {detail.siteOrigin} · {lbl(L, "import.defaultLocale")}: {detail.defaultLocale}
        </span>
        <ImportCounts counts={detail.counts} L={L} />
      </div>

      {detail.report.parseError ? (
        <p role="alert" className="text-sm text-destructive">
          {lbl(L, "import.parseError", { line: detail.report.parseError.line })} {detail.report.parseError.message}
        </p>
      ) : null}
      {detail.status === "failed" && detail.report.lastError ? <p className="text-sm text-destructive">{detail.report.lastError}</p> : null}

      <div className="flex flex-wrap gap-2">
        {detail.status === "parsed" ? (
          <Button type="button" disabled={pending} onClick={() => run(() => applyWordpressImport({ importId: detail.importId }))}>
            {lbl(L, "import.apply")}
          </Button>
        ) : null}
        {(detail.status === "done" || detail.status === "failed") && (detail.counts.errors ?? 0) > 0 ? (
          <Button type="button" variant="outline" disabled={pending} onClick={() => run(() => retryImportErrors({ importId: detail.importId }))}>
            {lbl(L, "import.retry")} ({fmt.format(detail.counts.errors ?? 0)})
          </Button>
        ) : null}
        {detail.status === "done" && detail.draftPages > 0 ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await publishImportedPages({ importId: detail.importId });
                if (res.ok) {
                  setBlocked(res.data.blocked);
                  setMsg(`${lbl(L, "status.published")}: ${fmt.format(res.data.published)}`);
                } else setMsg(res.error.message);
                router.refresh();
              })
            }
          >
            {lbl(L, "import.publishAll")} ({fmt.format(detail.draftPages)})
          </Button>
        ) : null}
      </div>
      {msg ? (
        <p role="status" className="text-sm">
          {msg}
        </p>
      ) : null}
      {blocked.length ? (
        <ul className="grid gap-1 text-sm">
          {blocked.map((b) => (
            <li key={b.pageId}>
              <NextLink href={`/admin/site/pages/${b.pageId}`} className="underline-offset-4 hover:underline">
                {pages.find((p) => p.id === b.pageId)?.label ?? b.pageId}
              </NextLink>
              : {b.issues.map((i) => lblOr(L, `issue.${i.code}`, "issue.title") + (i.locale ? ` (${i.locale})` : "")).join(", ")}
            </li>
          ))}
        </ul>
      ) : null}

      {convert && (convert.shortcodes.length || convert.unsupportedTags.length || convert.droppedIframes.length || convert.unresolvedImages.length || convert.unresolvedLinks.length) ? (
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">{lbl(L, "import.report")}</summary>
          <ul className="mt-2 grid gap-1">
            {convert.shortcodes.length ? <li>[{convert.shortcodes.join("], [")}]</li> : null}
            {convert.unsupportedTags.length ? <li>&lt;{convert.unsupportedTags.join("&gt;, &lt;")}&gt;</li> : null}
            {convert.droppedIframes.length ? <li>iframe: {convert.droppedIframes.join(", ")}</li> : null}
            {convert.unresolvedImages.length ? <li>img: {convert.unresolvedImages.join(", ")}</li> : null}
            {convert.unresolvedLinks.length ? <li>a: {convert.unresolvedLinks.join(", ")}</li> : null}
            {convert.videosWithoutPoster ? <li>{lbl(L, "issue.media_missing")}: YouTube × {convert.videosWithoutPoster}</li> : null}
          </ul>
        </details>
      ) : null}

      {items.length === 0 ? (
        <EmptyState title={detail.busy ? lbl(L, "common.loading") : lbl(L, "import.empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{lbl(L, "pages.col.title")}</TableHead>
              <TableHead>{lbl(L, "import.col.oldPath")}</TableHead>
              <TableHead>{lbl(L, "import.col.wpStatus")}</TableHead>
              <TableHead>{lbl(L, "newPage.locales")}</TableHead>
              <TableHead>{lbl(L, "import.col.translationGroup")}</TableHead>
              <TableHead>{lbl(L, "import.col.decision")}</TableHead>
              <TableHead>{lbl(L, "pages.col.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <ItemRow key={item.itemId} item={item} L={L} pages={pages} editable={editable} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
