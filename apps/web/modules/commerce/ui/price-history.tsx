"use client";
/**
 * Price history per audience with the "add price version" dialog (commerce spec 5.1, rule 4), and
 * the customer-specific prices panel of `/admin/products/[id]/person-prices` (rule 6). Prices are
 * append-only: a change is a new version, ending a time-limited price early is a new version with
 * the base amount valid from now. Rows arrive formatted by the server page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FormField,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@beam/ui";
import { addPriceVersion, findPricePersons, revokePersonPrice, setPersonPrice } from "../actions";

export type Labels = Record<string, string>;
type Audience = "public" | "member" | "b2b";

export type PriceHistoryRowView = { id: string; version: number; amount: string; window: string; reason: string | null; by: string; isCurrent: boolean };

const toCents = (v: string): number | null => {
  const n = Number(v.replace(",", "."));
  return v.trim() === "" || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 100);
};
const toIso = (v: string): string | undefined => (v ? new Date(v).toISOString() : undefined);

export function PriceHistory({
  productId,
  history,
  audiences,
  canEdit,
  labels,
}: {
  productId: string;
  history: Record<Audience, PriceHistoryRowView[]>;
  audiences: { value: Audience; label: string }[];
  canEdit: boolean;
  labels: Labels;
}) {
  const l = (k: string) => labels[k] ?? k;
  const [open, setOpen] = useState(false);
  const total = audiences.reduce((n, a) => n + history[a.value].length, 0);

  return (
    <section className="grid gap-3" aria-labelledby="price-history-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="price-history-title" className="text-lg font-semibold">
          {l("title")}
        </h2>
        {canEdit ? (
          <Button type="button" onClick={() => setOpen(true)}>
            {l("add")}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{l("hint_append_only")}</p>
      {total === 0 ? (
        <EmptyState title={l("empty")} />
      ) : (
        <Tabs defaultValue="public">
          <TabsList>
            {audiences.map((a) => (
              <TabsTrigger key={a.value} value={a.value}>
                {a.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {audiences.map((a) => (
            <TabsContent key={a.value} value={a.value}>
              {history[a.value].length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">{l("audience_empty")}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{l("col_version")}</TableHead>
                      <TableHead className="text-right">{l("col_amount")}</TableHead>
                      <TableHead>{l("col_window")}</TableHead>
                      <TableHead>{l("col_reason")}</TableHead>
                      <TableHead>{l("col_by")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history[a.value].map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="tabular-nums">
                          v{r.version} {r.isCurrent ? <Badge variant="secondary">{l("current")}</Badge> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.amount}</TableCell>
                        <TableCell>{r.window}</TableCell>
                        <TableCell>{r.reason ?? "—"}</TableCell>
                        <TableCell>{r.by}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
          ))}
        </Tabs>
      )}
      {canEdit ? <AddPriceVersionDialog productId={productId} open={open} onOpenChange={setOpen} audiences={audiences} labels={labels} /> : null}
    </section>
  );
}

function AddPriceVersionDialog({
  productId,
  open,
  onOpenChange,
  audiences,
  labels,
}: {
  productId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audiences: { value: Audience; label: string }[];
  labels: Labels;
}) {
  const router = useRouter();
  const l = (k: string) => labels[k] ?? k;
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const get = (k: string) => { const v = form.get(k); return typeof v === "string" ? v.trim() : ""; };
    const amountCents = toCents(get("amount"));
    if (amountCents === null) {
      setErrors({ amountCents: l("invalid") });
      return;
    }
    setPending(true);
    setErrors({});
    try {
      const result = await addPriceVersion({
        productId,
        audience: get("audience"),
        amountCents,
        validFromAt: toIso(get("validFrom")),
        validToAt: toIso(get("validTo")),
        reason: get("reason") || undefined,
      });
      if (result.ok) {
        onOpenChange(false);
        router.refresh();
        return;
      }
      const f = result.error.fields ?? {};
      setErrors(f.validToAt ? { validToAt: l("window_error") } : Object.keys(f).length ? Object.fromEntries(Object.keys(f).map((k) => [k, l("invalid")])) : { _: l("error") });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{l("add")}</DialogTitle>
          <DialogDescription>{l("hint_append_only")}</DialogDescription>
        </DialogHeader>
        <form id="add-price-version" onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
          {errors._ ? (
            <p role="alert" className="text-sm text-destructive">
              {errors._}
            </p>
          ) : null}
          <FormField label={l("field_audience")} required>
            <select name="audience" defaultValue="public" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm">
              {audiences.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={l("field_amount")} required error={errors.amountCents}>
            <Input name="amount" inputMode="decimal" autoComplete="off" />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={l("field_valid_from")} error={errors.validFromAt}>
              <Input name="validFrom" type="datetime-local" />
            </FormField>
            <FormField label={l("field_valid_until")} error={errors.validToAt}>
              <Input name="validTo" type="datetime-local" />
            </FormField>
          </div>
          <FormField label={l("field_reason")}>
            <Input name="reason" maxLength={200} />
          </FormField>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {l("cancel")}
          </Button>
          <Button type="submit" form="add-price-version" disabled={pending}>
            {pending ? l("saving") : l("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Customer-specific prices
// ---------------------------------------------------------------------------

export type PersonPriceRowView = { id: string; person: string; amount: string; window: string; reason: string; isRevoked: boolean };
type Candidate = { id: string; name: string; email: string | null; customerNumber: string };

export function PersonPricePanel({ productId, rows, canEdit, labels }: { productId: string; rows: PersonPriceRowView[]; canEdit: boolean; labels: Labels }) {
  const router = useRouter();
  const l = (k: string) => labels[k] ?? k;
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function search() {
    if (q.trim().length < 2) return;
    const result = await findPricePersons({ q: q.trim() });
    setCandidates(result.ok ? result.data : []);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const get = (k: string) => { const v = form.get(k); return typeof v === "string" ? v.trim() : ""; };
    const next: Record<string, string> = {};
    if (!picked) next.person = l("person_pick_first");
    const amountCents = toCents(get("amount"));
    if (amountCents === null) next.amountCents = l("invalid");
    if (get("reason").length < 3) next.reason = l("required");
    setErrors(next);
    if (Object.keys(next).length || !picked || amountCents === null) return;
    setPending(true);
    try {
      const result = await setPersonPrice({
        personId: picked.id,
        productId,
        amountCents,
        validFromAt: toIso(get("validFrom")),
        validToAt: toIso(get("validTo")),
        reason: get("reason"),
      });
      if (result.ok) {
        setPicked(null);
        setCandidates(null);
        setQ("");
        formEl.reset();
        router.refresh();
        return;
      }
      const f = result.error.fields ?? {};
      setErrors(f.validToAt ? { validToAt: l("window_error") } : { _: l("error") });
    } finally {
      setPending(false);
    }
  }

  async function revoke(personPriceId: string) {
    const result = await revokePersonPrice({ personPriceId });
    if (result.ok) router.refresh();
    else setErrors({ _: l("error") });
  }

  return (
    <div className="grid gap-6">
      {errors._ ? (
        <p role="alert" className="text-sm text-destructive">
          {errors._}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={l("person_empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{l("person_col_person")}</TableHead>
              <TableHead className="text-right">{l("person_col_amount")}</TableHead>
              <TableHead>{l("person_col_window")}</TableHead>
              <TableHead>{l("person_col_reason")}</TableHead>
              <TableHead>{l("person_col_status")}</TableHead>
              {canEdit ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.person}</TableCell>
                <TableCell className="text-right tabular-nums">{r.amount}</TableCell>
                <TableCell>{r.window}</TableCell>
                <TableCell>{r.reason}</TableCell>
                <TableCell>
                  <Badge variant={r.isRevoked ? "outline" : "secondary"}>{r.isRevoked ? l("person_revoked") : l("person_active")}</Badge>
                </TableCell>
                {canEdit ? (
                  <TableCell className="text-right">
                    {r.isRevoked ? null : (
                      <Button type="button" size="sm" variant="outline" onClick={() => void revoke(r.id)}>
                        {l("person_revoke")}
                      </Button>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {canEdit ? (
        <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-2xl gap-4 rounded-lg border p-4" noValidate>
          <h2 className="text-base font-semibold">{l("person_add")}</h2>
          <div className="flex items-end gap-2">
            <FormField label={l("person_search")} hint={l("person_search_hint")} error={errors.person} className="flex-1">
              <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? (e.preventDefault(), void search()) : undefined)} />
            </FormField>
            <Button type="button" variant="outline" onClick={() => void search()}>
              {l("person_search")}
            </Button>
          </div>
          {candidates && !picked ? (
            candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{l("person_no_match")}</p>
            ) : (
              <ul className="grid gap-1" aria-label={l("person_search")}>
                {candidates.map((c) => (
                  <li key={c.id}>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(c)}>
                      {c.name} · {c.customerNumber}
                      {c.email ? ` · ${c.email}` : ""}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {picked ? (
            <p role="status" className="text-sm">
              {l("person_selected").replace("{name}", picked.name)}
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={l("field_amount")} required error={errors.amountCents}>
              <Input name="amount" inputMode="decimal" autoComplete="off" />
            </FormField>
            <FormField label={l("field_valid_from")}>
              <Input name="validFrom" type="datetime-local" />
            </FormField>
            <FormField label={l("field_valid_until")} error={errors.validToAt}>
              <Input name="validTo" type="datetime-local" />
            </FormField>
          </div>
          <FormField label={l("person_field_reason")} required error={errors.reason}>
            <Input name="reason" maxLength={500} />
          </FormField>
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? l("saving") : l("save")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
