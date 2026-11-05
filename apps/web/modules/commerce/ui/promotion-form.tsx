"use client";
/**
 * The promotion form of `/admin/products/promotions/new` and `/[id]` (commerce spec 5.1, rules 17
 * and 18). Once a promotion has been used, its code, discount, start, products and eligibility are
 * disabled with the hint "used N times"; name, end, limits and the active switch stay editable.
 * R3 (commerce-P9): when the page passes `options.partners` (crm's partner companies), a code can
 * be attributed to a partner (referral code); the partner is locked after the first use like the
 * code. Without `options.partners` the field is not shown and not sent, so the partner is kept.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, LocalizedInput } from "@beam/ui";
import { createPromotion, updatePromotion } from "../actions";

type Locale = "nl-BE" | "fr-BE" | "en";
type Localized = Partial<Record<Locale, string>>;
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];

export type Labels = Record<string, string>;
export type Option = { value: string; label: string };

export type PromotionFormValues = {
  id?: string;
  code: string;
  name: Localized;
  kind: "percent" | "fixed";
  /** Percent (1-100) or euros for a fixed discount, as typed. */
  value: string;
  productIds: string[];
  productKinds: string[];
  statuses: string[];
  channels: string[];
  segmentId: string;
  firstOrderOnly: boolean;
  /** `YYYY-MM-DDTHH:mm` in Brussels time. */
  startsAt: string;
  endsAt: string;
  maxUses: string;
  maxUsesPerPerson: string;
  isActive: boolean;
  /** R3: the partner company id of a referral code, `""` for none. */
  partnerCompanyId?: string;
};

export type PromotionFormOptions = {
  kinds: Option[];
  products: Option[];
  productKinds: Option[];
  statuses: Option[];
  channels: Option[];
  localeNames: Record<Locale, string>;
  /** R3: crm's partner companies (`listPartnerCompanies`); omit to hide the partner field. */
  partners?: Option[];
};

const optInt = (v: string): number | null => (v.trim() === "" ? null : Number.parseInt(v, 10));

function CheckboxGroup({ legend, options, value, onChange, disabled, hint }: { legend: string; options: Option[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; hint?: string }) {
  return (
    <fieldset className="grid gap-2" disabled={disabled} title={disabled ? hint : undefined}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={value.includes(o.value)}
              disabled={disabled}
              onCheckedChange={(c) => onChange(c === true ? [...value, o.value] : value.filter((x) => x !== o.value))}
            />
            {o.label}
          </label>
        ))}
      </div>
      {disabled && hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </fieldset>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {children}
    </fieldset>
  );
}

