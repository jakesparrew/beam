"use client";
/**
 * The product form of `/admin/products/new` and `/admin/products/[id]` (commerce spec 5.1): fields
 * by kind (credits only for packages, interval for memberships, category for items, amount range
 * for custom vouchers), `LocalizedInput` with completeness badges, and the activate/deactivate
 * button that names the missing locales or the missing price (rule 1).
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode, type SelectHTMLAttributes } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, LocalizedInput } from "@beam/ui";
import { createProduct, setProductActive, updateProduct } from "../actions";

type Locale = "nl-BE" | "fr-BE" | "en";
type Localized = Partial<Record<Locale, string>>;
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];

export type ProductKind = "session" | "night" | "package" | "membership" | "ticket" | "item" | "voucher";
export type Option = { value: string; label: string };

export type ProductFormValues = {
  id?: string;
  kind: ProductKind;
  sku: string;
  name: Localized;
  description: Localized;
  vatRatePct: string;
  creditKind: string;
  creditUnits: string;
  validityDays: string;
  isSharingAllowed: boolean;
  maxGuestUsesPerMonth: string;
  memberDiscountPct: string;
  recurringInterval: string;
  includedCreditKind: string;
  includedCreditUnits: string;
  itemCategory: string;
  isCustomAmount: boolean;
  minAmount: string;
  maxAmount: string;
  isShopVisible: boolean;
  isPosVisible: boolean;
  sortOrder: string;
};

/** Labels from `commerce.admin_products.*` and `commerce.common.*`, keyed without prefix. */
export type Labels = Record<string, string>;

