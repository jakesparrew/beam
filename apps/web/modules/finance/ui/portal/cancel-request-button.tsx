"use client";
/** Withdraws the customer's own pending company invoice request (`cancelCompanyInvoiceRequest`). */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@beam/ui";
import { cancelCompanyInvoiceRequest } from "../../actions";
import { portalErrorText, type PortalLabels } from "./labels";

export function CancelRequestButton({ requestId, labels }: { requestId: string; labels: PortalLabels }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const onClick = () =>
    start(async () => {
      const r = await cancelCompanyInvoiceRequest({ requestId });
      if (r.ok) {
        setMessage({ ok: true, text: labels["request.cancelled_done"] ?? "" });
        router.refresh();
      } else {
        setMessage({ ok: false, text: portalErrorText(labels, r.error) });
      }
    });

  return (
    <span className="inline-flex flex-col gap-1">
      <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={pending} aria-busy={pending}>
        {pending ? labels["request.cancelling"] : labels["request.cancel"]}
      </Button>
      <span role="status" aria-live="polite" className={message?.ok === false ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {message?.text ?? ""}
      </span>
    </span>
  );
}
