"use client";
/**
 * The monthly members' draw on `/admin/memberships` (`memberships.write`): this month's winner or
 * a button that draws one active member at random for a free night (`drawMonthlyWinner`, one
 * draw per month), and the earlier winners. Strings come in as `credits.admin.draw.*` labels.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Button, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
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
    <Card data-testid="monthly-draw">
      <CardHeader>
        <CardTitle>{d("title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p className="text-muted-foreground">{d("description")}</p>
        <p className="font-medium">{fill(d("this_month"), { month })}</p>
        {current ? (
          <p role="status">
            {fill(d("winner"), { name: "" })}
            <Link href={`/admin/persons/${current.personId}`} className="font-medium underline">
              {current.personName}
            </Link>
          </p>
        ) : (
          <>
            <p>{d("not_drawn")}</p>
            {canDraw ? (
              <div>
                <Button type="button" onClick={() => void draw()} disabled={busy}>
                  {busy ? d("drawing") : d("draw")}
                </Button>
              </div>
            ) : null}
          </>
        )}
        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <h3 className="font-semibold">{d("history")}</h3>
        {earlier.length === 0 ? (
          <p className="text-muted-foreground">{d("history_empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-1 pr-3 font-medium">{d("col_month")}</th>
                <th scope="col" className="py-1 font-medium">{d("col_winner")}</th>
              </tr>
            </thead>
            <tbody>
              {earlier.map((r) => (
                <tr key={r.month} className="border-b last:border-0">
                  <td className="py-1 pr-3 tabular-nums">{r.month}</td>
                  <td className="py-1">
                    <Link href={`/admin/persons/${r.personId}`} className="hover:underline">
                      {r.personName}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
