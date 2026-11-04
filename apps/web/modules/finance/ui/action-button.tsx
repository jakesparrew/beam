"use client";
/**
 * One-click finance actions without a form (finance spec section 5): Retry Billit, Retry all
 * failed, Run reconcile now, Re-render PDF (one or all blocked) and Send payment reminder (with a
 * confirmation). The result is announced in a live region; the page refreshes on success.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@beam/ui";
import { rerenderInvoicePdf, retryAllBillitFailed, retryBillitSync, runBillitReconcileNow, sendPaymentReminder } from "../actions";
import { actionErrorText, fillLabel, type FinanceLabels } from "./text";

export type FinanceButtonKind = "retry" | "retry_all" | "reconcile" | "rerender" | "rerender_blocked" | "reminder";

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

async function run(kind: FinanceButtonKind, invoiceId: string | undefined): Promise<Result> {
  switch (kind) {
    case "retry":
      return retryBillitSync({ invoiceId });
    case "retry_all":
      return retryAllBillitFailed({});
    case "reconcile":
      return runBillitReconcileNow({});
    case "rerender":
      return rerenderInvoicePdf({ invoiceId });
    case "rerender_blocked":
      return rerenderInvoicePdf({ allBlocked: true });
    case "reminder":
      return sendPaymentReminder({ invoiceId });
  }
}

function successText(kind: FinanceButtonKind, data: unknown, labels: FinanceLabels): string {
  const d = (data ?? {}) as { count?: number; jobIds?: string[] };
  switch (kind) {
    case "retry":
      return labels["retry.queued"] ?? "";
    case "retry_all":
      return fillLabel(labels["retry.all_queued"] ?? "", { count: d.count ?? 0 });
    case "reconcile":
      return labels["sync.run_queued"] ?? "";
    case "rerender":
    case "rerender_blocked":
      return fillLabel(labels["rerender.queued"] ?? "", { count: d.jobIds?.length ?? 0 });
    case "reminder":
      return labels["reminder.queued"] ?? "";
  }
}

export function FinanceActionButton({
  kind,
  label,
  labels,
  invoiceId,
  confirmText,
  variant = "outline",
}: {
  kind: FinanceButtonKind;
  label: string;
  labels: FinanceLabels;
  invoiceId?: string;
  confirmText?: string;
  variant?: "default" | "outline" | "secondary";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const onClick = () => {
    if (confirmText && !window.confirm(confirmText)) return;
    start(async () => {
      const r = await run(kind, invoiceId);
      if (r.ok) {
        setMessage({ ok: true, text: successText(kind, r.data, labels) });
        router.refresh();
      } else {
        setMessage({ ok: false, text: actionErrorText(labels, r.error) });
      }
    });
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <Button type="button" variant={variant} size="sm" onClick={onClick} disabled={pending} aria-busy={pending}>
        {pending ? (labels["common.saving"] ?? label) : label}
      </Button>
      <span role="status" aria-live="polite" className={message?.ok === false ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {message?.text ?? ""}
      </span>
    </span>
  );
}
