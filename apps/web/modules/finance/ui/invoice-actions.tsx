"use client";
/**
 * The action dialogs of `/admin/finance/invoices/[id]` (finance spec section 5, `invoices.issue`):
 * Issue credit note (full or by line quantity, reason, "no refund" flag), Reissue to other
 * customer details, Mark paid (open invoices) and Resend email. Dialogs trap focus (Radix);
 * every field has a label and errors are announced with the field.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FormField,
  Input,
  Label,
  Textarea,
} from "@beam/ui";
import { issueManualCreditNote, markInvoicePaid, reissueInvoice, resendInvoiceEmail } from "../actions";
import { actionErrorText, fillLabel, type FinanceLabels } from "./text";

type ActionError = { code: string; message: string; fields?: Record<string, string> };
type Result<T> = { ok: true; data: T } | { ok: false; error: ActionError };

export type CreditableLine = { orderLineId: string; description: string; quantity: number };

export type InvoiceActionsProps = {
  invoiceId: string;
  number: string;
  isOpen: boolean;
  isInvoice: boolean;
  isLive: boolean;
  today: string;
  issuedOn: string;
  lines: CreditableLine[];
  labels: FinanceLabels;
};

function useAction<T>(labels: FinanceLabels, onDone: (data: T) => string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = (call: () => Promise<Result<T>>, close: () => void) =>
    start(async () => {
      setError(null);
      const r = await call();
      if (r.ok) {
        setDone(onDone(r.data));
        close();
        router.refresh();
      } else {
        setError(actionErrorText(labels, r.error));
      }
    });
  return { pending, error, done, submit };
}

function ActionDialog({
  trigger,
  title,
  description,
  labels,
  open,
  setOpen,
  error,
  pending,
  submitLabel,
  onSubmit,
  children,
}: {
  trigger: string;
  title: string;
  description?: string;
  labels: FinanceLabels;
  open: boolean;
  setOpen: (v: boolean) => void;
  error: string | null;
  pending: boolean;
  submitLabel: string;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels["common.close"] ?? "Close"}>
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {children}
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {labels["common.cancel"]}
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? labels["common.saving"] : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreditNoteDialog({ invoiceId, isOpen, lines, labels }: Pick<InvoiceActionsProps, "invoiceId" | "isOpen" | "lines" | "labels">) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"full" | "lines">("full");
  const [reason, setReason] = useState("");
  const [noRefund, setNoRefund] = useState(!isOpen);
  const [qty, setQty] = useState<Record<string, string>>({});
  const a = useAction<{ creditNoteId: string; number: string }>(labels, (d) => fillLabel(labels["credit_note.issued"] ?? "", { number: d.number }));
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const selected = lines
      .map((l) => ({ orderLineId: l.orderLineId, quantity: Number(qty[l.orderLineId] ?? 0) }))
      .filter((l) => Number.isInteger(l.quantity) && l.quantity > 0);
    a.submit(() => issueManualCreditNote({ invoiceId, reason, noRefund, ...(mode === "lines" ? { lines: selected } : {}) }), () => setOpen(false));
  };
  return (
    <>
      <ActionDialog
        trigger={labels["credit_note.open"]!}
        title={labels["credit_note.title"]!}
        description={labels["credit_note.description"]}
        labels={labels}
        open={open}
        setOpen={setOpen}
        error={a.error}
        pending={a.pending}
        submitLabel={labels["credit_note.submit"]!}
        onSubmit={onSubmit}
      >
        <fieldset className="grid gap-2">
          <legend className="sr-only">{labels["credit_note.title"]}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="mode" checked={mode === "full"} onChange={() => setMode("full")} />
            {labels["credit_note.full"]}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="mode" checked={mode === "lines"} onChange={() => setMode("lines")} />
            {labels["credit_note.by_lines"]}
          </label>
        </fieldset>
        {mode === "lines"
          ? lines.map((l) => (
              <FormField key={l.orderLineId} label={fillLabel(labels["credit_note.line_quantity"] ?? "", { description: l.description })}>
                <Input type="number" min={0} max={l.quantity} step={1} value={qty[l.orderLineId] ?? ""} onChange={(e) => setQty({ ...qty, [l.orderLineId]: e.target.value })} />
              </FormField>
            ))
          : null}
        <FormField label={labels["credit_note.reason"]} required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required />
        </FormField>
        <div className="flex items-start gap-2">
          <Checkbox id={`no-refund-${invoiceId}`} checked={noRefund} onCheckedChange={(v) => setNoRefund(v === true)} />
          <div className="grid gap-1">
            <Label htmlFor={`no-refund-${invoiceId}`}>{labels["credit_note.no_refund"]}</Label>
            <p className="text-sm text-muted-foreground">{labels["credit_note.no_refund_hint"]}</p>
          </div>
        </div>
      </ActionDialog>
      <Done text={a.done} />
    </>
  );
}

const EMPTY_BILLING = { isCompany: true, legalName: "", vatNumber: "", line1: "", line2: "", postal_code: "", city: "", country: "BE", billingEmail: "", purchaseOrderRef: "" };

function ReissueDialog({ invoiceId, labels }: Pick<InvoiceActionsProps, "invoiceId" | "labels">) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(EMPTY_BILLING);
  const [reason, setReason] = useState("");
  const a = useAction<{ number: string }>(labels, (d) => fillLabel(labels["reissue.issued"] ?? "", { number: d.number }));
  const field = (key: keyof typeof EMPTY_BILLING, opts: { required?: boolean; type?: string } = {}) => (
    <FormField label={labels[`reissue.${key === "billingEmail" ? "billing_email" : key === "purchaseOrderRef" ? "po_ref" : key === "legalName" ? "legal_name" : key === "vatNumber" ? "vat_number" : key}`]} required={opts.required}>
      <Input type={opts.type ?? "text"} value={String(v[key])} onChange={(e) => setV({ ...v, [key]: e.target.value })} required={opts.required} />
    </FormField>
  );
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const billing = {
      isCompany: v.isCompany,
      legalName: v.legalName,
      ...(v.vatNumber.trim() ? { vatNumber: v.vatNumber.trim() } : {}),
      address: { line1: v.line1, ...(v.line2.trim() ? { line2: v.line2 } : {}), postal_code: v.postal_code, city: v.city, country: v.country.trim().toUpperCase() },
      ...(v.billingEmail.trim() ? { billingEmail: v.billingEmail.trim() } : {}),
      ...(v.purchaseOrderRef.trim() ? { purchaseOrderRef: v.purchaseOrderRef.trim() } : {}),
    };
    a.submit(() => reissueInvoice({ invoiceId, billing, reason }), () => setOpen(false));
  };
  return (
    <>
      <ActionDialog
        trigger={labels["reissue.open"]!}
        title={labels["reissue.title"]!}
        description={labels["reissue.description"]}
        labels={labels}
        open={open}
        setOpen={setOpen}
        error={a.error}
        pending={a.pending}
        submitLabel={labels["reissue.submit"]!}
        onSubmit={onSubmit}
      >
        <div className="flex items-center gap-2">
          <Checkbox id={`is-company-${invoiceId}`} checked={v.isCompany} onCheckedChange={(c) => setV({ ...v, isCompany: c === true })} />
          <Label htmlFor={`is-company-${invoiceId}`}>{labels["reissue.is_company"]}</Label>
        </div>
        {field("legalName", { required: true })}
        {field("vatNumber", { required: v.isCompany })}
        {field("line1", { required: true })}
        {field("line2")}
        <div className="grid grid-cols-2 gap-3">
          {field("postal_code", { required: true })}
          {field("city", { required: true })}
        </div>
        {field("country", { required: true })}
        {field("billingEmail", { type: "email" })}
        {field("purchaseOrderRef")}
        <FormField label={labels["reissue.reason"]} required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required />
        </FormField>
      </ActionDialog>
      <Done text={a.done} />
    </>
  );
}

function MarkPaidDialog({ invoiceId, today, issuedOn, labels }: Pick<InvoiceActionsProps, "invoiceId" | "today" | "issuedOn" | "labels">) {
  const [open, setOpen] = useState(false);
  const [paidOn, setPaidOn] = useState(today);
  const [bankReference, setBankReference] = useState("");
  const [note, setNote] = useState("");
  const a = useAction<{ ok: true }>(labels, () => labels["mark_paid.marked"] ?? "");
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    a.submit(() => markInvoicePaid({ invoiceId, paidOn, note, ...(bankReference.trim() ? { bankReference: bankReference.trim() } : {}) }), () => setOpen(false));
  };
  return (
    <>
      <ActionDialog
        trigger={labels["mark_paid.open"]!}
        title={labels["mark_paid.title"]!}
        labels={labels}
        open={open}
        setOpen={setOpen}
        error={a.error}
        pending={a.pending}
        submitLabel={labels["mark_paid.submit"]!}
        onSubmit={onSubmit}
      >
        <FormField label={labels["mark_paid.paid_on"]} required>
          <Input type="date" value={paidOn} min={issuedOn} max={today} onChange={(e) => setPaidOn(e.target.value)} required />
        </FormField>
        <FormField label={labels["mark_paid.bank_reference"]}>
          <Input value={bankReference} maxLength={100} onChange={(e) => setBankReference(e.target.value)} />
        </FormField>
        <FormField label={labels["mark_paid.note"]} required>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} minLength={3} maxLength={500} required />
        </FormField>
      </ActionDialog>
      <Done text={a.done} />
    </>
  );
}

function ResendDialog({ invoiceId, labels }: Pick<InvoiceActionsProps, "invoiceId" | "labels">) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const a = useAction<{ jobId: string }>(labels, () => labels["resend.queued"] ?? "");
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    a.submit(() => resendInvoiceEmail({ invoiceId, ...(to.trim() ? { to: to.trim() } : {}) }), () => setOpen(false));
  };
  return (
    <>
      <ActionDialog
        trigger={labels["resend.open"]!}
        title={labels["resend.title"]!}
        labels={labels}
        open={open}
        setOpen={setOpen}
        error={a.error}
        pending={a.pending}
        submitLabel={labels["resend.submit"]!}
        onSubmit={onSubmit}
      >
        <FormField label={labels["resend.to"]}>
          <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </ActionDialog>
      <Done text={a.done} />
    </>
  );
}

function Done({ text }: { text: string | null }) {
  return (
    <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
      {text ?? ""}
    </span>
  );
}

/** The dialogs that apply to the document (credit note and reissue on live invoices, mark paid on open ones). */
export function InvoiceActions(props: InvoiceActionsProps) {
  const { invoiceId, isOpen, isInvoice, isLive, labels } = props;
  return (
    <div className="flex flex-wrap items-start gap-2">
      {isInvoice && isLive ? <CreditNoteDialog invoiceId={invoiceId} isOpen={isOpen} lines={props.lines} labels={labels} /> : null}
      {isInvoice && isLive ? <ReissueDialog invoiceId={invoiceId} labels={labels} /> : null}
      {isInvoice && isOpen ? <MarkPaidDialog invoiceId={invoiceId} today={props.today} issuedOn={props.issuedOn} labels={labels} /> : null}
      <ResendDialog invoiceId={invoiceId} labels={labels} />
    </div>
  );
}
