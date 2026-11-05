"use client";
/**
 * `/admin/credits/sharing-review` (credits rule 43, R2): the open `v_sharing_review` items (rule,
 * package or guest, distinct people with full names, last use) and, with `credits.adjust`, a
 * decision dialog per item (`reviewSharing`: OK, warned, disable sharing; optional staff note).
 * A reviewed item leaves the list until a new person appears. The page formats every row.
 */
import Link from "next/link";
import { EmptyState, FormField, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@beam/ui";
import { reviewSharing } from "../actions";
import { ActionDialog, str, type Labels } from "./adjust-dialog";

export type SharingReviewView = {
  key: string;
  rule: "many_guests" | "guest_hopping";
  grantId: string | null;
  guestPersonId: string | null;
  /** Linked to the staff screen of the grant (many_guests) or of the guest (guest_hopping). */
  subjectText: string;
  count: number;
  people: { personId: string; name: string }[];
  lastText: string;
};

const DECISIONS = ["ok", "warned", "sharing_disabled"] as const;

export function SharingReviewTable({ rows, canDecide, labels: l }: { rows: SharingReviewView[]; canDecide: boolean; labels: Labels }) {
  const r = (k: string) => l[`admin.sharing_review.${k}`] ?? "";
  if (rows.length === 0) return <EmptyState title={r("empty")} />;
  return (
    <Table>
      <TableCaption>{r("caption")}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{r("col_rule")}</TableHead>
          <TableHead scope="col">{r("col_subject")}</TableHead>
          <TableHead scope="col">{r("col_count")}</TableHead>
          <TableHead scope="col">{r("col_people")}</TableHead>
          <TableHead scope="col">{r("col_last")}</TableHead>
          {canDecide ? <TableHead scope="col">{r("col_decision")}</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell>{r(`rule_${row.rule}`)}</TableCell>
            <TableCell>
              {row.grantId ? (
                <Link href={`/admin/credits/grants/${row.grantId}`} className="underline">
                  {row.subjectText}
                </Link>
              ) : row.guestPersonId ? (
                <Link href={`/admin/persons/${row.guestPersonId}`} className="underline">
                  {row.subjectText}
                </Link>
              ) : (
                row.subjectText
              )}
            </TableCell>
            <TableCell>{row.count}</TableCell>
            <TableCell>
              <ul className="grid gap-1">
                {row.people.map((p) => (
                  <li key={p.personId}>
                    <Link href={`/admin/persons/${p.personId}`} className="underline">
                      {p.name || p.personId.slice(0, 8)}
                    </Link>
                  </li>
                ))}
              </ul>
            </TableCell>
            <TableCell>{row.lastText}</TableCell>
            {canDecide ? (
              <TableCell>
                <ActionDialog
                  trigger={r("decision")}
                  title={`${r(`rule_${row.rule}`)}: ${row.subjectText}`}
                  submitLabel={r("submit")}
                  labels={l}
                  onSubmit={(f) =>
                    reviewSharing({
                      rule: row.rule,
                      ...(row.rule === "many_guests" ? { grantId: row.grantId ?? undefined } : { guestPersonId: row.guestPersonId ?? undefined }),
                      decision: str(f, "decision", "ok") as (typeof DECISIONS)[number],
                      note: str(f, "note", "") || undefined,
                    })
                  }
                >
                  {(fields) => (
                    <>
                      <fieldset className="grid gap-2">
                        <legend className="text-sm font-medium">{r("decision")}</legend>
                        {DECISIONS.map((d, i) => (
                          <label key={d} className="flex min-h-11 items-center gap-2">
                            <input type="radio" name="decision" value={d} defaultChecked={i === 0} />
                            {r(`decision_${d}`)}
                          </label>
                        ))}
                      </fieldset>
                      <FormField label={r("note")} error={fields.note ?? null}>
                        <Textarea name="note" maxLength={1000} rows={2} />
                      </FormField>
                    </>
                  )}
                </ActionDialog>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
