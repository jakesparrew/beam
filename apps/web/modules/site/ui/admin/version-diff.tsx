"use client";
/**
 * The side-by-side review of a version (site spec section 5 `/admin/site/pages/[pageId]/versions/
 * [versionId]`, rules 45-46, edge case 11): a locale switch; title, path, SEO and excerpt with
 * word-level changes; per-block changes with inserted blocks highlighted and removed blocks shown
 * struck through; review warnings; the rendered previews; and the review actions Publish, Schedule
 * (`site.publish`), Reject with a reason and Edit as draft (proposals only).
 */
import { useMemo, useState, useTransition } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Input, Label, Textarea } from "@beam/ui";
import type { Locale } from "@beam/core/i18n";
import { prefixFromLocale, type BlockDiff, type FieldDiff } from "@beam/core/site";
import { publishVersion } from "../../actions/pages";
import { copyProposalToDraft, rejectProposal } from "../../actions/proposals";
import type { SiteAdminLabels } from "../../queries/admin";
import type { VersionDiffData } from "../../queries/proposals";
import { DiffText } from "./diff-text";
import { lbl } from "./pickers";
import { PreviewFrames } from "./preview-frames";

const STATUS_VARIANT = { inserted: "success", deleted: "destructive", changed: "warning", unchanged: "outline" } as const;
const STATUS_LABEL = { inserted: "diff.inserted", deleted: "diff.deleted", changed: "diff.changed", unchanged: "diff.unchanged" } as const;

function FieldRow({ label, diff }: { label: string; diff: FieldDiff }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr]" data-changed={diff.changed ? "true" : "false"}>
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">
        <DiffText segments={diff.segments} />
      </dd>
    </div>
  );
}

