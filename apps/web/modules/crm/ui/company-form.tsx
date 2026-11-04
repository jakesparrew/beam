"use client";
/**
 * The company form of `/admin/companies/new` and the company page (crm spec 5.1, rule 3.45). A
 * taken VAT number ("Another company has this VAT number") and an invalid one are shown on the
 * field; the commission field appears for a partner company only.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, Textarea } from "@beam/ui";
import { saveCompany } from "../actions";

export type CompanyFormValues = {
  id?: string;
  name: string;
  vatNumber: string;
  street: string;
  number: string;
  postalCode: string;
  city: string;
  country: string;
  website: string;
  industry: string;
  size: string;
  status: string;
  ownerUserId: string;
  notes: string;
  isPartner: boolean;
  partnerCommissionPct: string;
};

export type CompanyFormLabels = {
  name: string;
  vat: string;
  address: string;
  street: string;
  number: string;
  postalCode: string;
  city: string;
  country: string;
  website: string;
  industry: string;
  size: string;
  status: string;
  owner: string;
  notes: string;
  isPartner: string;
  commission: string;
  vatTaken: string;
  vatInvalid: string;
  none: string;
  save: string;
  saving: string;
  saved: string;
  cancel: string;
  error: string;
};

type Option = { value: string; label: string };

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Select({ name, defaultValue, options, none }: { name: string; defaultValue: string; options: Option[]; none?: string }) {
  return (
    <select name={name} defaultValue={defaultValue} className={selectClass}>
      {none !== undefined ? <option value="">{none}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CompanyForm({
  initial,
  sizes,
  statuses,
  owners,
  labels,
  onDone,
}: {
  initial: CompanyFormValues;
  sizes: Option[];
  statuses: Option[];
  owners: Option[];
  labels: CompanyFormLabels;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [isPartner, setIsPartner] = useState(initial.isPartner);
  const [error, setError] = useState<{ text: string; field?: "vatNumber" } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const get = (k: keyof CompanyFormValues) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const opt = (k: keyof CompanyFormValues) => (get(k) ? get(k) : undefined);
    const hasAddress = ["street", "number", "postalCode", "city"].some((k) => get(k as keyof CompanyFormValues));
    const address = hasAddress
      ? Object.fromEntries(
          Object.entries({ street: get("street"), number: get("number"), postal_code: get("postalCode"), city: get("city"), country: (get("country") || "BE").toUpperCase() }).filter(([, v]) => v),
        )
      : undefined;
    const commission = get("partnerCommissionPct");
    const body = {
      ...(initial.id ? { id: initial.id } : {}),
      name: get("name"),
      vatNumber: opt("vatNumber"),
      address,
      website: opt("website"),
      industry: opt("industry"),
      size: opt("size"),
      status: get("status") || "target",
      ownerUserId: opt("ownerUserId"),
      notes: opt("notes"),
      isPartner,
      ...(isPartner && commission ? { partnerCommissionPct: Number(commission.replace(",", ".")) } : {}),
    };
    setPending(true);
    setError(null);
    try {
      const result = await saveCompany(body);
      if (result.ok) {
        onDone?.();
        if (initial.id) router.refresh();
        else router.push(`/admin/companies/${result.data.companyId}` as never);
        return;
      }
      const e = result.error;
      if (e.message === "vat_taken") setError({ text: labels.vatTaken, field: "vatNumber" });
      else if (e.message === "vat_invalid") setError({ text: labels.vatInvalid, field: "vatNumber" });
      else setError({ text: labels.error });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-3xl gap-4" noValidate>
      {error && !error.field ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error.text}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={labels.name} required>
          <Input name="name" defaultValue={initial.name} maxLength={200} required />
        </FormField>
        <FormField label={labels.vat} error={error?.field === "vatNumber" ? error.text : undefined}>
          <Input name="vatNumber" defaultValue={initial.vatNumber} maxLength={30} placeholder="BE0123456789" autoComplete="off" />
        </FormField>
      </div>
      <fieldset className="grid gap-4 sm:grid-cols-4">
        <legend className="mb-2 text-sm font-medium">{labels.address}</legend>
        <FormField label={labels.street} className="sm:col-span-2">
          <Input name="street" defaultValue={initial.street} maxLength={200} />
        </FormField>
        <FormField label={labels.number}>
          <Input name="number" defaultValue={initial.number} maxLength={20} />
        </FormField>
        <FormField label={labels.postalCode}>
          <Input name="postalCode" defaultValue={initial.postalCode} maxLength={20} />
        </FormField>
        <FormField label={labels.city} className="sm:col-span-3">
          <Input name="city" defaultValue={initial.city} maxLength={100} />
        </FormField>
        <FormField label={labels.country}>
          <Input name="country" defaultValue={initial.country} maxLength={2} />
        </FormField>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={labels.website}>
          <Input name="website" type="url" defaultValue={initial.website} maxLength={300} />
        </FormField>
        <FormField label={labels.industry}>
          <Input name="industry" defaultValue={initial.industry} maxLength={100} />
        </FormField>
        <FormField label={labels.size}>
          <Select name="size" defaultValue={initial.size} options={sizes} none={labels.none} />
        </FormField>
        <FormField label={labels.status}>
          <Select name="status" defaultValue={initial.status} options={statuses} />
        </FormField>
        <FormField label={labels.owner}>
          <Select name="ownerUserId" defaultValue={initial.ownerUserId} options={owners} none={labels.none} />
        </FormField>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={isPartner} onCheckedChange={(v) => setIsPartner(v === true)} />
        {labels.isPartner}
      </label>
      {isPartner ? (
        <FormField label={labels.commission}>
          <Input name="partnerCommissionPct" type="number" min={0} max={100} step="0.01" defaultValue={initial.partnerCommissionPct} />
        </FormField>
      ) : null}
      <FormField label={labels.notes}>
        <Textarea name="notes" defaultValue={initial.notes} maxLength={5000} rows={4} />
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? labels.saving : labels.save}
        </Button>
        {onDone ? (
          <Button type="button" variant="outline" onClick={onDone}>
            {labels.cancel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
