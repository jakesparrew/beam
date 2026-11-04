"use client";
/**
 * `/admin/credits/new` (credits spec section 5, rule 4): person, kind, units, label in the three
 * locales, source (manual or bonus), validity (days, a date, or no expiry for store credit only),
 * guests and reason. Posts `createGrant` with the form's `clientKey`; keeps the input on error.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input, LocalizedInput, Textarea } from "@beam/ui";
import { createGrant } from "../actions";
import { errorMessage, useClientKey, type Labels, str } from "./adjust-dialog";
import { PersonPicker, type PickedPerson } from "./transfer-dialog";

type Locale = "nl-BE" | "fr-BE" | "en";
type Kind = "day" | "night" | "euro";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];
const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function NewGrantForm({ labels: l, person }: { labels: Labels; person: PickedPerson | null }) {
  const router = useRouter();
  const [clientKey] = useClientKey();
  const [kind, setKind] = useState<Kind>("day");
  const [validity, setValidity] = useState<"days" | "date" | "none">("days");
  const [label, setLabel] = useState<Partial<Record<Locale, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const n = (k: string) => l[`admin.new_grant.${k}`] ?? k;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    setFields({});
    const v = validity === "none" && kind !== "euro" ? "days" : validity;
    try {
      const r = await createGrant({
        personId: str(f, "personId", ""),
        kind,
        units: Number(f.get("units")),
        source: str(f, "source", "manual"),
        label,
        ...(v === "days" ? { validityDays: Number(f.get("validityDays")) } : {}),
        ...(v === "date" ? { expiresAt: str(f, "expiresOn", "") } : {}),
        ...(v === "none" ? { noExpiry: true } : {}),
        reason: str(f, "reason", ""),
        sharingMode: kind === "euro" ? "none" : str(f, "sharingMode", "none"),
        clientKey,
      });
      if (r.ok) {
        router.push(`/admin/credits/grants/${r.data.grantId}`);
        router.refresh();
        return;
      }
      setError(errorMessage(r.error, l));
      setFields(r.error.fields ?? {});
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-2xl gap-5" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <PersonPicker name="personId" labels={l} initial={person} error={fields.personId} />
      <FormField label={n("kind")} error={fields.kind ?? null} required>
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={selectClass}>
          {(["day", "night", "euro"] as const).map((k) => (
            <option key={k} value={k}>
              {l[`enum.kind.${k}`]}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label={n("units")} hint={n("units_hint")} error={fields.units ?? null} required>
        <Input name="units" type="number" min={1} max={kind === "euro" ? 100000 : 100} step={1} required inputMode="numeric" />
      </FormField>
      <LocalizedInput
        name="label"
        value={label}
        onChange={(x) => setLabel(x)}
        locales={LOCALES}
        labels={{
          field: n("label"),
          locales: { "nl-BE": l["admin.common.locale_nl"]!, "fr-BE": l["admin.common.locale_fr"]!, en: l["admin.common.locale_en"]! },
          missing: l["admin.common.missing"]!,
          complete: l["admin.common.complete"]!,
        }}
        error={fields.label ?? Object.entries(fields).find(([k]) => k.startsWith("label."))?.[1] ?? null}
      />
      <FormField label={n("source")} error={fields.source ?? null} required>
        <select name="source" defaultValue="manual" className={selectClass}>
          {(["manual", "bonus"] as const).map((s) => (
            <option key={s} value={s}>
              {l[`enum.source.${s}`]}
            </option>
          ))}
        </select>
      </FormField>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">{n("validity")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="validity" value="days" checked={validity === "days"} onChange={() => setValidity("days")} />
          {n("validity_days")}
        </label>
        {validity === "days" ? (
          <FormField label={n("days")} error={fields.validityDays ?? null} required>
            <Input name="validityDays" type="number" min={1} max={1825} step={1} defaultValue={365} inputMode="numeric" />
          </FormField>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="validity" value="date" checked={validity === "date"} onChange={() => setValidity("date")} />
          {n("validity_date")}
        </label>
        {validity === "date" ? (
          <FormField label={n("date")} error={fields.expiresAt ?? null} required>
            <Input name="expiresOn" type="date" />
          </FormField>
        ) : null}
        {kind === "euro" ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="validity" value="none" checked={validity === "none"} onChange={() => setValidity("none")} />
            {n("no_expiry")}
          </label>
        ) : null}
      </fieldset>
      {kind !== "euro" ? (
        <FormField label={n("sharing")} error={fields.sharingMode ?? null}>
          <select name="sharingMode" defaultValue="none" className={selectClass}>
            {(["none", "guests"] as const).map((m) => (
              <option key={m} value={m}>
                {l[`enum.sharing_mode.${m}`]}
              </option>
            ))}
          </select>
        </FormField>
      ) : null}
      <FormField label={l["admin.common.reason"]} hint={l["admin.common.reason_hint"]} error={fields.reason ?? null} required>
        <Textarea name="reason" required minLength={3} maxLength={500} rows={2} />
      </FormField>
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? l["admin.common.saving"] : n("submit")}
        </Button>
      </div>
    </form>
  );
}
