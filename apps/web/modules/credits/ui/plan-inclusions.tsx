"use client";
/**
 * Extra inclusions of a membership plan (`/admin/memberships/plans`, `setPlanInclusion`): one row
 * per credit kind other than the product's primary inclusion, with units per period and active.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input } from "@beam/ui";
import { setPlanInclusion } from "../actions";
import { errorMessage, type Labels } from "./adjust-dialog";

export type InclusionRow = { kind: "day" | "night"; unitsPerPeriod: number; isActive: boolean };

function InclusionForm({ productId, kind, current, labels: l }: { productId: string; kind: "day" | "night"; current?: InclusionRow; labels: Labels }) {
  const router = useRouter();
  const [state, setState] = useState<{ error?: string; fields?: Record<string, string>; saved?: boolean }>({});
  const [busy, setBusy] = useState(false);
  const p = (k: string) => l[`admin.plans.${k}`] ?? k;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setState({});
    try {
      const r = await setPlanInclusion({ productId, kind, unitsPerPeriod: Number(f.get("unitsPerPeriod")), isActive: f.get("isActive") === "on" });
      if (r.ok) {
        setState({ saved: true });
        router.refresh();
      } else setState({ error: errorMessage(r.error, l), fields: r.error.fields });
    } catch {
      setState({ error: l["errors.generic"] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3" aria-label={`${p("extra")}: ${l[`enum.kind.${kind}`]}`}>
      <span className="min-w-16 pb-2 text-sm font-medium">{l[`enum.kind.${kind}`]}</span>
      <FormField label={p("units_per_period")} error={state.fields?.unitsPerPeriod ?? null}>
        <Input name="unitsPerPeriod" type="number" min={1} max={62} step={1} defaultValue={current?.unitsPerPeriod ?? 1} className="w-28" inputMode="numeric" />
      </FormField>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" name="isActive" defaultChecked={current?.isActive ?? true} />
        {p("active")}
      </label>
      <Button type="submit" variant="outline" disabled={busy}>
        {busy ? l["admin.common.saving"] : p("save_inclusion")}
      </Button>
      {state.saved ? (
        <span role="status" className="pb-2 text-sm text-muted-foreground">
          {l["admin.common.saved"]}
        </span>
      ) : null}
      {state.error ? (
        <Alert variant="destructive" role="alert" className="w-full">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

/** One form per kind that is not the plan's primary inclusion. */
export function PlanInclusions({ productId, primaryKind, inclusions, labels: l }: { productId: string; primaryKind: string | null; inclusions: InclusionRow[]; labels: Labels }) {
  const kinds = (["day", "night"] as const).filter((k) => k !== primaryKind);
  return (
    <div className="grid gap-3">
      {kinds.map((k) => (
        <InclusionForm key={k} productId={productId} kind={k} current={inclusions.find((i) => i.kind === k)} labels={l} />
      ))}
    </div>
  );
}
