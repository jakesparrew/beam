"use client";
/**
 * Steps 1 and 2 of `/admin/imports/new` (ops spec 5, rule 42): kind, source and name, then the
 * CSV file sent in 3 MB parts to `/admin/imports/upload` with a progress bar; `createImport`
 * attaches the parts and the browser moves on to the mapping step on `/admin/imports/[id]`.
 * Every string comes from the page (no catalogue lookups in client components).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@beam/ui";
import { IMPORT_KINDS, IMPORT_MAX_BYTES, IMPORT_PART_BYTES, IMPORT_SOURCES, type ImportKind, type ImportSource } from "@beam/core/ops";
import { createImport } from "@/modules/ops/imports/actions";

export type ChunkedUploadLabels = {
  kind: string;
  source: string;
  name: string;
  file: string;
  upload: string;
  kinds: Record<ImportKind, string>;
  sources: Record<ImportSource, string>;
  errors: { tooLarge: string; malformed: string; generic: string };
};

export function ChunkedUpload({ labels, defaultKind = "suppressions" }: { labels: ChunkedUploadLabels; defaultKind?: ImportKind }) {
  const router = useRouter();
  const [kind, setKind] = useState<ImportKind>(defaultKind);
  const [source, setSource] = useState<ImportSource>("simplybook");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) return setError(labels.errors.tooLarge);
    const total = Math.max(1, Math.ceil(file.size / IMPORT_PART_BYTES));
    setProgress({ done: 0, total });
    try {
      const fileIds: string[] = [];
      for (let index = 0; index < total; index++) {
        const body = new FormData();
        body.set("part", file.slice(index * IMPORT_PART_BYTES, (index + 1) * IMPORT_PART_BYTES), file.name);
        body.set("index", String(index));
        body.set("total", String(total));
        body.set("name", file.name);
        const res = await fetch("/admin/imports/upload", { method: "POST", body });
        if (!res.ok) throw new Error(res.status === 400 ? labels.errors.tooLarge : labels.errors.generic);
        fileIds.push(((await res.json()) as { fileId: string }).fileId);
        setProgress({ done: index + 1, total });
      }
      const result = await createImport({ kind, source, name: name.trim() || file.name.slice(0, 120), fileIds });
      if (!result.ok) throw new Error(result.error.message === "malformed_csv" ? labels.errors.malformed : labels.errors.generic);
      router.push(`/admin/imports/${result.data.importId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : labels.errors.generic);
      setProgress(null);
    }
  }

  const select = "h-9 w-full rounded-md border bg-background px-3 text-sm";
  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-xl gap-4" aria-busy={busy}>
      <label className="grid gap-1 text-sm">
        <span className="font-medium">{labels.kind}</span>
        <select name="kind" className={select} value={kind} onChange={(e) => setKind(e.target.value as ImportKind)} disabled={busy}>
          {IMPORT_KINDS.map((k) => (
            <option key={k} value={k}>
              {labels.kinds[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-medium">{labels.source}</span>
        <select name="source" className={select} value={source} onChange={(e) => setSource(e.target.value as ImportSource)} disabled={busy}>
          {IMPORT_SOURCES.map((s) => (
            <option key={s} value={s}>
              {labels.sources[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-medium">{labels.name}</span>
        <input name="name" className={select} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-medium">{labels.file}</span>
        <input name="file" type="file" accept=".csv,text/csv" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
      </label>
      {progress ? (
        <div className="grid gap-1" role="status">
          <div className="h-2 w-full overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </div>
          <span className="text-xs text-muted-foreground" data-testid="upload-progress">
            {progress.done} / {progress.total}
          </span>
        </div>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy || !file}>
          {labels.upload}
        </Button>
      </div>
    </form>
  );
}
