"use client";
/**
 * The monthly members' draw on `/admin/memberships` (`memberships.write`): this month's winner or
 * a button that draws one active member at random for a free night (`drawMonthlyWinner`, one
 * draw per month), and the earlier winners behind a disclosure: one compact line (owner review,
 * November 2026); the rule text is the title's tooltip. Strings come in as `credits.admin.draw.*` labels.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Button } from "@beam/ui";
import { drawMonthlyWinner } from "../actions";
import { errorMessage, type Labels } from "./adjust-dialog";

export type DrawRow = { month: string; personId: string; personName: string };

const fill = (s: string | undefined, params: Record<string, string>) => Object.entries(params).reduce((t, [k, v]) => t.replace(`{${k}}`, v), s ?? "");

export function MonthlyDrawCard({ month, draws, canDraw, labels: l }: { month: string; draws: DrawRow[]; canDraw: boolean; labels: Labels }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = (k: string) => l[`admin.draw.${k}`] ?? k;
  const current = draws.find((r) => r.month === month);
  const earlier = draws.filter((r) => r.month !== month);

  async function draw() {
    setBusy(true);
    setError(null);
    try {
      const r = await drawMonthlyWinner({});
      if (r.ok) router.refresh();
      else setError(r.error.message === "no_active_members" ? (l["errors.no_active_members"] ?? r.error.message) : errorMessage(r.error, l));
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="monthly-draw" aria-label={d("title")} className="grid gap-2 rounded-xl border border-border bg-card px-5 py-3 text-[0.8125rem]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-[0.875rem] font-semibold" title={d("description")}>
          {d("title")}
        </h2>
        <span className="text-muted-foreground">{fill(d("this_month"), { month })}</span>
        {current ? (
          <p role="status" className="font-medium">
            {fill(d("winner"), { name: "" })}
            <Link href={`/admin/persons/${current.personId}`} className="underline underline-offset-2">
              {current.personName}
            </Link>
          </p>
        ) : (
          <>
            <span>{d("not_drawn")}</span>
            {canDraw ? (
              <Button type="button" size="sm" onClick={() => void draw()} disabled={busy}>
                {busy ? d("drawing") : d("draw")}
              </Button>
            ) : null}
          </>
        )}
        {earlier.length ? (
          <details className="ml-auto">
            <summary className="cursor-pointer text-[0.75rem] font-semibold text-muted-foreground hover:text-foreground">
              {d("history")} ({earlier.length})
            </summary>
            <ul className="mt-2 grid gap-1">
              {earlier.map((r) => (
                <li key={r.month} className="flex gap-3">
                  <span className="w-16 text-muted-foreground tabular-nums">{r.month}</span>
                  <Link href={`/admin/persons/${r.personId}`} className="hover:underline">
                    {r.personName}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
