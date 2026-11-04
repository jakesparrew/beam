"use client";

/**
 * Tracked links (forms spec section 5 `/admin/forms/[formId]/links`; forms-P5): name, channel, URL,
 * starts and completions per link, QR download as SVG and PNG (1024 px, error correction M), and
 * create, rename, deactivate and copy. Writes go through `createLink` and `updateLink`.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FORM_LINK_CHANNELS, type FormLinkChannel } from "@beam/core/forms";
import { Badge, Button, EmptyState, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, toast } from "@beam/ui";
import { createLink, updateLink } from "../../actions";
import type { LinkRow } from "../../queries";
import { selectClass } from "./condition-builder";
import { lbl, type Labels } from "./issues-panel";

export type LinkTableProps = { formId: string; rows: LinkRow[]; labels: Labels };

function CreateLink({ formId, labels, onDone }: { formId: string; labels: Labels; onDone: () => void }) {
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<FormLinkChannel>("link");
  const [utm, setUtm] = useState({ source: "", medium: "", campaign: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-3 rounded-md border p-3"
      aria-label={lbl(labels, "links.create")}
      onSubmit={(e) => {
 void (async () => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const cleanUtm = Object.fromEntries(Object.entries(utm).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
        const r = await createLink({ formId, name, channel, ...(Object.keys(cleanUtm).length ? { utm: cleanUtm } : {}) });
        setBusy(false);
        if (r.ok) {
          setName("");
          toast.success(lbl(labels, "links.created"));
          onDone();
        } else setError(r.error.fields?.name ? lbl(labels, "links.name_required") : lbl(labels, `builder.error.${r.error.code}`));
      })();
}}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          {lbl(labels, "links.name")}
          <Input required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-invalid={error ? true : undefined} />
        </label>
        <label className="grid gap-1 text-sm">
          {lbl(labels, "links.channel")}
          <select className={selectClass} value={channel} onChange={(e) => setChannel(e.target.value as FormLinkChannel)}>
            {FORM_LINK_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {lbl(labels, `links.channel_${c}`)}
              </option>
            ))}
          </select>
        </label>
        {(["source", "medium", "campaign"] as const).map((k) => (
          <label key={k} className="grid gap-1 text-sm">
            {lbl(labels, `links.utm_${k}`)}
            <Input className="w-36" value={utm[k]} maxLength={100} onChange={(e) => setUtm({ ...utm, [k]: e.target.value })} />
          </label>
        ))}
        <Button type="submit" disabled={busy || !name.trim()}>
          {lbl(labels, "links.create")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function NameCell({ row, labels, onSaved }: { row: LinkRow; labels: Labels; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.name);
  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span>{row.name}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
          {lbl(labels, "links.edit")}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
 void (async () => {
        e.preventDefault();
        const r = await updateLink({ linkId: row.id, name });
        if (r.ok) {
          setEditing(false);
          onSaved();
        } else toast.error(lbl(labels, `builder.error.${r.error.code}`));
      })();
}}
    >
      <Input aria-label={lbl(labels, "links.name")} className="h-8 w-48" value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" size="sm">
        {lbl(labels, "links.save")}
      </Button>
    </form>
  );
}

export function LinkTable({ formId, rows, labels }: LinkTableProps) {
  const router = useRouter();
  const refresh = () => router.refresh();
  const qr = (id: string, format: "svg" | "png") => `/admin/forms/${formId}/links/${id}/qr?format=${format}`;
  return (
    <div className="grid gap-4">
      <CreateLink formId={formId} labels={labels} onDone={refresh} />
      {!rows.length ? (
        <EmptyState title={lbl(labels, "links.empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{lbl(labels, "links.name")}</TableHead>
              <TableHead>{lbl(labels, "links.channel")}</TableHead>
              <TableHead>{lbl(labels, "links.url")}</TableHead>
              <TableHead className="text-right">{lbl(labels, "links.starts")}</TableHead>
              <TableHead className="text-right">{lbl(labels, "links.completions")}</TableHead>
              <TableHead>{lbl(labels, "links.qr")}</TableHead>
              <TableHead>{lbl(labels, "links.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} data-link={r.key}>
                <TableCell>
                  <NameCell row={r} labels={labels} onSaved={refresh} />
                </TableCell>
                <TableCell>{lbl(labels, `links.channel_${r.channel}`)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <code className="max-w-72 truncate text-xs">{r.url}</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
 void (async () => {
                        try {
                          await navigator.clipboard.writeText(r.url);
                          toast.success(lbl(labels, "links.copied"));
                        } catch {
                          toast.error(lbl(labels, "links.copy_failed"));
                        }
                      })();
}}
                    >
                      {lbl(labels, "links.copy")}
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="text-right">{r.starts}</TableCell>
                <TableCell className="text-right">{r.completions}</TableCell>
                <TableCell>
                  <div className="flex gap-2 text-sm">
                    <a className="underline" href={qr(r.id, "svg")} download>
                      SVG
                    </a>
                    <a className="underline" href={qr(r.id, "png")} download>
                      PNG
                    </a>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge variant={r.isActive ? "success" : "secondary"}>{lbl(labels, r.isActive ? "links.active" : "links.inactive")}</Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
 void (async () => {
                        const res = await updateLink({ linkId: r.id, isActive: !r.isActive });
                        if (res.ok) refresh();
                        else toast.error(lbl(labels, `builder.error.${res.error.code}`));
                      })();
}}
                    >
                      {lbl(labels, r.isActive ? "links.deactivate" : "links.activate")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