export type ProductFormOptions = {
  kinds: Option[];
  vatRates: Option[];
  creditKinds: Option[];
  intervals: Option[];
  includedKinds: Option[];
  itemCategories: Option[];
  localeNames: Record<Locale, string>;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

export function Select({
  value,
  onChange,
  options,
  none,
  ...rest
}: { value: string; onChange: (v: string) => void; options: Option[]; none?: string } & Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <select {...rest} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
      {none !== undefined ? <option value="">{none}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const int = (v: string): number | null => (v.trim() === "" ? null : Number.parseInt(v, 10));
const num = (v: string): number | null => (v.trim() === "" ? null : Number(v.replace(",", ".")));
const cents = (v: string): number | null => (v.trim() === "" ? null : Math.round(Number(v.replace(",", ".")) * 100));

export function ProductForm({ initial, options, labels }: { initial: ProductFormValues; options: ProductFormOptions; labels: Labels }) {
  const router = useRouter();
  const [v, setV] = useState<ProductFormValues>(initial);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const l = (k: string) => labels[k] ?? k;
  const set = <K extends keyof ProductFormValues>(k: K, value: ProductFormValues[K]) => setV((s) => ({ ...s, [k]: value }));
  const fieldError = (key: string): string | undefined => {
    const code = fields[key];
    if (!code) return undefined;
    if (/^(nl-BE|fr-BE|en)(,(nl-BE|fr-BE|en))*$/.test(code)) return l("missing_before_activation").replace("{locales}", code.split(",").join(", "));
    return labels[code] ?? l("invalid");
  };
  const isNew = !initial.id;
  const k = v.kind;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = {
      sku: v.sku.trim(),
      name: v.name,
      description: v.description,
      vatRatePct: Number(v.vatRatePct),
      creditKind: k === "package" ? v.creditKind || null : null,
      creditUnits: k === "package" ? int(v.creditUnits) : null,
      validityDays: k === "package" || k === "voucher" ? int(v.validityDays) : null,
      isSharingAllowed: k === "package" ? v.isSharingAllowed : false,
      maxGuestUsesPerMonth: int(v.maxGuestUsesPerMonth) ?? 2,
      memberDiscountPct: k === "voucher" ? null : num(v.memberDiscountPct),
      recurringInterval: k === "membership" ? v.recurringInterval || null : null,
      includedCreditKind: k === "membership" ? v.includedCreditKind || null : null,
      includedCreditUnits: k === "membership" ? int(v.includedCreditUnits) : null,
      itemCategory: k === "item" ? v.itemCategory || null : null,
      isCustomAmount: k === "voucher" ? v.isCustomAmount : false,
      minAmountCents: k === "voucher" && v.isCustomAmount ? cents(v.minAmount) : null,
      maxAmountCents: k === "voucher" && v.isCustomAmount ? cents(v.maxAmount) : null,
      isShopVisible: v.isShopVisible,
      isPosVisible: v.isPosVisible,
      sortOrder: int(v.sortOrder) ?? 0,
    };
    setPending(true);
    setError(null);
    setFields({});
    setSaved(false);
    try {
      const result = isNew ? await createProduct({ ...body, kind: k }) : await updateProduct({ ...body, productId: initial.id });
      if (result.ok) {
        if (isNew) router.push(`/admin/products/${result.data.productId}` as never);
        else {
          setSaved(true);
          router.refresh();
        }
        return;
      }
      const f = result.error.fields ?? {};
      setFields(f);
      if (result.error.message === "missing_translation") setError(l("activate_missing").replace("{locales}", Object.values(f).join(", ")));
      else if (Object.keys(f).length === 0) setError(l("error"));
    } finally {
      setPending(false);
    }
  }

  const localizedLabels = (field: string) => ({ field, locales: options.localeNames, missing: l("missing"), complete: l("complete") });

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

      <Section title={l("section_basics")}>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={l("field_kind")} required>
            <Select value={k} onChange={(x) => set("kind", x as ProductKind)} options={options.kinds} disabled={!isNew} />
          </FormField>
          <FormField label={l("field_sku")} required hint={l("field_sku_hint")} error={fieldError("sku")}>
            <Input value={v.sku} onChange={(e) => set("sku", e.target.value.toUpperCase())} maxLength={32} autoComplete="off" />
          </FormField>
          <FormField label={l("field_vat")} required error={fieldError("vatRatePct")}>
            <Select value={v.vatRatePct} onChange={(x) => set("vatRatePct", x)} options={options.vatRates} />
          </FormField>
        </div>
        <LocalizedInput name="name" value={v.name} onChange={(x) => set("name", x)} locales={LOCALES} labels={localizedLabels(l("field_name"))} error={fieldError("name")} />
        <LocalizedInput
          name="description"
          value={v.description}
          onChange={(x) => set("description", x)}
          locales={LOCALES}
          multiline
          labels={localizedLabels(l("field_description"))}
          error={fieldError("description")}
        />
      </Section>

      {k === "package" || k === "voucher" ? (
        <Section title={l("section_credits")}>
          <div className="grid gap-4 sm:grid-cols-3">
            {k === "package" ? (
              <>
                <FormField label={l("field_credit_kind")} required error={fieldError("creditKind")}>
                  <Select value={v.creditKind} onChange={(x) => set("creditKind", x)} options={options.creditKinds} none="—" />
                </FormField>
                <FormField label={l("field_credit_units")} required error={fieldError("creditUnits")}>
                  <Input type="number" min={1} value={v.creditUnits} onChange={(e) => set("creditUnits", e.target.value)} />
                </FormField>
              </>
            ) : null}
            <FormField label={l("field_validity_days")} required error={fieldError("validityDays")}>
              <Input type="number" min={1} value={v.validityDays} onChange={(e) => set("validityDays", e.target.value)} />
            </FormField>
          </div>
          {k === "package" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={v.isSharingAllowed} onCheckedChange={(c) => set("isSharingAllowed", c === true)} />
                {l("field_sharing")}
              </label>
              <FormField label={l("field_max_guest_uses")} error={fieldError("maxGuestUsesPerMonth")}>
                <Input type="number" min={0} max={31} value={v.maxGuestUsesPerMonth} onChange={(e) => set("maxGuestUsesPerMonth", e.target.value)} />
              </FormField>
            </div>
          ) : null}
        </Section>
      ) : null}

      {k === "voucher" ? (
        <Section title={l("section_voucher")}>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={v.isCustomAmount} onCheckedChange={(c) => set("isCustomAmount", c === true)} />
            {l("field_custom_amount")}
          </label>
          {v.isCustomAmount ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={l("field_min_amount")} required error={fieldError("minAmountCents")}>
                <Input inputMode="decimal" value={v.minAmount} onChange={(e) => set("minAmount", e.target.value)} />
              </FormField>
              <FormField label={l("field_max_amount")} required error={fieldError("maxAmountCents")}>
                <Input inputMode="decimal" value={v.maxAmount} onChange={(e) => set("maxAmount", e.target.value)} />
              </FormField>
            </div>
          ) : null}
        </Section>
      ) : null}

      {k === "membership" ? (
        <Section title={l("section_membership")}>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={l("field_interval")} required error={fieldError("recurringInterval")}>
              <Select value={v.recurringInterval} onChange={(x) => set("recurringInterval", x)} options={options.intervals} none="—" />
            </FormField>
            <FormField label={l("field_included_kind")} error={fieldError("includedCreditKind")}>
              <Select value={v.includedCreditKind} onChange={(x) => set("includedCreditKind", x)} options={options.includedKinds} none={l("none")} />
            </FormField>
            <FormField label={l("field_included_units")} error={fieldError("includedCreditUnits")}>
              <Input type="number" min={1} value={v.includedCreditUnits} onChange={(e) => set("includedCreditUnits", e.target.value)} />
            </FormField>
          </div>
        </Section>
      ) : null}

      <Section title={l("section_visibility")}>
        <div className="grid gap-4 sm:grid-cols-3">
          {k === "item" ? (
            <FormField label={l("field_item_category")} required error={fieldError("itemCategory")}>
              <Select value={v.itemCategory} onChange={(x) => set("itemCategory", x)} options={options.itemCategories} none="—" />
            </FormField>
          ) : null}
          {k !== "voucher" ? (
            <FormField label={l("field_member_discount")} error={fieldError("memberDiscountPct")}>
              <Input inputMode="decimal" value={v.memberDiscountPct} onChange={(e) => set("memberDiscountPct", e.target.value)} />
            </FormField>
          ) : null}
          <FormField label={l("field_sort_order")} error={fieldError("sortOrder")}>
            <Input type="number" min={0} value={v.sortOrder} onChange={(e) => set("sortOrder", e.target.value)} />
          </FormField>
        </div>
        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={v.isShopVisible} onCheckedChange={(c) => set("isShopVisible", c === true)} />
            {l("field_shop_visible")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={v.isPosVisible} onCheckedChange={(c) => set("isPosVisible", c === true)} />
            {l("field_pos_visible")}
          </label>
        </div>
      </Section>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? l("saving") : l("save")}
        </Button>
      </div>
    </form>
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

/** Activate or deactivate a product; activation errors name the missing locales or the price (rule 1). */
export function ProductActiveToggle({ productId, isActive, labels }: { productId: string; isActive: boolean; labels: Labels }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const l = (k: string) => labels[k] ?? k;

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      const result = await setProductActive({ productId, isActive: !isActive });
      if (result.ok) {
        router.refresh();
        return;
      }
      const f = result.error.fields ?? {};
      if (result.error.message === "missing_translation") setError(l("activate_missing").replace("{locales}", Object.values(f).join(", ")));
      else if (result.error.message === "no_price") setError(l("activate_no_price"));
      else setError(l("error"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid justify-items-start gap-1">
      <Button type="button" size="sm" variant={isActive ? "outline" : "default"} onClick={() => void toggle()} disabled={pending}>
        {isActive ? l("deactivate") : l("activate")}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
