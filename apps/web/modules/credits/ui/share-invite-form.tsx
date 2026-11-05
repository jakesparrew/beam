"use client";
/**
 * Invite a named person to a package (credits rule 41, R2): email, first name, optional last name
 * and optional maximum units. `variant="portal"` posts `addMyPackageShare` (the owner, at most 5
 * active shares, mode `named`); `variant="staff"` posts `addPackageShare` (`credits.adjust`; the
 * grant switches to mode `named`). Input is kept on error; the page refreshes on success. Every
 * string arrives as a prop (`creditsLabels` of `errors` plus `portal.sharing` or `admin.sharing`).
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input } from "@beam/ui";
import { addMyPackageShare, addPackageShare } from "../actions";
import { errorMessage, str, type Labels } from "./adjust-dialog";

const SHARING_ERRORS = ["already_shared", "share_with_owner", "grant_not_active", "share_limit", "not_shareable", "review_item_not_found"];

/** The words for a sharing action error (the sharing codes first, then the generic credits mapping). */
export function sharingError(error: { code: string; message: string }, l: Labels): string {
  const specific = SHARING_ERRORS.find((k) => error.message === k);
  return (specific && l[`errors.${specific}`]) || errorMessage(error, l);
}

export function ShareInviteForm({ grantId, variant, labels: l }: { grantId: string; variant: "portal" | "staff"; labels: Labels }) {
  const router = useRouter();
  const g = variant === "portal" ? "portal.sharing" : "admin.sharing";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const f = new FormData(formEl);
    const email = str(f, "email", "").trim();
    const maxUnits = str(f, "maxUnits", "").trim();
    const input = {
      grantId,
      email,
      firstName: str(f, "firstName", ""),
      lastName: str(f, "lastName", "") || undefined,
      maxUnits: maxUnits ? Number(maxUnits) : undefined,
    };
    setBusy(true);
    setError(null);
    setFields({});
    setDone(null);
    try {
      const r = variant === "portal" ? await addMyPackageShare(input) : await addPackageShare(input);
      if (r.ok) {
        formEl.reset();
        setDone((variant === "portal" ? l["portal.sharing.done"] : l["admin.sharing.added"]) ?? "");
        router.refresh();
      } else {
        setError(sharingError(r.error, l));
        setFields(r.error.fields ?? {});
      }
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  const title = variant === "portal" ? l["portal.sharing.invite_title"] : l["admin.sharing.add_title"];
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-3" aria-labelledby={`share-invite-${grantId}`} noValidate>
      <h3 id={`share-invite-${grantId}`} className="text-base font-semibold">
        {title}
      </h3>
      {variant === "staff" && l["admin.sharing.add_hint"] ? <p className="text-sm text-muted-foreground">{l["admin.sharing.add_hint"]}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={l["portal.sharing.email"]} error={fields.email ?? null} required>
          <Input name="email" type="email" autoComplete="off" required maxLength={254} className="min-h-11" />
        </FormField>
        <FormField label={l["portal.sharing.first_name"]} error={fields.firstName ?? null} required>
          <Input name="firstName" required maxLength={100} className="min-h-11" />
        </FormField>
        <FormField label={l["portal.sharing.last_name"]} error={fields.lastName ?? null}>
          <Input name="lastName" maxLength={100} className="min-h-11" />
        </FormField>
        <FormField label={l["portal.sharing.max_units"]} hint={l["portal.sharing.max_units_hint"]} error={fields.maxUnits ?? null}>
          <Input name="maxUnits" type="number" inputMode="numeric" min={1} max={100} className="min-h-11" />
        </FormField>
      </div>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {done ? (
        <p role="status" className="text-sm">
          {done}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} className="min-h-11 w-fit">
        {busy ? (l["portal.sharing.busy"] ?? l[`${g}.add_submit`]) : variant === "portal" ? l["portal.sharing.submit"] : l["admin.sharing.add_submit"]}
      </Button>
    </form>
  );
}