export function PromotionForm({ initial, usesCount, options, labels }: { initial: PromotionFormValues; usesCount: number; options: PromotionFormOptions; labels: Labels }) {
  const router = useRouter();
  const l = (k: string) => labels[k] ?? k;
  const [v, setV] = useState<PromotionFormValues>(initial);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = <K extends keyof PromotionFormValues>(k: K, value: PromotionFormValues[K]) => setV((s) => ({ ...s, [k]: value }));
  const locked = usesCount > 0;
  // `locked` arrives formatted with the use count (ICU plural) from the server page.
  const lockedHint = l("locked");
  const fieldError = (key: string): string | undefined => {
    const code = fields[key];
    if (!code) return undefined;
    if (key === "name") return l("name_missing").replace("{locales}", code.split(",").join(", "));
    return labels[code] ?? l("invalid");
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = v.kind === "fixed" ? Math.round(Number(v.value.replace(",", ".")) * 100) : Number.parseInt(v.value, 10);
    const body = {
      code: v.code.trim() || null,
      name: v.name,
      kind: v.kind,
      value: Number.isFinite(value) ? value : 0,
      appliesTo: { productIds: v.productIds, productKinds: v.productKinds },
      eligibility: {
        ...(v.segmentId.trim() ? { segmentId: v.segmentId.trim() } : {}),
        ...(v.statuses.length ? { statuses: v.statuses } : {}),
        ...(v.channels.length ? { channels: v.channels } : {}),
        ...(v.firstOrderOnly ? { firstOrderOnly: true } : {}),
      },
      startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : "",
      endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null,
      maxUses: optInt(v.maxUses),
      maxUsesPerPerson: optInt(v.maxUsesPerPerson),
      isActive: v.isActive,
      ...(options.partners ? { partnerCompanyId: v.partnerCompanyId?.trim() || null } : {}),
    };
    setPending(true);
    setError(null);
    setFields({});
    setSaved(false);
    try {
      const result = initial.id ? await updatePromotion({ ...body, promotionId: initial.id }) : await createPromotion(body);
      if (result.ok) {
        if (initial.id) {
          setSaved(true);
          router.refresh();
        } else router.push(`/admin/products/promotions/${result.data.promotionId}` as never);
        return;
      }
      const e = result.error;
      if (e.code === "conflict" && e.message.startsWith("promotion_locked")) setError(l("locked_error"));
      else if (e.fields && Object.keys(e.fields).length) setFields(e.fields);
      else setError(l("error"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-3xl gap-6" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          {l("saved")}
        </p>
      ) : null}

      <Section title={l("section_offer")}>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={l("field_code")} hint={locked ? lockedHint : l("field_code_hint")} error={fieldError("code")}>
            <Input value={v.code} onChange={(e) => set("code", e.target.value.toUpperCase())} maxLength={24} autoComplete="off" disabled={locked} title={locked ? lockedHint : undefined} />
          </FormField>
          <FormField label={l("field_kind")} required hint={locked ? lockedHint : undefined}>
            <select
              value={v.kind}
              onChange={(e) => set("kind", e.target.value as "percent" | "fixed")}
              disabled={locked}
              title={locked ? lockedHint : undefined}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm disabled:opacity-60"
            >
              {options.kinds.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={v.kind === "fixed" ? l("field_value_fixed") : l("field_value_percent")} required error={fieldError("value")} hint={locked ? lockedHint : undefined}>
            <Input inputMode="decimal" value={v.value} onChange={(e) => set("value", e.target.value)} disabled={locked} title={locked ? lockedHint : undefined} />
          </FormField>
        </div>
        {options.partners ? (
          <FormField label={l("field_partner")} hint={locked ? lockedHint : l("field_partner_hint")} error={fieldError("partnerCompanyId")}>
            <select
              value={v.partnerCompanyId ?? ""}
              onChange={(e) => set("partnerCompanyId", e.target.value)}
              disabled={locked}
              title={locked ? lockedHint : undefined}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm disabled:opacity-60"
            >
              <option value="">{l("field_partner_none")}</option>
              {options.partners.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
        <LocalizedInput
          name="name"
          value={v.name}
          onChange={(x) => set("name", x)}
          locales={LOCALES}
          labels={{ field: l("field_name"), locales: options.localeNames, missing: l("missing"), complete: l("complete") }}
          error={fieldError("name")}
        />
      </Section>

      <Section title={l("section_applies")}>
        <p className="text-sm text-muted-foreground">{l("field_applies_hint")}</p>
        <CheckboxGroup legend={l("field_kinds")} options={options.productKinds} value={v.productKinds} onChange={(x) => set("productKinds", x)} disabled={locked} hint={lockedHint} />
        <CheckboxGroup legend={l("field_products")} options={options.products} value={v.productIds} onChange={(x) => set("productIds", x)} disabled={locked} hint={lockedHint} />
      </Section>

      <Section title={l("section_eligibility")}>
        <p className="text-sm text-muted-foreground">{l("field_eligibility_hint")}</p>
        <CheckboxGroup legend={l("field_statuses")} options={options.statuses} value={v.statuses} onChange={(x) => set("statuses", x)} disabled={locked} hint={lockedHint} />
        <CheckboxGroup legend={l("field_channels")} options={options.channels} value={v.channels} onChange={(x) => set("channels", x)} disabled={locked} hint={lockedHint} />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={l("field_segment")} error={fieldError("eligibility.segmentId")}>
            <Input value={v.segmentId} onChange={(e) => set("segmentId", e.target.value)} disabled={locked} autoComplete="off" />
          </FormField>
          <label className="flex items-center gap-2 self-end text-sm">
            <Checkbox checked={v.firstOrderOnly} disabled={locked} onCheckedChange={(c) => set("firstOrderOnly", c === true)} />
            {l("field_first_order")}
          </label>
        </div>
      </Section>

      <Section title={l("section_schedule")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={l("field_starts")} required error={fieldError("startsAt")} hint={locked ? lockedHint : undefined}>
            <Input type="datetime-local" value={v.startsAt} onChange={(e) => set("startsAt", e.target.value)} disabled={locked} />
          </FormField>
          <FormField label={l("field_ends")} error={fieldError("endsAt")}>
            <Input type="datetime-local" value={v.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
          </FormField>
          <FormField label={l("field_max_uses")} error={fieldError("maxUses")}>
            <Input type="number" min={Math.max(1, usesCount)} value={v.maxUses} onChange={(e) => set("maxUses", e.target.value)} />
          </FormField>
          <FormField label={l("field_max_per_person")} error={fieldError("maxUsesPerPerson")}>
            <Input type="number" min={1} value={v.maxUsesPerPerson} onChange={(e) => set("maxUsesPerPerson", e.target.value)} />
          </FormField>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={v.isActive} onCheckedChange={(c) => set("isActive", c === true)} />
          {l("field_active")}
        </label>
      </Section>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? l("saving") : l("save")}
        </Button>
      </div>
    </form>
  );
}
