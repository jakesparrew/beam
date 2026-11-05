"use client";
/**
 * The ticket types tab of `/admin/sessions/[id]` (booking spec 5.1, R50-R52; booking-P8, R2 behind
 * `ff_booking_ticket_types`): one form per existing type plus an empty one to add a type. Each
 * form edits the name in the three locales (completeness badges; a published event needs all
 * three), the ticket product (public and member prices are the product's price versions in
 * commerce), an own capacity inside the session capacity, member-only, the sales window as
 * Europe/Brussels wall clock, the most tickets per booking (owner plus guests), whether guest
 * names are asked, and the order. Submits `upsertTicketType`; "Archive" submits
 * `archiveTicketType` (`bookings.override`). Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Badge, Button, Checkbox, FormField, Input, Label, LocalizedInput, type LocalizedInputLabels, type LocalizedValue } from "@beam/ui";
import { archiveTicketType, upsertTicketType } from "../actions/tickets";

type Locale = "nl-BE" | "fr-BE" | "en";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];

export type TicketTypeFormValues = {
  id: string | null;
  name: LocalizedValue<Locale>;
  productId: string;
  capacity: number | null;
  isMemberOnly: boolean;
  /** Brussels wall clock `YYYY-MM-DDTHH:mm`, or "". */
  salesStartLocal: string;
  salesEndLocal: string;
  maxPerBooking: number;
  requiresGuestDetails: boolean;
  sortOrder: number;
  isActive: boolean;
  /** Live rows of this type (shown as "sold"). */
  sold: number;
};

