"use client";
/**
 * The inspector of the selected block (email spec rules 16 to 22): every field of the block type,
 * the token picker on text fields, image upload through platform's `uploadImage` (files above
 * 2 MB are refused before upload; `image/png|jpeg|gif|webp` only), and the block's accessibility
 * and card warnings (rule 15b) next to the fields they concern.
 */
import { useState, type ReactNode } from "react";
import { Alert, AlertDescription, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from "@beam/ui";
import type { Block, BlockType, ColumnsBlock, DynamicBlock } from "@beam/core/email";
import { lab, newBlock, type EditorLabels } from "./BlockCanvas";
import { BlockPalette, LEAF_TYPES } from "./BlockPalette";
import { DynamicBlockEditor } from "./DynamicBlockEditor";
import { TokenPicker } from "./TokenPicker";

/** Larger files are refused before upload (rule 22). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type UploadImage = (form: FormData) => Promise<{ ok: true; data: { fileId: string; url: string } } | { ok: false; error: { code: string; message: string } }>;

export type BlockInspectorProps = {
  block: Block | null;
  onChange: (block: Block) => void;
  labels: EditorLabels;
  mergeFields: readonly string[];
  /** Warning messages of this block (already translated). */
  warnings: readonly string[];
  uploadImage: UploadImage;
  disabled?: boolean;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function TokenText({ value, onChange, multiline, labels, mergeFields, disabled, label }: { value: string; onChange: (v: string) => void; multiline?: boolean; labels: EditorLabels; mergeFields: readonly string[]; disabled?: boolean; label: string }) {
  const Control = multiline ? Textarea : Input;
  return (
    <Field label={label}>
      <Control value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...(multiline ? { rows: 6 } : {})} aria-label={label} />
      <div>
        <TokenPicker mergeFields={mergeFields} labels={labels} disabled={disabled} onInsert={(t) => onChange(`${value}${value && !value.endsWith(" ") ? " " : ""}${t}`)} />
      </div>
    </Field>
  );
}

function ImageUpload({ onUploaded, uploadImage, labels, disabled }: { onUploaded: (fileId: string) => void; uploadImage: UploadImage; labels: EditorLabels; disabled?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Field label={lab(labels, "image_upload")}>
      <Input
        type="file"
        accept={IMAGE_TYPES.join(",")}
        disabled={disabled || busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setError(null);
          if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return setError(lab(labels, "image_type_refused"));
          if (file.size > MAX_UPLOAD_BYTES) return setError(lab(labels, "image_too_large"));
          setBusy(true);
          const form = new FormData();
          form.set("file", file);
          void uploadImage(form)
            .then((result) => (result.ok ? onUploaded(result.data.fileId) : setError(lab(labels, "image_upload_failed"))))
            .catch(() => setError(lab(labels, "image_upload_failed")))
            .finally(() => setBusy(false));
        }}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </Field>
  );
}

