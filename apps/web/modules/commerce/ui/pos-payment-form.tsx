"use client";
/**
 * The till's payment form (commerce spec 5.1, rules 25, 26b, 43, 56): the payment methods as one
 * group of tiles, the field the chosen method needs (terminal reference, terminal, cash received),
 * euro credit, "Invoice to a company", and the pay buttons. `hidden` carries the basket (items,
 * buyer, promotion, client key) or the order id; the form posts to the server action the page
 * passes (`posSell` or `posPayOrder` behind it). Kaart (terminal) (a card taken on a separate
 * terminal) is the default method; the integrated terminal shows only when one is configured.
 * "Op rekening" posts `onAccount=1` and needs a client.
 *
 * The form is always shown on a new sale: `blocked` disables every pay button and shows one prompt
 * that moves the focus to the buyer search (sessions, packages, memberships and tickets need a
 * client, rule 42); `disabled` (an empty basket) disables them without a prompt.
 */
import { useState } from "react";
import { Button, Input, cn } from "@beam/ui";

export type PosPaymentText = {
  method: string;
  cardTerminal: string;
  terminalReference: string;
  onAccount: string;
  onAccountNeedsPerson: string;
  terminal: string;
  cash: string;
  bankTransfer: string;
  terminalLabel: string;
  cashReceived: string;
  useEuroCredit: string;
  euroCredit: string | null;
  companyToggle: string;
  companyName: string;
  vatNumber: string;
  line1: string;
  postalCode: string;
  city: string;
  country: string;
  billingEmail: string;
  pay: string;
};

type Method = "card_terminal" | "terminal" | "cash" | "bank_transfer";

/** Moves the focus to the element `id` (the buyer search) and scrolls it into view. */
function focusById(id: string) {
  const el = document.getElementById(id);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  el?.focus({ preventScroll: true });
}

export function PosPaymentForm(props: {
  action: (form: FormData) => Promise<void>;
  hidden: Record<string, string>;
  terminals: { id: string; name: string }[];
  allowBankTransfer: boolean;
  allowCash: boolean;
  canUseEuroCredit: boolean;
  /** "Op rekening" is offered (null hides it); `allowed` is false without a client. */
  onAccount: { allowed: boolean } | null;
  /** A client is needed first: the prompt text and the id of the buyer search it focuses. */
  blocked?: { message: string; focusId: string } | null;
  /** Nothing to pay yet (an empty basket). */
  disabled?: boolean;
  /** Id of the buyer search the "Op rekening" hint focuses. */
  buyerSearchId?: string;
  text: PosPaymentText;
}) {
  const { text } = props;
  const [method, setMethod] = useState<Method>("card_terminal");
  const off = !!props.blocked || !!props.disabled;
  const methods: { value: Method; label: string }[] = [
    { value: "card_terminal", label: text.cardTerminal },
    ...(props.terminals.length ? [{ value: "terminal" as const, label: text.terminal }] : []),
    ...(props.allowCash ? [{ value: "cash" as const, label: text.cash }] : []),
    ...(props.allowBankTransfer ? [{ value: "bank_transfer" as const, label: text.bankTransfer }] : []),
  ];
  const tile =
    "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 text-[0.8125rem] font-semibold hover:bg-[#faf9f6] has-checked:border-[#c9973a] has-checked:bg-[#fbf6ec] has-checked:text-[#8a5a14] has-focus-visible:ring-2 has-focus-visible:ring-ring";
  const onAccountHint = props.onAccount && !props.onAccount.allowed && !props.blocked;
  return (
    <form action={props.action} className="grid gap-3 border-t pt-3" data-testid="pos-payment">
      {Object.entries(props.hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-[0.75rem] font-semibold tracking-wide text-muted-foreground uppercase">{text.method}</legend>
        <div className="grid grid-cols-2 gap-2">
          {methods.map((m) => (
            <label key={m.value} className={tile}>
              <input type="radio" name="method" value={m.value} checked={method === m.value} onChange={() => setMethod(m.value)} className="size-4 accent-[#8a5a14]" />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>
      {method === "card_terminal" ? (
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{text.terminalReference}</span>
          <Input name="terminalReference" maxLength={40} className="h-11" autoComplete="off" />
        </label>
      ) : null}
      {method === "terminal" && props.terminals.length ? (
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{text.terminalLabel}</span>
          <select name="terminalId" className="h-11 rounded-md border border-input bg-transparent px-3 text-sm" defaultValue={props.terminals[0]?.id ?? ""}>
            {props.terminals.map((term) => (
              <option key={term.id} value={term.id}>
                {term.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {method === "cash" && props.allowCash ? (
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">{text.cashReceived}</span>
          <Input name="cashReceived" inputMode="decimal" className="h-11 text-base tabular-nums" autoComplete="off" />
        </label>
      ) : null}
      {props.canUseEuroCredit ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="useEuroCredit" value="1" className="size-4 accent-[#8a5a14]" />
          <span>
            {text.useEuroCredit}
            {text.euroCredit ? <span className="block text-[0.75rem] text-muted-foreground">{text.euroCredit}</span> : null}
          </span>
        </label>
      ) : null}
      <details className="grid gap-2 text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground">{text.companyToggle}</summary>
        {/* The details are sent when the company name is filled in. */}
        <div className="grid gap-2 pt-2">
          {(
            [
              ["companyName", text.companyName, "organization"],
              ["vatNumber", text.vatNumber, "off"],
              ["line1", text.line1, "address-line1"],
              ["postalCode", text.postalCode, "postal-code"],
              ["city", text.city, "address-level2"],
              ["country", text.country, "country"],
              ["billingEmail", text.billingEmail, "email"],
            ] as const
          ).map(([name, label, autoComplete]) => (
            <label key={name} className="grid gap-1">
              <span>{label}</span>
              <Input name={name} autoComplete={autoComplete} className="h-11" defaultValue={name === "country" ? "BE" : undefined} />
            </label>
          ))}
        </div>
      </details>
      {props.blocked ? (
        <button
          type="button"
          onClick={() => focusById(props.blocked!.focusId)}
          className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-[#e7d3a8] bg-[#fbf6ec] px-3 text-left text-sm font-semibold text-[#8a5a14] hover:bg-[#f7eedc] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-testid="pos-needs-buyer"
          id="pos-needs-buyer"
        >
          {props.blocked.message}
          <span aria-hidden="true">→</span>
        </button>
      ) : null}
      <div className={cn("grid gap-2", props.onAccount ? "grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" : "grid-cols-1")}>
        <Button type="submit" className="min-h-12 text-base" disabled={off} aria-describedby={props.blocked ? "pos-needs-buyer" : undefined}>
          {text.pay}
        </Button>
        {props.onAccount ? (
          <Button
            type="submit"
            name="onAccount"
            value="1"
            variant="outline"
            className="min-h-12 text-base"
            disabled={off || !props.onAccount.allowed}
            aria-describedby={props.blocked ? "pos-needs-buyer" : props.onAccount.allowed ? undefined : "pos-on-account-hint"}
          >
            {text.onAccount}
          </Button>
        ) : null}
      </div>
      {onAccountHint ? (
        props.buyerSearchId ? (
          <button type="button" id="pos-on-account-hint" onClick={() => focusById(props.buyerSearchId!)} className="justify-self-end text-[0.75rem] text-muted-foreground underline-offset-2 hover:underline">
            {text.onAccountNeedsPerson}
          </button>
        ) : (
          <p id="pos-on-account-hint" className="justify-self-end text-[0.75rem] text-muted-foreground">
            {text.onAccountNeedsPerson}
          </p>
        )
      ) : null}
    </form>
  );
}
