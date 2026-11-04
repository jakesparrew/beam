"use client";
/**
 * The benefits list of a membership plan (`/admin/memberships/plans`, `setPlanBenefit`,
 * `removePlanBenefit`): kind, text in the three locales (all required), order and active. Each
 * row edits in place; a new benefit is added with the same form.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Badge, Button, FormField, Input, LocalizedInput } from "@beam/ui";
import { removePlanBenefit, setPlanBenefit } from "../actions";
import { errorMessage, type Labels, str } from "./adjust-dialog";

type Locale = "nl-BE" | "fr-BE" | "en";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];
const KINDS = ["included_units", "discount", "member_only_access", "event_access", "event_discount", "other"] as const;
type BenefitKind = (typeof KINDS)[number];
const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export type BenefitRow = { id: string; kind: BenefitKind; text: Partial<Record<Locale, string>>; sortOrder: number; isActive: boolean };

function BenefitForm({ productId, benefit, locale, labels: l, onDone }: { productId: string; benefit?: BenefitRow; locale: Locale; labels: Labels; onDone: () => void }) {
  const router = useRouter();
  const [text, setText] = useState<Partial<Record<Locale, string>>>(benefit?.text ?? {});
  const [state, setState] = useState<{ error?: string; fields?: Record<string, string> }>({});
  const [busy, setBusy] = useState(false);
  const p = (k: string) => l[`admin.plans.${k}`] ?? k;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setState({});
    try {
      const r = await setPlanBenefit({
        productId,
        ...(benefit ? { benefitId: benefit.id } : {}),
        kind: str(f, "kind", "other"),
        text,
        sortOrder: Number(f.get("sortOrder") ?? 0),
        isActive: f.get("isActive") === "on",
      });
      if (r.ok) {
        onDone();
        router.refresh();
      } else setState({ error: errorMessage(r.error, l), fields: r.error.fields });
    } catch {
      setState({ error: l["errors.generic"] });
    } finally {
      setBusy(false);
    }
  }

  const textError = state.fields?.text ?? Object.entries(state.fields ?? {}).find(([k]) => k.startsWith("text."))?.[1] ?? null;
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-3 rounded-md border p-3" lang={locale}>
      {state.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <FormField label={p("benefit_kind")} error={state.fields?.kind ?? null}>
          <select name="kind" defaultValue={benefit?.kind ?? "other"} className={selectClass}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {l[`enum.benefit_kind.${k}`]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={p("sort_order")} error={state.fields?.sortOrder ?? null}>
          <Input name="sortOrder" type="number" min={0} max={99} step={1} defaultValue={benefit?.sortOrder ?? 0} className="w-24" inputMode="numeric" />
        </FormField>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="isActive" defaultChecked={benefit?.isActive ?? true} />
          {p("active")}
        </label>
      </div>
      <LocalizedInput
        name="text"
        value={text}
        onChange={(x) => setText(x)}
        locales={LOCALES}
        labels={{
          field: p("benefit_text"),
          locales: { "nl-BE": l["admin.common.locale_nl"]!, "fr-BE": l["admin.common.locale_fr"]!, en: l["admin.common.locale_en"]! },
          missing: l["admin.common.missing"]!,
          complete: l["admin.common.complete"]!,
        }}
        error={textError}
      />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? l["admin.common.saving"] : p("save_benefit")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {l["admin.common.cancel"]}
        </Button>
      </div>
    </form>
  );
}

export function PlanBenefits({ productId, benefits, locale, labels: l }: { productId: string; benefits: BenefitRow[]; locale: Locale; labels: Labels }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const p = (k: string) => l[`admin.plans.${k}`] ?? k;

  async function remove(id: string) {
    setError(null);
    const r = await removePlanBenefit({ benefitId: id });
    if (r.ok) router.refresh();
    else setError(errorMessage(r.error, l));
  }

  return (
    <div className="grid gap-2">
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {benefits.length === 0 ? <p className="text-sm text-muted-foreground">{p("benefits_empty")}</p> : null}
      <ul className="grid gap-2">
        {benefits.map((b) =>
          editing === b.id ? (
            <li key={b.id}>
              <BenefitForm productId={productId} benefit={b} locale={locale} labels={l} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={b.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">{l[`enum.benefit_kind.${b.kind}`]}</Badge>
              <span className={b.isActive ? "" : "text-muted-foreground line-through"}>{b.text[locale] ?? b.text.en}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(b.id)}>
                {p("edit_benefit")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void remove(b.id)}>
                {p("remove_benefit")}
              </Button>
            </li>
          ),
        )}
      </ul>
      {editing === "new" ? (
        <BenefitForm productId={productId} locale={locale} labels={l} onDone={() => setEditing(null)} />
      ) : (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing("new")}>
            {p("add_benefit")}
          </Button>
        </div>
      )}
    </div>
  );
}