export type TicketTypesFormLabels = {
  name: LocalizedInputLabels<Locale>;
  product: string;
  productHint: string;
  noProduct: string;
  capacity: string;
  capacityHint: string;
  memberOnly: string;
  salesStart: string;
  salesEnd: string;
  salesHint: string;
  maxPerBooking: string;
  requiresGuestDetails: string;
  sortOrder: string;
  sold: string;
  archived: string;
  add: string;
  save: string;
  saving: string;
  saved: string;
  archive: string;
  errorName: string;
  errorWindow: string;
  errorCapacity: string;
  errors: Record<string, string>;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function messageFor(error: { code: string; message: string; fields?: Record<string, string> }, labels: TicketTypesFormLabels): string {
  const fields = Object.keys(error.fields ?? {});
  if (error.code === "validation") {
    if (fields.some((f) => f.startsWith("name"))) return labels.errorName;
    if (fields.some((f) => f.startsWith("sales"))) return labels.errorWindow;
    if (fields.includes("capacity")) return labels.errorCapacity;
  }
  const key = error.code === "conflict" ? error.message : error.code;
  return labels.errors[key] ?? labels.errors.validation ?? key;
}

function TicketTypeForm({
  sessionId,
  initial,
  products,
  labels,
}: {
  sessionId: string;
  initial: TicketTypeFormValues;
  products: Array<{ id: string; label: string }>;
  labels: TicketTypesFormLabels;
}) {
  const router = useRouter();
  const [name, setName] = useState<LocalizedValue<Locale>>(initial.name);
  const [memberOnly, setMemberOnly] = useState(initial.isMemberOnly);
  const [guestDetails, setGuestDetails] = useState(initial.requiresGuestDetails);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const key = initial.id ?? "new";
  const fid = (f: string) => `tt-${key}-${f}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const text = (k: string) => {
      const v = f.get(k);
      return typeof v === "string" ? v.trim() : "";
    };
    setPending(true);
    setMessage(null);
    try {
      const res = await upsertTicketType({
        ...(initial.id ? { id: initial.id } : {}),
        sessionId,
        productId: text("productId"),
        name,
        capacity: text("capacity") ? Number(text("capacity")) : null,
        isMemberOnly: memberOnly,
        salesStartAt: text("salesStartLocal") || null,
        salesEndAt: text("salesEndLocal") || null,
        maxPerBooking: Number(text("maxPerBooking") || 4),
        requiresGuestDetails: guestDetails,
        sortOrder: Number(text("sortOrder") || 0),
      });
      if (res.ok) {
        setMessage({ error: false, text: labels.saved });
        router.refresh();
      } else {
        setMessage({ error: true, text: messageFor(res.error, labels) });
      }
    } finally {
      setPending(false);
    }
  }

  async function onArchive() {
    if (!initial.id) return;
    setPending(true);
    setMessage(null);
    try {
      const res = await archiveTicketType({ id: initial.id });
      if (res.ok) router.refresh();
      else setMessage({ error: true, text: messageFor(res.error, labels) });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 rounded-md border p-4" noValidate data-testid={`ticket-type-form-${key}`}>
      {message ? (
        <Alert variant={message.error ? "destructive" : "default"} role={message.error ? "alert" : "status"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      {initial.id ? (
        <p className="flex flex-wrap gap-2 text-sm text-muted-foreground">
          <span>{labels.sold.replace("{count}", String(initial.sold))}</span>
          {initial.isActive ? null : <Badge variant="secondary">{labels.archived}</Badge>}
        </p>
      ) : null}
      <LocalizedInput name="name" value={name} onChange={setName} locales={LOCALES} labels={labels.name} />
      <FormField label={labels.product} hint={labels.productHint} id={fid("product")}>
        <select id={fid("product")} name="productId" defaultValue={initial.productId} className={selectClass} required>
          <option value="">{labels.noProduct}</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </FormField>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={labels.capacity} hint={labels.capacityHint} id={fid("capacity")}>
          <Input id={fid("capacity")} name="capacity" type="number" min={1} defaultValue={initial.capacity ?? ""} />
        </FormField>
        <FormField label={labels.maxPerBooking} id={fid("max")}>
          <Input id={fid("max")} name="maxPerBooking" type="number" min={1} max={20} defaultValue={initial.maxPerBooking} />
        </FormField>
        <FormField label={labels.sortOrder} id={fid("sort")}>
          <Input id={fid("sort")} name="sortOrder" type="number" min={0} max={1000} defaultValue={initial.sortOrder} />
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={labels.salesStart} hint={labels.salesHint} id={fid("start")}>
          <Input id={fid("start")} name="salesStartLocal" type="datetime-local" defaultValue={initial.salesStartLocal} />
        </FormField>
        <FormField label={labels.salesEnd} id={fid("end")}>
          <Input id={fid("end")} name="salesEndLocal" type="datetime-local" defaultValue={initial.salesEndLocal} />
        </FormField>
      </div>
      <div className="flex flex-wrap gap-6">
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox id={fid("member")} checked={memberOnly} onCheckedChange={(v) => setMemberOnly(v === true)} />
          <Label htmlFor={fid("member")}>{labels.memberOnly}</Label>
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox id={fid("guests")} checked={guestDetails} onCheckedChange={(v) => setGuestDetails(v === true)} />
          <Label htmlFor={fid("guests")}>{labels.requiresGuestDetails}</Label>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? labels.saving : initial.id ? labels.save : labels.add}
        </Button>
        {initial.id && initial.isActive ? (
          <Button type="button" variant="outline" disabled={pending} onClick={() => void onArchive()}>
            {labels.archive}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Every ticket type of the event, then the empty form that adds one. */
export function TicketTypesForm({
  sessionId,
  types,
  products,
  labels,
}: {
  sessionId: string;
  types: TicketTypeFormValues[];
  products: Array<{ id: string; label: string }>;
  labels: TicketTypesFormLabels;
}) {
  const empty: TicketTypeFormValues = {
    id: null,
    name: {},
    productId: "",
    capacity: null,
    isMemberOnly: false,
    salesStartLocal: "",
    salesEndLocal: "",
    maxPerBooking: 4,
    requiresGuestDetails: true,
    sortOrder: types.length,
    isActive: true,
    sold: 0,
  };
  return (
    <div className="grid gap-4" data-testid="ticket-types">
      {types.map((t) => (
        <TicketTypeForm key={t.id} sessionId={sessionId} initial={t} products={products} labels={labels} />
      ))}
      <TicketTypeForm key={`new-${types.length}`} sessionId={sessionId} initial={empty} products={products} labels={labels} />
    </div>
  );
}
