"use client";
/**
 * The identity form of `/admin/persons/new` and `/admin/persons/[id]/edit` (crm spec 5.1). Create
 * shows the duplicate panel when candidates score 50 or more ("Open existing", "Create anyway");
 * edit sends the row `version` and answers a stale version with "Changed by someone else, reload".
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input } from "@beam/ui";
import { createPerson, updatePerson } from "../actions";

export type PersonFormValues = {
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  locale: string;
  street: string;
  number: string;
  box: string;
  postalCode: string;
  city: string;
  country: string;
  birthOn: string;
  preferredChannel: string;
  acquisitionSource: string;
  acquisitionCampaign: string;
  linkedinUrl: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelation: string;
};

export type PersonFormLabels = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  locale: string;
  address: string;
  street: string;
  number: string;
  box: string;
  postalCode: string;
  city: string;
  country: string;
  birthOn: string;
  preferredChannel: string;
  acquisitionSource: string;
  acquisitionCampaign: string;
  linkedinUrl: string;
  emergencyContact: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelation: string;
  needIdentity: string;
  duplicatesTitle: string;
  duplicatesIntro: string;
  openExisting: string;
  createAnyway: string;
  emailTaken: string;
  openMerge: string;
  loginTaken: string;
  staleVersion: string;
  reload: string;
  save: string;
  saving: string;
  saved: string;
  cancel: string;
  none: string;
  error: string;
  reasons: Record<string, string>;
};

export type Option = { value: string; label: string };

type Candidate = { personId: string; customerNumber: string; name: string; score: number; reasons: string[] };

const blank = (v: string) => (v.trim() ? v.trim() : undefined);

function Select({ name, defaultValue, options, noneLabel, id, ...rest }: { name: string; defaultValue: string; options: Option[]; noneLabel?: string; id?: string }) {
  return (
    <select
      id={id}
      name={name}
      defaultValue={defaultValue}
      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      {...rest}
    >
      {noneLabel !== undefined ? <option value="">{noneLabel}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function PersonForm({
  mode,
  personId,
  version,
  initial,
  labels,
  locales,
  channels,
  sources,
}: {
  mode: "create" | "edit";
  personId?: string;
  version?: number;
  initial: PersonFormValues;
  labels: PersonFormLabels;
  locales: Option[];
  channels: Option[];
  sources: Option[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; field?: string; stale?: boolean; mergeWith?: string } | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [values, setValues] = useState<FormData | null>(null);

  function read(form: FormData) {
    const get = (k: keyof PersonFormValues) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    const hasAddress = ["street", "number", "box", "postalCode", "city"].some((k) => get(k as keyof PersonFormValues).trim());
    const address = hasAddress
      ? Object.fromEntries(
          Object.entries({ street: get("street"), number: get("number"), box: get("box"), postal_code: get("postalCode"), city: get("city"), country: get("country") || "BE" })
            .map(([k, v]) => [k, v.trim()] as const)
            .filter(([, v]) => v),
        )
      : undefined;
    return { get, address: address as { country: string } | undefined };
  }

  async function submitCreate(form: FormData, confirmDuplicates: boolean) {
    const { get, address } = read(form);
    const result = await createPerson({
      email: blank(get("email")),
      phone: blank(get("phone")),
      firstName: blank(get("firstName")),
      lastName: blank(get("lastName")),
      locale: get("locale"),
      address,
      birthOn: blank(get("birthOn")),
      preferredChannel: blank(get("preferredChannel")),
      acquisition: { source: get("acquisitionSource") || "manual", ...(blank(get("acquisitionCampaign")) ? { campaign: blank(get("acquisitionCampaign")) } : {}) },
      confirmDuplicates,
    });
    if (result.ok) {
      router.push(`/admin/persons/${result.data.personId}` as never);
      return;
    }
    const e = result.error;
    if (e.code === "conflict" && e.message === "possible_duplicates" && e.fields?.candidates) {
      setCandidates(JSON.parse(e.fields.candidates) as Candidate[]);
      setValues(form);
    } else if (e.code === "conflict" && e.message === "email_taken") {
      setError({ text: labels.emailTaken.replace("{customerNumber}", e.fields?.customerNumber ?? ""), field: "email" });
    } else if (e.code === "validation" && e.message === "need_identity") {
      setError({ text: labels.needIdentity, field: "email" });
    } else setError({ text: labels.error });
  }

  async function submitEdit(form: FormData) {
    const { get, address } = read(form);
    const emergency = blank(get("emergencyName")) || blank(get("emergencyPhone"));
    const result = await updatePerson({
      personId,
      version,
      patch: {
        email: blank(get("email")) ?? null,
        phone: blank(get("phone")) ?? null,
        firstName: blank(get("firstName")) ?? null,
        lastName: blank(get("lastName")) ?? null,
        locale: get("locale"),
        address: address ?? null,
        birthOn: blank(get("birthOn")) ?? null,
        preferredChannel: blank(get("preferredChannel")) ?? null,
        linkedinUrl: blank(get("linkedinUrl")) ?? null,
        emergencyContact: emergency
          ? { name: get("emergencyName").trim(), phone: get("emergencyPhone").trim(), ...(blank(get("emergencyRelation")) ? { relation: blank(get("emergencyRelation")) } : {}) }
          : null,
      },
    });
    if (result.ok) {
      router.push(`/admin/persons/${personId}` as never);
      router.refresh();
      return;
    }
    const e = result.error;
    if (e.code === "conflict" && e.message === "stale_version") setError({ text: labels.staleVersion, stale: true });
    else if (e.code === "conflict" && e.message === "email_taken")
      setError({ text: labels.emailTaken.replace("{customerNumber}", e.fields?.customerNumber ?? ""), field: "email", mergeWith: e.fields?.personId });
    else if (e.code === "conflict" && e.message === "email_in_use") setError({ text: labels.loginTaken, field: "email" });
    else setError({ text: labels.error });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      if (mode === "create") await submitCreate(form, false);
      else await submitEdit(form);
    } finally {
      setPending(false);
    }
  }

  async function createAnyway() {
    if (!values) return;
    setPending(true);
    try {
      await submitCreate(values, true);
    } finally {
      setPending(false);
    }
  }

  const fieldError = (name: string) => (error?.field === name ? error.text : null);

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-3xl gap-6" noValidate>
      {error && !error.field ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {error.text}{" "}
            {error.stale ? (
              <Button type="button" variant="link" onClick={() => router.refresh()}>
                {labels.reload}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={labels.firstName}>
          <Input name="firstName" defaultValue={initial.firstName} maxLength={100} autoComplete="off" />
        </FormField>
        <FormField label={labels.lastName}>
          <Input name="lastName" defaultValue={initial.lastName} maxLength={100} autoComplete="off" />
        </FormField>
        <FormField label={labels.email} error={fieldError("email")}>
          <Input name="email" type="email" defaultValue={initial.email} maxLength={254} autoComplete="off" />
        </FormField>
        <FormField label={labels.phone}>
          <Input name="phone" type="tel" defaultValue={initial.phone} maxLength={40} autoComplete="off" />
        </FormField>
        <FormField label={labels.locale} required>
          <Select name="locale" defaultValue={initial.locale} options={locales} />
        </FormField>
        <FormField label={labels.preferredChannel}>
          <Select name="preferredChannel" defaultValue={initial.preferredChannel} options={channels} noneLabel={labels.none} />
        </FormField>
        <FormField label={labels.birthOn}>
          <Input name="birthOn" type="date" defaultValue={initial.birthOn} />
        </FormField>
      </div>
      {error?.mergeWith ? (
        <p>
          <Link href={`/admin/persons/${personId}/merge?with=${error.mergeWith}` as never}>{labels.openMerge}</Link>
        </p>
      ) : null}

      <fieldset className="grid gap-4">
        <legend className="mb-2 text-sm font-medium">{labels.address}</legend>
        <div className="grid gap-4 sm:grid-cols-6">
          <FormField label={labels.street} className="sm:col-span-4">
            <Input name="street" defaultValue={initial.street} maxLength={200} />
          </FormField>
          <FormField label={labels.number}>
            <Input name="number" defaultValue={initial.number} maxLength={20} />
          </FormField>
          <FormField label={labels.box}>
            <Input name="box" defaultValue={initial.box} maxLength={20} />
          </FormField>
          <FormField label={labels.postalCode} className="sm:col-span-2">
            <Input name="postalCode" defaultValue={initial.postalCode} maxLength={20} />
          </FormField>
          <FormField label={labels.city} className="sm:col-span-3">
            <Input name="city" defaultValue={initial.city} maxLength={100} />
          </FormField>
          <FormField label={labels.country}>
            <Input name="country" defaultValue={initial.country || "BE"} maxLength={2} minLength={2} />
          </FormField>
        </div>
      </fieldset>

      {mode === "create" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={labels.acquisitionSource} required>
            <Select name="acquisitionSource" defaultValue={initial.acquisitionSource || "manual"} options={sources} />
          </FormField>
          <FormField label={labels.acquisitionCampaign}>
            <Input name="acquisitionCampaign" defaultValue={initial.acquisitionCampaign} maxLength={200} />
          </FormField>
        </div>
      ) : (
        <>
          <FormField label={labels.linkedinUrl}>
            <Input name="linkedinUrl" type="url" defaultValue={initial.linkedinUrl} maxLength={300} />
          </FormField>
          <fieldset className="grid gap-4">
            <legend className="mb-2 text-sm font-medium">{labels.emergencyContact}</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label={labels.emergencyName}>
                <Input name="emergencyName" defaultValue={initial.emergencyName} maxLength={100} />
              </FormField>
              <FormField label={labels.emergencyPhone}>
                <Input name="emergencyPhone" type="tel" defaultValue={initial.emergencyPhone} maxLength={40} />
              </FormField>
              <FormField label={labels.emergencyRelation}>
                <Input name="emergencyRelation" defaultValue={initial.emergencyRelation} maxLength={100} />
              </FormField>
            </div>
          </fieldset>
        </>
      )}

      {candidates?.length ? (
        <Card data-testid="duplicate-panel">
          <CardHeader>
            <CardTitle>{labels.duplicatesTitle}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-muted-foreground text-sm">{labels.duplicatesIntro}</p>
            <ul className="grid gap-2">
              {candidates.map((c) => (
                <li key={c.personId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-muted-foreground font-mono text-xs">{c.customerNumber}</span>
                  <Badge variant="secondary">{c.score}</Badge>
                  {c.reasons.map((r) => (
                    <Badge key={r} variant="outline">
                      {labels.reasons[r] ?? r}
                    </Badge>
                  ))}
                  <Link className="underline" href={`/admin/persons/${c.personId}` as never}>
                    {labels.openExisting}
                  </Link>
                </li>
              ))}
            </ul>
            <div>
              <Button type="button" variant="outline" onClick={() => void createAnyway()} disabled={pending}>
                {labels.createAnyway}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? labels.saving : labels.save}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  );
}
