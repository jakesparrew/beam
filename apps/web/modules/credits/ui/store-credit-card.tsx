"use client";
/**
 * `StoreCreditCard` (credits spec section 5): the customer's euro balance from gift vouchers and
 * goodwill as one card ("€ 35,00 store credit", the earliest expiry) with the "Redeem a gift
 * voucher" field. Redemption is commerce's action (`commerce.redeemVoucher`): the page passes it
 * in as `redeem`, because credits code reaches another module only through its `api.ts`. Amounts
 * and dates are formatted on the server; every string arrives as a prop. On success the page is
 * refreshed so the new balance shows.
 */
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input } from "@beam/ui";

export type StoreCreditLabels = {
  title: string;
  redeemTitle: string;
  code: string;
  hint: string;
  submit: string;
  busy: string;
  done: string;
  invalid: string;
  generic: string;
  rateLimited: string;
};

type RedeemResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

export type StoreCreditCardProps = {
  /** "€ 35,00 store credit" (or "No balance yet"). */
  amountText: string;
  /** "First part valid until 31 Dec 2027", or null without an expiry. */
  expiryText: string | null;
  labels: StoreCreditLabels;
  /** Commerce's `redeemVoucher` server action; without it the field is hidden. */
  redeem?: (input: { code: string }) => Promise<RedeemResult>;
};

export function StoreCreditCard({ amountText, expiryText, labels: l, redeem }: StoreCreditCardProps) {
  const router = useRouter();
  const statusId = useId();
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ error?: string; done?: boolean }>({});

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!redeem) return;
    const form = e.currentTarget;
    const raw = new FormData(form).get("code");
    const code = typeof raw === "string" ? raw.trim() : "";
    setBusy(true);
    setState({});
    try {
      const r = await redeem({ code });
      if (r.ok) {
        form.reset();
        setState({ done: true });
        router.refresh();
      } else {
        const known = r.error.code === "not_found" || r.error.code === "conflict" || r.error.code === "validation";
        setState({ error: r.error.code === "rate_limited" ? l.rateLimited : known ? l.invalid : l.generic });
      }
    } catch {
      setState({ error: l.generic });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="store-credit-card">
      <CardHeader>
        <CardTitle className="text-base">{l.title}</CardTitle>
        {expiryText ? <CardDescription>{expiryText}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-lg font-semibold" data-testid="store-credit-amount">
          {amountText}
        </p>
        {redeem ? (
          <form onSubmit={(e) => void submit(e)} className="grid gap-2" aria-describedby={statusId} noValidate>
            <FormField label={l.redeemTitle} hint={l.hint} error={state.error ?? null}>
              <Input name="code" autoComplete="off" required minLength={4} maxLength={40} aria-label={l.code} className="min-h-11" />
            </FormField>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy} className="min-h-11">
                {busy ? l.busy : l.submit}
              </Button>
              <span id={statusId} role="status" className="text-sm text-muted-foreground">
                {state.done ? l.done : ""}
              </span>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
