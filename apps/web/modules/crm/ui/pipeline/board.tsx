"use client";
/**
 * The pipeline board (crm spec 5.1, `/admin/pipeline`): one column per open stage plus account
 * management and renewal, with value and weighted value totals. Drag a card onto another
 * column or onto the Won / Lost zones to move it; a drop on Lost (or any refused move) opens
 * the stage dialog, which asks for the reason. Every card also has a "Move" button for
 * keyboard users. `OpportunityForm` creates and edits an opportunity (board and detail page).
 */
import { useRouter } from "next/navigation";
import { useState, type DragEvent as ReactDragEvent, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Textarea } from "@beam/ui";
import { saveOpportunity } from "../../pipeline/actions";
import { OpportunityCard, type CardLabels, type CardView } from "./card";
import { StageDialog, type StageDialogLabels, type StageTarget } from "./stage-dialog";

export type ColumnView = { stage: string; name: string; total: string; weighted: string; cards: CardView[] };

export type BoardLabels = {
  card: CardLabels;
  dialog: StageDialogLabels;
  total: string;
  weighted: string;
  empty: string;
  dropWon: string;
  dropLost: string;
};

export function PipelineBoard({ columns, labels }: { columns: ColumnView[]; labels: BoardLabels }) {
  const [dragging, setDragging] = useState<CardView | null>(null);
  const [dialog, setDialog] = useState<{ card: CardView; stage?: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const target: StageTarget | null = dialog ? { id: dialog.card.id, version: dialog.card.version, stage: dialog.card.stage, title: dialog.card.title } : null;

  function drop(stage: string) {
    const card = dragging;
    setDragging(null);
    setOver(null);
    if (!card || card.stage === stage) return;
    setDialog({ card, stage: card.allowed.includes(stage) ? stage : undefined });
  }

  const zone = (stage: string) => ({
    onDragOver: (e: ReactDragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      setOver(stage);
    },
    onDragLeave: () => setOver((s) => (s === stage ? null : s)),
    onDrop: (e: ReactDragEvent) => {
      e.preventDefault();
      drop(stage);
    },
  });

  return (
    <div className="grid gap-4">
      <div className="flex gap-3 overflow-x-auto pb-2" role="list">
        {columns.map((col) => (
          <section
            key={col.stage}
            role="listitem"
            aria-label={col.name}
            {...zone(col.stage)}
            className={`flex w-72 shrink-0 flex-col gap-2 rounded-lg border bg-muted/40 p-2 ${over === col.stage ? "ring-2 ring-ring" : ""}`}
          >
            <header className="grid gap-0.5 px-1">
              <h2 className="text-sm font-semibold">
                {col.name} <span className="text-muted-foreground">({col.cards.length})</span>
              </h2>
              <p className="text-xs text-muted-foreground tabular-nums">
                {labels.total}: {col.total} · {labels.weighted}: {col.weighted}
              </p>
            </header>
            {col.cards.length === 0 ? <p className="px-1 py-4 text-center text-xs text-muted-foreground">{labels.empty}</p> : null}
            {col.cards.map((card) => (
              <OpportunityCard key={card.id} card={card} labels={labels.card} onDragStart={setDragging} onMove={(c) => setDialog({ card: c })} />
            ))}
          </section>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["won", "lost"] as const).map((stage) => (
          <div
            key={stage}
            {...zone(stage)}
            className={`rounded-lg border-2 border-dashed p-4 text-center text-sm text-muted-foreground ${over === stage ? "border-ring" : ""}`}
          >
            {stage === "won" ? labels.dropWon : labels.dropLost}
          </div>
        ))}
      </div>
      <StageDialog key={dialog ? `${dialog.card.id}:${dialog.stage ?? ""}` : "closed"} target={target} initialStage={dialog?.stage} allowed={dialog?.card.allowed ?? []} labels={labels.dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opportunity form
// ---------------------------------------------------------------------------

export type OpportunityFormLabels = {
  titleNew: string;
  titleEdit: string;
  company: string;
  title: string;
  contact: string;
  noContact: string;
  value: string;
  probability: string;
  probabilityHint: string;
  expectedClose: string;
  owner: string;
  nextAction: string;
  nextActionAt: string;
  source: string;
  notes: string;
  save: string;
  saving: string;
  cancel: string;
  error: string;
  stale: string;
  forbidden: string;
};

export type OpportunityFormValues = {
  id?: string;
  version?: number;
  companyId: string;
  title: string;
  primaryContactPersonId: string;
  /** Euros as typed, for example `1250` or `1250,50`. */
  value: string;
  probabilityPct: string;
  expectedCloseOn: string;
  ownerUserId: string;
  nextAction: string;
  /** `YYYY-MM-DD`. */
  nextActionOn: string;
  source: string;
  notes: string;
};

type Option = { value: string; label: string };

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** `1.250,50` / `1250.5` / `1250` (euros) to integer cents; `null` when it is not an amount. */
export function eurosToCents(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "").replace(/€/g, "");
  if (!s) return 0;
  const normalised = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  return Math.round(Number(normalised) * 100);
}

export function OpportunityForm({
  initial,
  companies,
  contacts,
  owners,
  labels,
  onDone,
}: {
  initial: OpportunityFormValues;
  companies: Option[];
  /** Current company contacts, filtered by the chosen company. */
  contacts: (Option & { companyId: string })[];
  owners: Option[];
  labels: OpportunityFormLabels;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [companyId, setCompanyId] = useState(initial.companyId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const get = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    const valueCents = eurosToCents(get("value"));
    if (valueCents === null) {
      setError(labels.error);
      return;
    }
    const probability = get("probabilityPct");
    const nextActionOn = get("nextActionOn");
    const body = {
      ...(initial.id ? { id: initial.id, version: initial.version } : {}),
      companyId,
      title: get("title"),
      primaryContactPersonId: get("primaryContactPersonId") || null,
      valueCents,
      ...(probability !== "" ? { probabilityPct: Math.max(0, Math.min(100, Math.round(Number(probability)))) } : {}),
      expectedCloseOn: get("expectedCloseOn") || null,
      ownerUserId: get("ownerUserId"),
      nextAction: get("nextAction") || null,
      nextActionAt: nextActionOn ? new Date(`${nextActionOn}T09:00:00Z`) : null,
      source: get("source") || null,
      notes: get("notes") || null,
    };
    setPending(true);
    setError(null);
    try {
      const result = await saveOpportunity(body);
      if (result.ok) {
        onDone?.();
        if (!initial.id) router.push(`/admin/pipeline/${result.data.opportunityId}`);
        router.refresh();
        return;
      }
      setError(result.error.code === "forbidden" ? labels.forbidden : result.error.message === "stale_version" ? labels.stale : labels.error);
    } finally {
      setPending(false);
    }
  }

  const companyContacts = contacts.filter((c) => c.companyId === companyId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial.id ? labels.titleEdit : labels.titleNew}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={labels.company} required>
              <select name="companyId" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={selectClass} required>
                {companies.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={labels.contact}>
              <select name="primaryContactPersonId" defaultValue={initial.primaryContactPersonId} key={companyId} className={selectClass}>
                <option value="">{labels.noContact}</option>
                {companyContacts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <FormField label={labels.title} required>
            <Input name="title" defaultValue={initial.title} maxLength={200} required />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={labels.value}>
              <Input name="value" defaultValue={initial.value} inputMode="decimal" />
            </FormField>
            <FormField label={labels.probability} hint={labels.probabilityHint}>
              <Input name="probabilityPct" type="number" min={0} max={100} defaultValue={initial.probabilityPct} />
            </FormField>
            <FormField label={labels.expectedClose}>
              <Input name="expectedCloseOn" type="date" defaultValue={initial.expectedCloseOn} />
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={labels.owner} required>
              <select name="ownerUserId" defaultValue={initial.ownerUserId} className={selectClass} required>
                {owners.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={labels.nextAction}>
              <Input name="nextAction" defaultValue={initial.nextAction} maxLength={500} />
            </FormField>
            <FormField label={labels.nextActionAt}>
              <Input name="nextActionOn" type="date" defaultValue={initial.nextActionOn} />
            </FormField>
          </div>
          <FormField label={labels.source}>
            <Input name="source" defaultValue={initial.source} maxLength={200} />
          </FormField>
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
      </CardContent>
    </Card>
  );
}
