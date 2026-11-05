"use client";
/**
 * The manual booking wizard's booking step (booking spec 5.1 `/admin/bookings/new`, R12, R15,
 * R16, R62b, R63): the person chosen in the page's search step, a session picker with live
 * availability, the payment choice (package credit with the balance, pay now at the POS, pay at
 * the desk, free), guests, the override toggles (only with `bookings.override`), the night's
 * emergency contact (a non-blocking prompt) and "send the confirmation email". It submits
 * `createManualBooking`; an order paid now opens commerce's POS. Every text comes from the page.
 */
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, Label, Textarea } from "@beam/ui";
import { createManualBooking } from "../actions/bookings";

export type WizardSession = {
  id: string;
  label: string;
  kind: "day" | "night" | "event";
  /** "3 places left" or "Full". */
  availability: string;
  isFull: boolean;
  canPayCredit: boolean;
  canPayOrder: boolean;
  canPayAtDesk: boolean;
  isFree: boolean;
  /** "4 sessions left" for the chosen person, when the session takes credits. */
  creditBalance: string | null;
  /** R51: an event's ticket types (label with price or state); staff pick one for every booking. */
  ticketTypes?: Array<{ id: string; label: string; disabled: boolean }>;
};

export type WizardLabels = {
  session: string;
  choose: string;
  payment: string;
  /** R51: the ticket type picker. */
  ticketType?: string;
  payCredit: string;
  payOrderNow: string;
  payAtDesk: string;
  payFree: string;
  guests: string;
  addGuest: string;
  removeGuest: string;
  firstName: string;
  lastName: string;
  email: string;
  sharesBed: string;
  overrideTitle: string;
  overCapacity: string;
  overCapacityWarning: string;
  reason: string;
  sendEmail: string;
  emergencyContact: string;
  emergencyName: string;
  emergencyPhone: string;
  create: string;
  errors: Record<string, string>;
};

type Pay = "credit" | "order" | "desk" | "free";
type Guest = { firstName: string; lastName: string; email: string; sharesBed: boolean };

