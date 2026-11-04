"use client";
/**
 * The versions screen (automation spec 5): the versions table (version, published at, by, note)
 * with a checkbox per row to pick two versions for a JSON diff (`diffDefinitions`, rendered by
 * `VersionDiff`), and "Restore into draft", which copies a version's definition into the draft
 * through `saveDraft`. Dates arrive formatted (Europe/Brussels) from the server.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { saveDraft } from "../actions";
import { errorText, fill, type Labels } from "./outcome-badge";

export type VersionView = { id: string; version: number; publishedAt: string; authorName: string | null; changeNote: string | null; isCurrent: boolean; definition: unknown };
export type DiffRow = { path: string; kind: "added" | "removed" | "changed" | "moved"; before?: string; after?: string };

export function VersionsTable({ automationId, versions, selected, canEdit, labels: l }: { automationId: string; versions: VersionView[]; selected: string[]; canEdit: boolean; labels: Labels }) {
  const router = useRouter();
  const [pick, setPick] = useState<string[]>(selected);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (versions.length === 0) return <EmptyState title={l["versions.empty"]} />;

  async function restore(v: VersionView) {
    setBusy(v.id);
    setMessage(null);
    try {
      const r = await saveDraft({ automationId, definition: v.definition });
      if (r.ok) {
        setMessage({ kind: "ok", text: fill(l["versions.restored"], { version: v.version }) });
        router.refresh();
      } else setMessage({ kind: "error", text: errorText(r.error, l) });
    } catch {
      setMessage({ kind: "error", text: l["errors.generic"] ?? "" });
    } finally {
      setBusy(null);
    }
  }

  const compare = () => {
    const [a, b] = [...pick].sort((x, y) => (versions.find((v) => v.id === x)?.version ?? 0) - (versions.find((v) => v.id === y)?.version ?? 0));
    if (a && b) router.push(`/admin/automations/${automationId}/versions?from=${a}&to=${b}`);
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={pick.length !== 2} onClick={compare} data-testid="versions-compare">
          {l["versions.compare"]}
        </Button>
        <span className="text-sm text-muted-foreground">{l["versions.compare_hint"]}</span>
      </div>
      {message ? (
        <Alert variant={message.kind === "error" ? "destructive" : "default"} role={message.kind === "error" ? "alert" : "status"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <Table data-testid="versions-table">
        <TableHeader>
          <TableRow>
            <TableHead>{l["versions.col_select"]}</TableHead>
            <TableHead>{l["versions.col_version"]}</TableHead>
            <TableHead>{l["versions.col_published"]}</TableHead>
            <TableHead>{l["versions.col_by"]}</TableHead>
            <TableHead>{l["versions.col_note"]}</TableHead>
            {canEdit ? <TableHead /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((v) => (
            <TableRow key={v.id} data-version={v.version}>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={fill(l["versions.select_version"], { version: v.version })}
                  checked={pick.includes(v.id)}
                  onChange={(e) => setPick((p) => (e.target.checked ? [...p.filter((x) => x !== v.id), v.id].slice(-2) : p.filter((x) => x !== v.id)))}
                />
              </TableCell>
              <TableCell className="tabular-nums">
                {`v${v.version}`}
                {v.isCurrent ? (
                  <Badge variant="success" className="ml-2">
                    {l["versions.current"]}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>{v.publishedAt}</TableCell>
              <TableCell>{v.authorName ?? l["versions.seed"]}</TableCell>
              <TableCell>{v.changeNote ?? ""}</TableCell>
              {canEdit ? (
                <TableCell>
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void restore(v)}>
                    {l["versions.restore"]}
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The changes between two versions: path, kind, before and after (JSON text). */
export function VersionDiff({ title, rows, labels: l }: { title: string; rows: DiffRow[]; labels: Labels }) {
  return (
    <section aria-labelledby="version-diff-title" className="grid gap-2" data-testid="version-diff">
      <h2 id="version-diff-title" className="text-lg font-semibold">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm">{l["versions.diff_empty"]}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{l["versions.diff_path"]}</TableHead>
              <TableHead>{l["versions.diff_change"]}</TableHead>
              <TableHead>{l["versions.diff_before"]}</TableHead>
              <TableHead>{l["versions.diff_after"]}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i} data-kind={r.kind}>
                <TableCell className="font-mono text-xs">{r.path || "—"}</TableCell>
                <TableCell>{l[`versions.kind_${r.kind}`] ?? r.kind}</TableCell>
                <TableCell>
                  <pre className="max-w-md overflow-auto whitespace-pre-wrap text-xs">{r.before ?? ""}</pre>
                </TableCell>
                <TableCell>
                  <pre className="max-w-md overflow-auto whitespace-pre-wrap text-xs">{r.after ?? ""}</pre>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
