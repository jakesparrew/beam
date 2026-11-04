/**
 * Version history of a template (email spec section 5, read-only previous versions): every
 * version newest first with its state (draft, current, earlier) and publish time, each opening
 * the read-only preview of that version. Rendered on the server; strings arrive as props.
 */
import Link from "next/link";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";

type EditorLabels = Readonly<Record<string, string>>;
/** Server-side twin of the editor's label lookup (the editor's helper lives in a client module). */
const lab = (labels: EditorLabels, key: string): string => labels[key] ?? key;

export type VersionHistoryRow = { id: string; version: number; publishedAt: string | null; createdAt: string };

export type VersionHistoryProps = {
  templateId: string;
  currentVersionId: string | null;
  versions: readonly VersionHistoryRow[];
  labels: EditorLabels;
};

export function VersionHistory({ templateId, currentVersionId, versions, labels }: VersionHistoryProps) {
  if (!versions.length) return null;
  return (
    <section className="grid gap-2" aria-labelledby="version-history">
      <h2 id="version-history" className="text-base font-semibold">
        {lab(labels, "history")}
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{lab(labels, "history_version")}</TableHead>
            <TableHead>{lab(labels, "history_state")}</TableHead>
            <TableHead>{lab(labels, "history_published")}</TableHead>
            <TableHead>
              <span className="sr-only">{lab(labels, "preview")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((v) => (
            <TableRow key={v.id}>
              <TableCell className="tabular-nums">v{v.version}</TableCell>
              <TableCell>
                {v.publishedAt === null ? (
                  <Badge variant="secondary">{lab(labels, "state_draft")}</Badge>
                ) : v.id === currentVersionId ? (
                  <Badge>{lab(labels, "state_current")}</Badge>
                ) : (
                  <Badge variant="outline">{lab(labels, "state_previous")}</Badge>
                )}
              </TableCell>
              <TableCell>{v.publishedAt ?? "—"}</TableCell>
              <TableCell>
                <Link className="text-sm underline-offset-2 hover:underline" href={`/admin/templates/${templateId}/preview?version=${v.id}`}>
                  {lab(labels, "preview")}
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
