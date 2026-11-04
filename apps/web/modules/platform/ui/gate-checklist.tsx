"use client";
/**
 * The 13 go-live items (`/admin/system/go-live`, PL-77): state, confirmer, date and note per
 * item, the runbook (in the repository) that proves it, and confirm or withdraw with a note (owner or
 * technical_admin; the server also refuses `security_confirmed` without a fresh pentest, PL-85).
 */
import { useState } from "react";
import { Badge, Button, FormField, Input } from "@beam/ui";
import { confirmGoLiveItem } from "../actions";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

export type GateItemView = { key: string; confirmed: boolean; confirmedAt: string | null; confirmedBy: string | null; note: string | null; runbook: string };

function GateItem({ item, canConfirm, locale, labels, errors }: { item: GateItemView; canConfirm: boolean; locale: string; labels: Labels; errors: Labels }) {
  const [note, setNote] = useState("");
  const r = useRun(errors);
  return (
    <li className="grid gap-2 rounded-md border p-3" data-gate-item={item.key}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{lab(labels, `item_${item.key}`)}</span>
        <Badge variant={item.confirmed ? "success" : "warning"}>{lab(labels, item.confirmed ? "confirmed" : "open")}</Badge>
      </div>
      {item.confirmed ? (
        <p className="text-sm text-muted-foreground">
          {lab(labels, "confirmed_by", { who: item.confirmedBy ?? "–", when: item.confirmedAt ? new Date(item.confirmedAt).toLocaleString(locale, { timeZone: "Europe/Brussels" }) : "–" })}
          {item.note ? ` · ${item.note}` : ""}
        </p>
      ) : item.note ? (
        <p className="text-sm text-muted-foreground">{item.note}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {lab(labels, "runbook")} <code>{item.runbook}</code>
      </p>
      {canConfirm ? (
        <div className="flex flex-wrap items-end gap-2">
          <FormField label={lab(labels, "note")} className="min-w-64 flex-1">
            <Input value={note} onChange={(e) => setNote(e.target.value)} minLength={3} maxLength={1000} />
          </FormField>
          <Button
            type="button"
            size="sm"
            variant={item.confirmed ? "outline" : "default"}
            disabled={r.pending || note.trim().length < 3}
            onClick={() => void r.run(() => confirmGoLiveItem({ item: item.key, confirmed: !item.confirmed, note }), lab(labels, "saved"), () => setNote(""))}
          >
            {lab(labels, item.confirmed ? "withdraw" : "confirm")}
          </Button>
        </div>
      ) : null}
      <Feedback ok={r.ok} error={r.error} />
    </li>
  );
}

export function GateChecklist({ items, canConfirm, locale, labels, errors }: { items: GateItemView[]; canConfirm: boolean; locale: string; labels: Labels; errors: Labels }) {
  return (
    <ol className="grid gap-3">
      {items.map((item) => (
        <GateItem key={item.key} item={item} canConfirm={canConfirm} locale={locale} labels={labels} errors={errors} />
      ))}
    </ol>
  );
}
