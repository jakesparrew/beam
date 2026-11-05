"use client";
/**
 * Guest rows of the portal booking form and the "Invite a guest" form (booking spec 5.2, 3.9,
 * R54-R56): first and last name, an optional email, "Shares my bed" on nights and how the guest
 * is paid (with my package or by order). Rows are added and removed on the client; the inputs
 * are named `guests.<n>.<field>` so the server action reads them from the form data. Without
 * JavaScript the `initial` rows are still there. Texts come from the page. booking-P8 (R55): the
 * "{n} guest uses left this month" line under the legend (`usesLeft`); guest names stay required
 * (R52: a ticket type with guest details asks first and last name per guest).
 */
import { useState } from "react";
import { Button, Input, Label } from "@beam/ui";

export type GuestFieldsLabels = {
  legend: string;
  guestNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  sharesBed: string;
  payLabel: string;
  payGuest: string;
  payOrder: string;
  add: string;
  remove: string;
};

export function GuestFields({
  labels,
  max,
  isNight,
  payOptions,
  initial = 0,
  fixed = false,
  usesLeft = null,
}: {
  labels: GuestFieldsLabels;
  /** Most guests per booking (`max_guests_per_booking`). */
  max: number;
  isNight: boolean;
  /** How a guest may be paid: with the owner's package (`guest`) and/or by order. */
  payOptions: ReadonlyArray<"guest" | "order">;
  /** Rows shown on the first render. */
  initial?: number;
  /** Exactly `initial` rows, without add or remove (the "Invite a guest" form). */
  fixed?: boolean;
  /** R55: the translated "{n} guest uses left this month", shown under the legend. */
  usesLeft?: string | null;
}) {
  const [rows, setRows] = useState<number[]>(() => Array.from({ length: initial }, (_, i) => i));
  const [next, setNext] = useState(initial);
  if (max <= 0 || payOptions.length === 0) return null;
  return (
    <fieldset className="space-y-3" data-testid="guest-fields">
      <legend className="font-medium">{labels.legend}</legend>
      {usesLeft ? (
        <p className="text-sm text-muted-foreground" data-testid="guest-uses-left">
          {usesLeft}
        </p>
      ) : null}
      {rows.map((n, i) => {
        const id = (f: string) => `guest-${n}-${f}`;
        const name = (f: string) => `guests.${i}.${f}`;
        return (
          <div key={n} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2" data-testid={`guest-row-${i}`}>
            <p className="font-medium sm:col-span-2">{labels.guestNumber.replace("{n}", String(i + 1))}</p>
            <div className="grid gap-1">
              <Label htmlFor={id("first")}>{labels.firstName}</Label>
              <Input id={id("first")} name={name("firstName")} required autoComplete="off" maxLength={100} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={id("last")}>{labels.lastName}</Label>
              <Input id={id("last")} name={name("lastName")} required autoComplete="off" maxLength={100} />
            </div>
            <div className="grid gap-1 sm:col-span-2">
              <Label htmlFor={id("email")}>{labels.email}</Label>
              <Input id={id("email")} name={name("email")} type="email" autoComplete="off" maxLength={320} />
            </div>
            {isNight ? (
              <label className="flex min-h-11 items-center gap-2 sm:col-span-2">
                <input type="checkbox" name={name("sharesBed")} className="size-5" />
                <span>{labels.sharesBed}</span>
              </label>
            ) : null}
            <fieldset className="sm:col-span-2">
              <legend className="text-sm">{labels.payLabel}</legend>
              <div className="mt-1 flex flex-wrap gap-4">
                {payOptions.map((p, k) => (
                  <label key={p} className="flex min-h-11 items-center gap-2">
                    <input type="radio" name={name("payWith")} value={p} defaultChecked={k === 0} className="size-5" />
                    <span>{p === "guest" ? labels.payGuest : labels.payOrder}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {fixed ? null : (
              <div className="sm:col-span-2">
                <Button type="button" variant="outline" onClick={() => setRows((r) => r.filter((x) => x !== n))}>
                  {labels.remove}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {!fixed && rows.length < max ? (
        <Button
          type="button"
          variant="outline"
          data-testid="add-guest"
          onClick={() => {
            setRows((r) => [...r, next]);
            setNext((x) => x + 1);
          }}
        >
          {labels.add}
        </Button>
      ) : null}
    </fieldset>
  );
}