function ColumnsEditor({ block, onChange, labels, disabled }: { block: ColumnsBlock; onChange: (b: ColumnsBlock) => void; labels: EditorLabels; disabled?: boolean }) {
  const sum = block.columns.reduce((s, c) => s + c.width, 0);
  const setCount = (n: 2 | 3) => {
    const width = n === 2 ? [50, 50] : [34, 33, 33];
    onChange({ ...block, columns: width.map((w, i) => ({ width: w, blocks: block.columns[i]?.blocks ?? [] })) });
  };
  return (
    <div className="grid gap-3">
      <Field label={lab(labels, "columns_count")}>
        <Select value={String(block.columns.length)} disabled={disabled} onValueChange={(v) => setCount(v === "3" ? 3 : 2)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2">2</SelectItem>
            <SelectItem value="3">3</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {block.columns.map((c, i) => (
        <div key={i} className="grid gap-2 rounded-md border p-2">
          <Field label={lab(labels, "column_width", { n: i + 1 })}>
            <Input
              type="number"
              min={1}
              max={100}
              value={c.width}
              disabled={disabled}
              onChange={(e) => onChange({ ...block, columns: block.columns.map((x, j) => (j === i ? { ...x, width: Math.max(1, Math.min(100, Number(e.target.value) || 1)) } : x)) })}
            />
          </Field>
          <BlockPalette
            compact
            types={LEAF_TYPES}
            labels={labels}
            disabled={disabled}
            onAdd={(type: BlockType) => onChange({ ...block, columns: block.columns.map((x, j) => (j === i ? { ...x, blocks: [...x.blocks, newBlock(type) as (typeof x.blocks)[number]] } : x)) })}
          />
        </div>
      ))}
      {sum !== 100 ? <p className="text-xs text-destructive">{lab(labels, "column_widths_sum", { sum })}</p> : null}
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={block.stackOnMobile} disabled={disabled} onCheckedChange={(v) => onChange({ ...block, stackOnMobile: v })} />
        {lab(labels, "stack_on_mobile")}
      </label>
    </div>
  );
}

export function BlockInspector({ block, onChange, labels, mergeFields, warnings, uploadImage, disabled }: BlockInspectorProps) {
  if (!block) return <p className="text-sm text-muted-foreground">{lab(labels, "inspector_empty")}</p>;
  const text = (label: string, value: string, set: (v: string) => void, multiline = false) => (
    <TokenText label={label} value={value} onChange={set} multiline={multiline} labels={labels} mergeFields={mergeFields} disabled={disabled} />
  );
  let body: ReactNode = null;
  switch (block.type) {
    case "heading":
      body = (
        <>
          <Field label={lab(labels, "heading_level")}>
            <Select value={String(block.level)} disabled={disabled} onValueChange={(v) => onChange({ ...block, level: Number(v) as 1 | 2 | 3 })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3].map((l) => (
                  <SelectItem key={l} value={String(l)}>{`H${l}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {text(lab(labels, "field_text"), block.text, (v) => onChange({ ...block, text: v }))}
        </>
      );
      break;
    case "text":
      body = (
        <>
          {text(lab(labels, "field_markdown"), block.markdown, (v) => onChange({ ...block, markdown: v }), true)}
          <p className="text-xs text-muted-foreground">{lab(labels, "markdown_help")}</p>
        </>
      );
      break;
    case "image":
      body = (
        <>
          <ImageUpload uploadImage={uploadImage} labels={labels} disabled={disabled} onUploaded={(fileId) => onChange({ ...block, fileId })} />
          <Field label={lab(labels, "field_file_id")}>
            <Input value={block.fileId} disabled={disabled} onChange={(e) => onChange({ ...block, fileId: e.target.value.trim() })} />
          </Field>
          {text(lab(labels, "field_alt"), block.alt, (v) => onChange({ ...block, alt: v }))}
          <p className="text-xs text-muted-foreground">{lab(labels, "alt_help")}</p>
          <Field label={lab(labels, "field_href")}>
            <Input value={block.href ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value.trim() ? { ...block, href: e.target.value.trim() } : (({ href: _h, ...rest }) => rest)(block))} />
          </Field>
          <Field label={lab(labels, "field_width")}>
            <Input type="number" min={100} max={600} value={block.width ?? 600} disabled={disabled} onChange={(e) => onChange({ ...block, width: Math.max(100, Math.min(600, Number(e.target.value) || 600)) })} />
          </Field>
        </>
      );
      break;
    case "button":
      body = (
        <>
          {text(lab(labels, "field_label"), block.label, (v) => onChange({ ...block, label: v }))}
          <Field label={lab(labels, "field_href")}>
            <Input value={block.href} disabled={disabled} onChange={(e) => onChange({ ...block, href: e.target.value.trim() })} />
          </Field>
          <Field label={lab(labels, "field_style")}>
            <Select value={block.style} disabled={disabled} onValueChange={(v) => onChange({ ...block, style: v as "primary" | "secondary" })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="primary">{lab(labels, "style_primary")}</SelectItem>
                <SelectItem value="secondary">{lab(labels, "style_secondary")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </>
      );
      break;
    case "spacer":
      body = (
        <Field label={lab(labels, "field_height")}>
          <Input type="number" min={8} max={64} value={block.height} disabled={disabled} onChange={(e) => onChange({ ...block, height: Math.max(8, Math.min(64, Number(e.target.value) || 8)) })} />
        </Field>
      );
      break;
    case "product":
      body = (
        <>
          <Field label={lab(labels, "field_product_id")}>
            <Input value={block.productId} disabled={disabled} onChange={(e) => onChange({ ...block, productId: e.target.value.trim() })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={block.showPrice} disabled={disabled} onCheckedChange={(v) => onChange({ ...block, showPrice: v })} />
            {lab(labels, "show_price")}
          </label>
          {text(lab(labels, "field_cta"), block.ctaLabel, (v) => onChange({ ...block, ctaLabel: v }))}
        </>
      );
      break;
    case "event":
      body = (
        <>
          <Field label={lab(labels, "field_session_id")}>
            <Input value={block.sessionId} disabled={disabled} onChange={(e) => onChange({ ...block, sessionId: e.target.value.trim() })} />
          </Field>
          {text(lab(labels, "field_cta"), block.ctaLabel, (v) => onChange({ ...block, ctaLabel: v }))}
        </>
      );
      break;
    case "columns":
      body = <ColumnsEditor block={block} onChange={onChange} labels={labels} disabled={disabled} />;
      break;
    case "dynamic":
      body = <DynamicBlockEditor block={block} onChange={(b: DynamicBlock) => onChange(b)} labels={labels} disabled={disabled} />;
      break;
    case "divider":
      body = <p className="text-sm text-muted-foreground">{lab(labels, "divider_help")}</p>;
      break;
  }
  return (
    <div className="grid gap-3" aria-label={lab(labels, "inspector")} data-testid="block-inspector">
      <h2 className="text-sm font-semibold">{lab(labels, `type_${block.type}`)}</h2>
      {warnings.length ? (
        <Alert>
          <AlertDescription>
            <ul className="list-disc pl-4 text-xs">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {body}
    </div>
  );
}