function BlockCard({ L, block }: { L: SiteAdminLabels; block: BlockDiff }) {
  const highlight =
    block.status === "inserted" ? "border-green-600 bg-green-50 dark:bg-green-950/30" : block.status === "deleted" ? "border-red-600 bg-red-50 dark:bg-red-950/30" : block.status === "changed" ? "border-amber-500" : "";
  return (
    <li className={`grid gap-2 rounded-md border p-3 ${highlight}`} data-testid={`block-${block.status}`} data-block-id={block.blockId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{lbl(L, `block.${block.type}.name`)}</span>
        <Badge variant={STATUS_VARIANT[block.status]}>{lbl(L, STATUS_LABEL[block.status])}</Badge>
        {block.moved ? <Badge variant="outline">{lbl(L, "diff.moved")}</Badge> : null}
      </div>
      {block.fields.length ? (
        <dl className="grid gap-1">
          {block.fields.map((f) => (
            <FieldRow key={f.field} label={L[`block.${block.type}.${f.field}`] ?? f.field} diff={f} />
          ))}
        </dl>
      ) : null}
    </li>
  );
}

export type VersionReviewProps = { data: VersionDiffData; L: SiteAdminLabels; canPublish: boolean; staffLocale: Locale };

export function VersionReview({ data, L, canPublish, staffLocale }: VersionReviewProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const locales = data.diff.locales.length ? data.diff.locales : data.version.locales;
  const [locale, setLocale] = useState<Locale>(locales.includes(staffLocale) ? staffLocale : (locales[0] ?? "nl-BE"));
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const ld = data.diff.byLocale[locale];
  const warnings = useMemo(() => data.warnings.filter((w) => !w.locale || w.locale === locale), [data.warnings, locale]);
  const state = data.version.state;
  const reviewable = state === "proposed" || state === "draft";
  const isProposal = state === "proposed";
  const editorHref = `/admin/site/pages/${data.page.pageId}` as Route;

  const run = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>, after?: () => void) =>
    start(async () => {
      setMessage(null);
      const res = await fn();
      if (!res.ok) return setMessage({ kind: "error", text: res.error?.message ?? "error" });
      if (after) after();
      else router.refresh();
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="grid content-start gap-4">
        {data.draftChangedAfter ? (
          <Alert>
            <AlertDescription>{lbl(L, "diff.draftChanged")}</AlertDescription>
          </Alert>
        ) : null}
        {data.diff.identical ? (
          <Alert>
            <AlertDescription>{lbl(L, "diff.identical")}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={lbl(L, "claude.locales")}>
          {locales.map((l) => (
            <Button key={l} type="button" size="sm" variant={l === locale ? "default" : "outline"} aria-pressed={l === locale} onClick={() => setLocale(l)}>
              {l}
              {data.diff.byLocale[l]?.changed ? " •" : ""}
            </Button>
          ))}
          {data.diff.addedLocales.map((l) => (
            <Badge key={`a-${l}`} variant="success">
              {lbl(L, "diff.addedLocale", { language: l })}
            </Badge>
          ))}
          {data.diff.removedLocales.map((l) => (
            <Badge key={`r-${l}`} variant="destructive">
              {lbl(L, "diff.removedLocale", { language: l })}
            </Badge>
          ))}
        </div>

        {ld ? (
          <>
            <dl className="grid gap-2 rounded-md border p-3">
              <FieldRow label={lbl(L, "pages.col.title")} diff={ld.title} />
              <FieldRow label={lbl(L, "editor.path")} diff={ld.path} />
              <FieldRow label={lbl(L, "editor.seoTitle")} diff={ld.seoTitle} />
              <FieldRow label={lbl(L, "editor.seoDescription")} diff={ld.seoDescription} />
              <FieldRow label={lbl(L, "editor.excerpt")} diff={ld.excerpt} />
            </dl>
            <ol className="grid gap-3" aria-label={lbl(L, "diff.title", { n: data.version.version })}>
              {ld.blocks.map((b) => (
                <BlockCard key={`${b.blockId}:${b.status}`} L={L} block={b} />
              ))}
            </ol>
          </>
        ) : null}

        <PreviewFrames L={L} base={data.base ? { versionId: data.base.versionId, version: data.base.version } : null} versionId={data.version.versionId} version={data.version.version} prefix={prefixFromLocale(locale)} />
      </div>

      <aside className="grid content-start gap-4">
        {data.request ? (
          <section className="grid gap-1 rounded-md border p-3 text-sm">
            <h2 className="font-semibold">{lbl(L, "diff.instruction")}</h2>
            <p className="whitespace-pre-wrap">{data.request.instruction}</p>
            {data.version.changeSummary ? <p className="text-muted-foreground">{data.version.changeSummary}</p> : null}
            <p className="text-muted-foreground">{lbl(L, "diff.requestedBy", { name: data.request.requestedByName ?? "—" })}</p>
          </section>
        ) : data.version.changeSummary ? (
          <p className="text-sm text-muted-foreground">{data.version.changeSummary}</p>
        ) : null}

        <section className="grid gap-1" aria-live="polite">
          <h2 className="text-sm font-semibold">{lbl(L, "diff.warnings")}</h2>
          <ul className="grid gap-1 text-sm" data-testid="review-warnings">
            {warnings.map((w, i) => (
              <li key={i} className="text-amber-700 dark:text-amber-300">
                {L[`warning.${w.code}`] ?? w.message}
              </li>
            ))}
          </ul>
        </section>

        {message ? (
          <p role="status" className={message.kind === "error" ? "text-sm text-destructive" : "text-sm"}>
            {message.text}
          </p>
        ) : null}

        {reviewable && canPublish ? (
          <section className="grid gap-2 rounded-md border p-3">
            <Button type="button" disabled={pending} onClick={() => run(() => publishVersion({ versionId: data.version.versionId }))}>
              {lbl(L, "diff.publish")}
            </Button>
            <Label htmlFor="review-schedule-at">{lbl(L, "editor.scheduleAt")}</Label>
            <Input id="review-schedule-at" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
            <Button type="button" variant="outline" disabled={pending || !scheduleAt} onClick={() => run(() => publishVersion({ versionId: data.version.versionId, scheduleAt: new Date(scheduleAt).toISOString() }))}>
              {lbl(L, "editor.schedule")}
            </Button>
          </section>
        ) : null}

        {isProposal ? (
          <section className="grid gap-2 rounded-md border p-3">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (data.draftVersionId && !window.confirm(lbl(L, "editor.discardDraft"))) return;
                run(() => copyProposalToDraft({ versionId: data.version.versionId, replaceExisting: !!data.draftVersionId }), () => router.push(editorHref));
              }}
            >
              {lbl(L, "diff.editAsDraft")}
            </Button>
            {rejecting ? (
              <div className="grid gap-2">
                <Label htmlFor="review-reject-reason">{lbl(L, "diff.rejectReason")}</Label>
                <Textarea id="review-reject-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="destructive" disabled={pending || !reason.trim()} onClick={() => run(() => rejectProposal({ versionId: data.version.versionId, reason }))}>
                    {lbl(L, "diff.reject")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                    {lbl(L, "common.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="ghost" className="text-destructive" onClick={() => setRejecting(true)}>
                {lbl(L, "diff.reject")}
              </Button>
            )}
          </section>
        ) : null}
        {data.version.rejectReason ? <p className="text-sm text-muted-foreground">{data.version.rejectReason}</p> : null}
      </aside>
    </div>
  );
}
