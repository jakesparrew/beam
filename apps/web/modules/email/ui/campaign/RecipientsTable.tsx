"use client";
/**
 * The recipients of `/admin/campaigns/[id]/recipients` (email spec rule 28, section 5): name,
 * masked email (unmasked with `persons.read`), locale, status, chunk and message status; remove a
 * `planned` recipient and restore a removed one while the campaign is `scheduled` or `paused`
 * (`campaigns.send`).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { removeRecipient, restoreRecipient } from "../../actions";
import { clab, type CampaignLabels } from "./CampaignStepper";

export type RecipientRow = { id: string; personId: string; name: string; email: string | null; locale: string; status: string; chunkNo: number; messageStatus: string | null };

export function RecipientsTable(props: { campaignId: string; rows: readonly RecipientRow[]; canEdit: boolean; localeNames: Readonly<Record<string, string>>; labels: CampaignLabels }) {
  const { labels } = props;
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function edit(personId: string, mode: "remove" | "restore") {
    setBusy(personId);
    setError(null);
    const call = mode === "remove" ? removeRecipient : restoreRecipient;
    const result = await call({ campaignId: props.campaignId, personId });
    setBusy(null);
    if (result.ok) router.refresh();
    else setError(labels[`errors.${result.error.code === "forbidden" ? "forbidden" : result.error.message}`] ?? clab(labels, "errors.generic"));
  }

  return (
    <div className="grid gap-3">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Table data-testid="recipients-table">
        <TableHeader>
          <TableRow>
            <TableHead>{clab(labels, "col_name")}</TableHead>
            <TableHead>{clab(labels, "col_email")}</TableHead>
            <TableHead>{clab(labels, "col_locale")}</TableHead>
            <TableHead>{clab(labels, "col_status")}</TableHead>
            <TableHead>{clab(labels, "col_chunk")}</TableHead>
            <TableHead>{clab(labels, "col_message")}</TableHead>
            {props.canEdit ? <TableHead>{clab(labels, "col_actions")}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((r) => (
            <TableRow key={r.id} data-person-id={r.personId} data-status={r.status}>
              <TableCell>{r.name || "—"}</TableCell>
              <TableCell className="font-mono text-xs">{r.email ?? "—"}</TableCell>
              <TableCell>{props.localeNames[r.locale] ?? r.locale}</TableCell>
              <TableCell>
                <Badge variant={r.status === "sent" ? "default" : r.status === "planned" ? "secondary" : "outline"}>{clab(labels, `recipient_${r.status}`)}</Badge>
              </TableCell>
              <TableCell className="tabular-nums">{r.chunkNo + 1}</TableCell>
              <TableCell>{r.messageStatus ?? "—"}</TableCell>
              {props.canEdit ? (
                <TableCell>
                  {r.status === "planned" ? (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void edit(r.personId, "remove")} data-testid="recipient-remove">
                      {clab(labels, "remove")}
                    </Button>
                  ) : r.status === "removed" ? (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void edit(r.personId, "restore")} data-testid="recipient-restore">
                      {clab(labels, "restore")}
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
