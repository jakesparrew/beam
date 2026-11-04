"use client";
/**
 * Media library (site spec section 5 `/admin/site/media`): a grid of images with alt completeness,
 * size and usage; upload by drag and drop or file picker (alt text per locale, decorative switch),
 * edit alt, decorative, caption and credit, delete (refused while a page uses the image).
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Checkbox, EmptyState, Input, Label } from "@beam/ui";
import { LOCALES, type LocalizedText } from "@beam/core/i18n";
import { deleteMedia, updateMedia, uploadMedia } from "../../actions/media";
import type { AdminMediaRow, SiteAdminLabels } from "../../queries/admin";
import { lbl } from "./pickers";

const complete = (alt: LocalizedText) => LOCALES.every((l) => !!alt[l]?.trim());

function errorText(L: SiteAdminLabels, res: { ok: false; error: { code: string; message: string; fields?: Record<string, string> } }): string {
  if (res.error.code === "conflict") return lbl(L, "media.inUse");
  const f = res.error.fields?.file;
  if (f === "too_large" || f === "type_not_allowed") return lbl(L, "media.allowed");
  if (f === "not_an_image") return lbl(L, "media.notAnImage");
  return res.error.message;
}

function AltFields({ L, value, onChange, prefix }: { L: SiteAdminLabels; value: LocalizedText; onChange: (v: LocalizedText) => void; prefix: string }) {
  return (
    <div className="grid gap-1">
      {LOCALES.map((l) => (
        <div key={l} className="grid gap-1">
          <Label htmlFor={`${prefix}-${l}`}>
            {lbl(L, "media.alt")} ({l})
          </Label>
          <Input id={`${prefix}-${l}`} value={value[l] ?? ""} onChange={(e) => onChange({ ...value, [l]: e.target.value })} />
        </div>
      ))}
    </div>
  );
}

function MediaCard({ row, L, usageLabel }: { row: AdminMediaRow; L: SiteAdminLabels; usageLabel: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [alt, setAlt] = useState<LocalizedText>(row.alt);
  const [decorative, setDecorative] = useState(row.isDecorative);
  const [credit, setCredit] = useState(row.credit ?? "");
  const [caption, setCaption] = useState<LocalizedText>(row.caption ?? {});
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <li className="grid gap-2 rounded-md border p-3">
      {/* Admin thumbnail; the public site uses next/image with the stored size. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/public/files/${row.fileId}`} alt={alt.en ?? ""} width={row.width} height={row.height} className="h-32 w-full rounded object-contain" />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span>{row.name}</span>
        <span>{lbl(L, "media.size", { width: row.width, height: row.height })}</span>
        <Badge variant={decorative || complete(alt) ? "success" : "destructive"}>{decorative || complete(alt) ? lbl(L, "media.altComplete") : lbl(L, "media.altIncomplete")}</Badge>
        <span>{usageLabel}</span>
      </div>
      <details>
        <summary className="cursor-pointer text-sm">{lbl(L, "common.edit")}</summary>
        <div className="mt-2 grid gap-2">
          <AltFields L={L} value={alt} onChange={setAlt} prefix={`alt-${row.mediaId}`} />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={decorative} onCheckedChange={(v) => setDecorative(v === true)} />
            {lbl(L, "media.decorative")}
          </label>
          {LOCALES.map((l) => (
            <Input key={l} aria-label={`${lbl(L, "media.caption")} ${l}`} placeholder={`${lbl(L, "media.caption")} (${l})`} value={caption[l] ?? ""} onChange={(e) => setCaption({ ...caption, [l]: e.target.value })} />
          ))}
          <Input aria-label={lbl(L, "media.credit")} placeholder={lbl(L, "media.credit")} maxLength={200} value={credit} onChange={(e) => setCredit(e.target.value)} />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const hasCaption = LOCALES.some((l) => caption[l]?.trim());
                  const res = await updateMedia({ mediaId: row.mediaId, alt, isDecorative: decorative, caption: hasCaption ? caption : null, credit: credit || null });
                  setMsg(res.ok ? lbl(L, "editor.saved") : errorText(L, res));
                  if (res.ok) router.refresh();
                })
              }
            >
              {lbl(L, "editor.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await deleteMedia({ mediaId: row.mediaId });
                  if (res.ok) router.refresh();
                  else setMsg(errorText(L, res));
                })
              }
            >
              {lbl(L, "editor.delete")}
            </Button>
          </div>
        </div>
      </details>
      {msg ? (
        <p role="status" className="text-sm">
          {msg}
        </p>
      ) : null}
    </li>
  );
}

export function MediaLibrary({ rows, L, usageLabels }: { rows: AdminMediaRow[]; L: SiteAdminLabels; usageLabels: Record<string, string> }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [alt, setAlt] = useState<LocalizedText>({});
  const [decorative, setDecorative] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const upload = (list: FileList | null) => {
    if (!list?.length) return;
    start(async () => {
      for (const file of Array.from(list)) {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("alt", JSON.stringify(alt));
        fd.set("isDecorative", decorative ? "true" : "false");
        const res = await uploadMedia(fd);
        if (!res.ok) {
          setMsg(`${file.name}: ${errorText(L, res)}`);
          return;
        }
      }
      setMsg(null);
      setAlt({});
      router.refresh();
    });
  };
  return (
    <div className="grid gap-6">
      <section className="grid gap-3 rounded-md border p-4" aria-labelledby="media-upload">
        <h2 id="media-upload" className="text-lg font-semibold">
          {lbl(L, "media.upload")}
        </h2>
        <AltFields L={L} value={alt} onChange={setAlt} prefix="upload-alt" />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={decorative} onCheckedChange={(v) => setDecorative(v === true)} />
          {lbl(L, "media.decorative")}
        </label>
        <div
          className={`grid place-items-center rounded-md border-2 border-dashed p-6 text-sm ${over ? "bg-accent" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            upload(e.dataTransfer.files);
          }}
        >
          <p>{lbl(L, "media.drop")}</p>
          <p className="text-xs text-muted-foreground">{lbl(L, "media.allowed")}</p>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="sr-only" id="media-file" data-testid="media-file" onChange={(e) => upload(e.target.files)} />
          <Button type="button" variant="outline" className="mt-2" disabled={pending} onClick={() => input.current?.click()}>
            {lbl(L, "media.upload")}
          </Button>
        </div>
        {msg ? (
          <p role="status" className="text-sm text-destructive">
            {msg}
          </p>
        ) : null}
      </section>
      {rows.length === 0 ? (
        <EmptyState title={lbl(L, "media.empty")} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <MediaCard key={r.mediaId} row={r} L={L} usageLabel={usageLabels[r.mediaId] ?? ""} />
          ))}
        </ul>
      )}
    </div>
  );
}
