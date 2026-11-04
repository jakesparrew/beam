"use client";
/**
 * "Need an invoice in your company's name?" (finance rule 20, spec section 5): the company
 * billing fields (`finance.billing.*` labels) posted to `requestCompanyInvoice`. Field errors
 * come back as `finance.billing.*` or `finance.errors.*` keys and are shown next to the field;
 * the result is announced in a live region and the page refreshes on success.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button, FormField, Input } from "@beam/ui";
import { requestCompanyInvoice } from "../../actions";
import { portalErrorText, type PortalLabels } from "./labels";

type Fields = {
  legalName: string;
  vatNumber: string;
  line1: string;
  line2: string;
  postalCode: string;
  city: string;
  country: string;
  billingEmail: string;
  purchaseOrderRef: string;
};

const EMPTY: Fields = { legalName: "", vatNumber: "", line1: "", line2: "", postalCode: "", city: "", country: "BE", billingEmail: "", purchaseOrderRef: "" };

/** Maps the action's field paths (`billing.vatNumber`, `billing.address.city`) to the form's fields. */
const FIELD_OF: Record<string, keyof Fields> = {
  "billing.legalName": "legalName",
  "billing.vatNumber": "vatNumber",
  "billing.address.line1": "line1",
  "billing.address.line2": "line2",
  "billing.address.postal_code": "postalCode",
  "billing.address.city": "city",
  "billing.address.country": "country",
  "billing.billingEmail": "billingEmail",
  "billing.purchaseOrderRef": "purchaseOrderRef",
};

export function CompanyRequestForm({ invoiceId, labels }: { invoiceId: string; labels: PortalLabels }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [values, setValues] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const set = (key: keyof Fields) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const req = labels["request.required_mark"] ?? " *";

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);
    start(async () => {
      const r = await requestCompanyInvoice({
        invoiceId,
        billing: {
          isCompany: true,
          legalName: values.legalName,
          vatNumber: values.vatNumber,
          address: { line1: values.line1, ...(values.line2.trim() ? { line2: values.line2 } : {}), postal_code: values.postalCode, city: values.city, country: values.country },
          ...(values.billingEmail.trim() ? { billingEmail: values.billingEmail } : {}),
          ...(values.purchaseOrderRef.trim() ? { purchaseOrderRef: values.purchaseOrderRef } : {}),
        },
      });
      if (r.ok) {
        setErrors({});
        setValues(EMPTY);
        setMessage({ ok: true, text: labels["request.sent"] ?? "" });
        router.refresh();
        return;
      }
      const fieldErrors: Partial<Record<keyof Fields, string>> = {};
      for (const [path, key] of Object.entries(r.error.fields ?? {})) {
        const field = FIELD_OF[path];
        if (field) fieldErrors[field] = /^finance\.(billing|errors)\./.test(key) ? portalErrorText(labels, { code: "validation", message: key }) : (labels["request.field_invalid"] ?? key);
      }
      setErrors(fieldErrors);
      setMessage({ ok: false, text: portalErrorText(labels, r.error) });
    });
  };

  const field = (key: keyof Fields, label: string, opts: { required?: boolean; type?: string; hint?: string; autoComplete?: string } = {}) => (
    <FormField label={labels[label] ?? label} error={errors[key] ?? null} required={opts.required} requiredMark={req} {...(opts.hint ? { hint: opts.hint } : {})}>
      <Input
        name={key}
        type={opts.type ?? "text"}
        value={values[key]}
        onChange={set(key)}
        required={opts.required}
        {...(opts.autoComplete ? { autoComplete: opts.autoComplete } : {})}
      />
    </FormField>
  );

  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      {field("legalName", "billing.legal_name", { required: true, autoComplete: "organization" })}
      {field("vatNumber", "billing.vat_number", { required: true, hint: labels["billing.vat_number_hint"] })}
      {field("line1", "billing.address_line1", { required: true, autoComplete: "address-line1" })}
      {field("line2", "billing.address_line2", { autoComplete: "address-line2" })}
      <div className="grid gap-3 sm:grid-cols-3">
        {field("postalCode", "billing.postal_code", { required: true, autoComplete: "postal-code" })}
        {field("city", "billing.city", { required: true, autoComplete: "address-level2" })}
        {field("country", "billing.country", { required: true, autoComplete: "country" })}
      </div>
      {field("billingEmail", "billing.billing_email", { type: "email", autoComplete: "email" })}
      {field("purchaseOrderRef", "billing.purchase_order_ref")}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? labels["request.submitting"] : labels["request.submit"]}
        </Button>
        <span role="status" aria-live="polite" className={message?.ok === false ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {message?.text ?? ""}
        </span>
      </div>
    </form>
  );
}