const selectClass =
  "h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ManualBookingWizard({
  personId,
  sessions,
  initialSessionId,
  canOverride,
  labels,
}: {
  personId: string;
  sessions: WizardSession[];
  initialSessionId?: string;
  canOverride: boolean;
  labels: WizardLabels;
}) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState(initialSessionId && sessions.some((s) => s.id === initialSessionId) ? initialSessionId : "");
  const [pay, setPay] = useState<Pay | "">("");
  const [ticketTypeId, setTicketTypeId] = useState(() => sessions.find((s) => s.id === sessionId)?.ticketTypes?.find((t) => !t.disabled)?.id ?? "");
  const [guests, setGuests] = useState<Guest[]>([]);
  const [overCapacity, setOverCapacity] = useState(false);
  const [reason, setReason] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [contact, setContact] = useState({ name: "", phone: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientKey] = useState(() => crypto.randomUUID());

  const session = useMemo(() => sessions.find((s) => s.id === sessionId) ?? null, [sessions, sessionId]);
  const tickets = session?.ticketTypes ?? [];
  const options: Array<{ value: Pay; label: string }> = session
    ? [
        ...(session.canPayCredit ? [{ value: "credit" as const, label: session.creditBalance ? `${labels.payCredit} · ${session.creditBalance}` : labels.payCredit }] : []),
        ...(session.canPayOrder ? [{ value: "order" as const, label: labels.payOrderNow }] : []),
        ...(session.canPayAtDesk ? [{ value: "desk" as const, label: labels.payAtDesk }] : []),
        ...(session.isFree || canOverride ? [{ value: "free" as const, label: labels.payFree }] : []),
      ]
    : [];

  const setGuest = (i: number, patch: Partial<Guest>) => setGuests((g) => g.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !pay || (tickets.length > 0 && !ticketTypeId)) return;
    setPending(true);
    setError(null);
    try {
      const payWith = pay === "desk" ? "order" : pay;
      const guestPay = pay === "free" ? "free" : pay === "credit" ? "guest" : "order";
      const res = await createManualBooking({
        sessionId: session.id,
        personId,
        ...(tickets.length > 0 && ticketTypeId ? { ticketTypeId } : {}),
        payWith,
        ...(pay === "desk" ? { payAtDesk: true } : {}),
        ...(overCapacity ? { overCapacity: true } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        guests: guests
          .filter((g) => g.firstName.trim() && g.lastName.trim())
          .map((g) => ({ firstName: g.firstName.trim(), lastName: g.lastName.trim(), ...(g.email.trim() ? { email: g.email.trim() } : {}), ...(session.kind === "night" ? { sharesBed: g.sharesBed } : {}), payWith: guestPay })),
        ...(session.kind === "night" && contact.name.trim() && contact.phone.trim() ? { emergencyContact: { name: contact.name.trim(), phone: contact.phone.trim() } } : {}),
        sendEmail,
        clientKey,
      });
      if (!res.ok) {
        setError(labels.errors[res.error.message] ?? labels.errors[res.error.code] ?? res.error.code);
        return;
      }
      const { orderId } = res.data as { bookingIds: string[]; orderId?: string };
      if (orderId && pay === "order") router.push(`/admin/pos?order=${orderId}` as never);
      else router.push(`/admin/bookings/${res.data.bookingIds[0]}` as never);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-2xl gap-5">
      <FormField label={labels.session} required requiredMark=" *">
        <select className={selectClass} value={sessionId} onChange={(e) => {
            setSessionId(e.target.value);
            setPay("");
            setTicketTypeId(sessions.find((s) => s.id === e.target.value)?.ticketTypes?.find((t) => !t.disabled)?.id ?? "");
          }} required>
          <option value="">{labels.choose}</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} · {s.availability}
            </option>
          ))}
        </select>
      </FormField>

      {session?.isFull ? (
        <Alert variant={overCapacity ? "destructive" : "default"}>
          <AlertDescription>{labels.overCapacityWarning}</AlertDescription>
        </Alert>
      ) : null}

      {tickets.length > 0 ? (
        <fieldset className="grid gap-2" data-testid="manual-ticket-types">
          <legend className="text-sm font-medium">{labels.ticketType}</legend>
          {tickets.map((t) => (
            <label key={t.id} className={`flex min-h-11 items-center gap-2 text-sm${t.disabled && !canOverride ? " opacity-60" : ""}`}>
              <input
                type="radio"
                name="ticketTypeId"
                value={t.id}
                checked={ticketTypeId === t.id}
                onChange={() => setTicketTypeId(t.id)}
                disabled={t.disabled && !canOverride}
                className="size-4"
                required
              />
              {t.label}
            </label>
          ))}
        </fieldset>
      ) : null}

      {session ? (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{labels.payment}</legend>
          {options.map((o) => (
            <label key={o.value} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="radio" name="pay" value={o.value} checked={pay === o.value} onChange={() => setPay(o.value)} className="size-4" required />
              {o.label}
            </label>
          ))}
        </fieldset>
      ) : null}

      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">{labels.guests}</legend>
        {guests.map((g, i) => (
          <div key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-3">
            <FormField label={labels.firstName}>
              <Input value={g.firstName} onChange={(e) => setGuest(i, { firstName: e.target.value })} maxLength={100} />
            </FormField>
            <FormField label={labels.lastName}>
              <Input value={g.lastName} onChange={(e) => setGuest(i, { lastName: e.target.value })} maxLength={100} />
            </FormField>
            <FormField label={labels.email}>
              <Input type="email" value={g.email} onChange={(e) => setGuest(i, { email: e.target.value })} maxLength={320} />
            </FormField>
            {session?.kind === "night" ? (
              <div className="flex items-center gap-2">
                <Checkbox id={`guest-bed-${i}`} checked={g.sharesBed} onCheckedChange={(v) => setGuest(i, { sharesBed: v === true })} />
                <Label htmlFor={`guest-bed-${i}`}>{labels.sharesBed}</Label>
              </div>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => setGuests((x) => x.filter((_, j) => j !== i))}>
              {labels.removeGuest}
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setGuests((x) => [...x, { firstName: "", lastName: "", email: "", sharesBed: false }])}>
          {labels.addGuest}
        </Button>
      </fieldset>

      {session?.kind === "night" ? (
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="text-sm font-medium">{labels.emergencyContact}</legend>
          <FormField label={labels.emergencyName}>
            <Input value={contact.name} onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))} maxLength={200} />
          </FormField>
          <FormField label={labels.emergencyPhone}>
            <Input type="tel" value={contact.phone} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} maxLength={40} />
          </FormField>
        </fieldset>
      ) : null}

      {canOverride ? (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{labels.overrideTitle}</legend>
          <div className="flex items-center gap-2">
            <Checkbox id="over-capacity" checked={overCapacity} onCheckedChange={(v) => setOverCapacity(v === true)} />
            <Label htmlFor="over-capacity">{labels.overCapacity}</Label>
          </div>
        </fieldset>
      ) : null}

      <FormField label={labels.reason} required={overCapacity || pay === "free"} requiredMark=" *">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} required={overCapacity} />
      </FormField>

      <div className="flex items-center gap-2">
        <Checkbox id="send-email" checked={sendEmail} onCheckedChange={(v) => setSendEmail(v === true)} />
        <Label htmlFor="send-email">{labels.sendEmail}</Label>
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" size="lg" className="w-fit" disabled={pending || !session || !pay || (tickets.length > 0 && !ticketTypeId)}>
        {labels.create}
      </Button>
    </form>
  );
}
