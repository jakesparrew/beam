"use client";
/**
 * The merge compare screen (crm spec 5.1, `/admin/persons/[id]/merge?with=<id>`): one radio pair
 * per field (the staying person's value by default), the per-table counts that move, blocking
 * conflicts in red, a switch of which person stays, and a typed "MERGE" confirmation before
 * `mergePersons`. Every string is a prop; values arrive formatted.
 */
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { MergeField } from "@beam/core/crm";
import { mergePersons } from "../merge/actions";

export type MergeSide = { id: string; customerNumber: string; name: string; version: number };

export type MergeCompareView = {
  winner: MergeSide;
  loser: MergeSide;
  fields: Array<{ field: MergeField; label: string; winner: string; loser: string; differs: boolean }>;
  counts: Array<{ label: string; count: number }>;
  conflicts: string[];
};

export type MergeCompareLabels = {
  title: string;
  intro: string;
  field: string;
  winner: string;
  loser: string;
  chooseWinner: string;
  swap: string;
  countsTitle: string;
  noCounts: string;
  conflictsTitle: string;
  confirmLabel: string;
  confirm: string;
  done: string;
  error: string;
  staleVersion: string;
  empty: string;
};

const CONFIRM_WORD = "MERGE";

export function MergeCompare({ view, labels }: { view: MergeCompareView; labels: MergeCompareLabels }) {
  const router = useRouter();
  const [choices, setChoices] = useState<Partial<Record<MergeField, "winner" | "loser">>>({});
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = view.conflicts.length > 0;

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await mergePersons({
      winnerId: view.winner.id,
      loserId: view.loser.id,
      winnerVersion: view.winner.version,
      loserVersion: view.loser.version,
      fieldChoices: choices,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message === "stale_version" ? labels.staleVersion : labels.error);
      return;
    }
    router.push(`/admin/persons/${view.winner.id}` as Route);
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{labels.chooseWinner}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            <span className="font-medium">
              {view.winner.name} ({view.winner.customerNumber})
            </span>{" "}
            ← {view.loser.name} ({view.loser.customerNumber})
          </p>
          <Button variant="outline" size="sm" onClick={() => router.push(`/admin/persons/${view.loser.id}/merge?with=${view.winner.id}` as Route)}>
            {labels.swap}
          </Button>
        </CardContent>
      </Card>

      {blocked ? (
        <Alert variant="destructive">
          <AlertTitle>{labels.conflictsTitle}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {view.conflicts.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{labels.title}</CardTitle>
          <p className="text-sm text-muted-foreground">{labels.intro}</p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{labels.field}</TableHead>
                <TableHead>
                  {view.winner.name} ({view.winner.customerNumber})
                </TableHead>
                <TableHead>
                  {view.loser.name} ({view.loser.customerNumber})
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.fields.map((f) => {
                const pick = choices[f.field] ?? "winner";
                return (
                  <TableRow key={f.field} className={f.differs ? "" : "text-muted-foreground"}>
                    <TableCell className="font-medium">{f.label}</TableCell>
                    {(["winner", "loser"] as const).map((side) => (
                      <TableCell key={side}>
                        <label className="flex items-start gap-2">
                          <input
                            type="radio"
                            name={`field-${f.field}`}
                            value={side}
                            checked={pick === side}
                            disabled={!f.differs || busy}
                            onChange={() => setChoices((c) => ({ ...c, [f.field]: side }))}
                          />
                          <span className="break-all">{(side === "winner" ? f.winner : f.loser) || labels.empty}</span>
                        </label>
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{labels.countsTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {view.counts.length ? (
            <ul className="grid gap-1 text-sm">
              {view.counts.map((c) => (
                <li key={c.label}>{c.label}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{labels.noCounts}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:max-w-md">
          <Label htmlFor="merge-confirm">{labels.confirmLabel}</Label>
          <Input id="merge-confirm" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} disabled={blocked || busy} />
          <Button variant="destructive" disabled={blocked || busy || typed.trim() !== CONFIRM_WORD} onClick={() => void submit()}>
            {labels.confirm}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
