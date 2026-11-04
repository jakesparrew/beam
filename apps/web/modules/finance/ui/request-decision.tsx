"use client";
/**
 * Approve or reject a company invoice request (`/admin/finance/requests`, rule 20). Rejecting
 * asks for an optional note that the customer sees.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, FormField, Textarea } from "@beam/ui";
import { decideCompanyInvoiceRequest } from "../actions";
import { actionErrorText, type FinanceLabels } from "./text";

export function RequestDecision({ requestId, labels }: { requestId: string; labels: FinanceLabels }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const decide = (decision: "approve" | "reject") =>
    start(async () => {
      const r = await decideCompanyInvoiceRequest({ requestId, decision, ...(decision === "reject" && note.trim() ? { note: note.trim() } : {}) });
      if (r.ok) {
        setMessage({ ok: true, text: labels[decision === "approve" ? "requests.approved" : "requests.rejected"] ?? "" });
        router.refresh();
      } else {
        setMessage({ ok: false, text: actionErrorText(labels, r.error) });
      }
    });

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => decide("approve")} disabled={pending}>
          {labels["requests.approve"]}
        </Button>
        {rejecting ? (
          <Button type="button" size="sm" variant="outline" onClick={() => decide("reject")} disabled={pending}>
            {labels["common.confirm"]}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={pending}>
            {labels["requests.reject"]}
          </Button>
        )}
      </div>
      {rejecting ? (
        <FormField label={labels["requests.reject_note"]}>
          <Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      ) : null}
      <span role="status" aria-live="polite" className={message?.ok === false ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {message?.text ?? ""}
      </span>
    </div>
  );
}
