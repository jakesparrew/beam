"use client";
/**
 * The preview frame (email spec section 5, `/admin/templates/[id]/preview` and the editor's live
 * preview): subject and preheader, desktop (600 px) and mobile (375 px) widths, HTML and
 * plain-text tabs, the Gmail clipping warning above 102 KB (rule 21) and the preview warnings.
 * The HTML renders in a sandboxed iframe without scripts.
 */
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@beam/ui";
import { lab, type EditorLabels } from "./BlockCanvas";

/** Gmail clips messages above 102 KB (rule 21). */
export const CLIP_BYTES = 102 * 1024;

export type PreviewData = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  sizeBytes: number;
  warnings: readonly { code: string; locale: string; blockId?: string; detail?: string }[];
};

export type PreviewFrameProps = {
  preview: PreviewData | null;
  labels: EditorLabels;
  loading?: boolean;
  emptyText?: string;
};

export function PreviewFrame({ preview, labels, loading, emptyText }: PreviewFrameProps) {
  const [width, setWidth] = useState<600 | 375>(600);
  if (loading) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-[480px] w-full" />
      </div>
    );
  }
  if (!preview) return <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{emptyText ?? lab(labels, "preview_empty")}</p>;
  const kb = Math.round(preview.sizeBytes / 102.4) / 10;
  const codes = [...new Set(preview.warnings.map((w) => w.code))];
  return (
    <div className="grid gap-3" data-testid="preview-frame">
      <dl className="grid gap-1 text-sm">
        <div className="flex gap-2">
          <dt className="font-medium">{lab(labels, "subject")}</dt>
          <dd data-testid="preview-subject">{preview.subject}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium">{lab(labels, "preheader")}</dt>
          <dd>{preview.preheader}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="font-medium">{lab(labels, "size")}</dt>
          <dd>{lab(labels, "size_kb", { kb })}</dd>
          {preview.sizeBytes > CLIP_BYTES ? <Badge variant="destructive">{lab(labels, "size_warning")}</Badge> : null}
        </div>
      </dl>
      {codes.length ? (
        <Alert>
          <AlertDescription>
            <ul className="list-disc pl-4 text-xs">
              {codes.map((c) => (
                <li key={c}>{lab(labels, `warning_${c}`)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <Tabs defaultValue="html">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="html">{lab(labels, "tab_html")}</TabsTrigger>
            <TabsTrigger value="text">{lab(labels, "tab_text")}</TabsTrigger>
          </TabsList>
          <div className="flex gap-1" role="group" aria-label={lab(labels, "width")}>
            <Button type="button" size="sm" variant={width === 600 ? "default" : "outline"} aria-pressed={width === 600} onClick={() => setWidth(600)}>
              {lab(labels, "desktop")}
            </Button>
            <Button type="button" size="sm" variant={width === 375 ? "default" : "outline"} aria-pressed={width === 375} onClick={() => setWidth(375)}>
              {lab(labels, "mobile")}
            </Button>
          </div>
        </div>
        <TabsContent value="html">
          <div className="overflow-x-auto rounded-md border bg-muted/30 p-2">
            <iframe
              title={lab(labels, "preview_title")}
              sandbox=""
              srcDoc={preview.html}
              className="mx-auto block h-[720px] bg-white"
              style={{ width, maxWidth: "100%" }}
              data-testid="preview-iframe"
            />
          </div>
        </TabsContent>
        <TabsContent value="text">
          <pre className="max-h-[720px] overflow-auto whitespace-pre-wrap rounded-md border p-3 text-xs" data-testid="preview-text">
            {preview.text}
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  );
}
