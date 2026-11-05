"use client";
/**
 * "Preview next steps" drawer of the person page (automation spec 5, A-39): a side sheet listing
 * each remaining step of one journey with its due time (Europe/Brussels, formatted on the server)
 * and the predicted outcome (`will_send`, `late_entry`, `condition_false`, `unreachable`,
 * `translation_missing`, `frequency_cap`, `failed`). The rows are computed read-only by
 * `previewSteps` when the panel renders; opening the drawer writes nothing.
 */
import { Badge, Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@beam/ui";
import type { Labels } from "./outcome-badge";

export type PreviewRow = { key: string; type: string; due: string; outcome: string; reason: string | null };

const VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  will_send: "success",
  failed: "destructive",
};

export function PreviewDrawer(p: { enrolmentId: string; automationName: string; rows: PreviewRow[]; labels: Labels }) {
  const l = p.labels;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="automation-preview-open" data-preview-for={p.enrolmentId}>
          {l["panel.preview"]}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" closeLabel={l["common.close"]} className="w-full overflow-y-auto sm:max-w-lg" data-testid="automation-preview">
        <SheetHeader>
          <SheetTitle>
            {l["panel.preview_title"]}: {p.automationName}
          </SheetTitle>
          <SheetDescription>{l["common.times_in_zone"]}</SheetDescription>
        </SheetHeader>
        {p.rows.length ? (
          <table className="mx-4 text-sm">
            <thead>
              <tr className="text-left">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {l["panel.col_step"]}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {l["panel.col_due"]}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {l["panel.col_outcome"]}
                </th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r) => (
                <tr key={r.key} data-step={r.key} data-preview-outcome={r.outcome} className="border-t align-top">
                  <td className="py-1 pr-3">
                    <span className="font-mono">{r.key}</span> <span className="text-muted-foreground">({r.type})</span>
                  </td>
                  <td className="py-1 pr-3">{r.due}</td>
                  <td className="py-1">
                    <Badge variant={VARIANT[r.outcome] ?? "warning"}>{l[`preview.${r.outcome}`] ?? r.outcome}</Badge>
                    {r.reason ? <small className="block text-muted-foreground">{r.reason}</small> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 text-sm text-muted-foreground" data-testid="automation-preview-empty">
            {l["panel.preview_empty"]}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
