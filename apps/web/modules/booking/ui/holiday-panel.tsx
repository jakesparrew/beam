"use client";
/**
 * "Belgian public holidays in the next 12 months" (booking spec R4b, 5.1 exceptions screen): the
 * holidays without an exception, each with "Close this day", which creates a `holiday`
 * exception for every template through `upsertException` with the catalogue name in the three
 * locales. Nothing is closed by default. Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Button } from "@beam/ui";
import { upsertException } from "../actions/templates";

export type HolidayItem = { onDate: string; dateLabel: string; label: string; name: Partial<Record<"nl-BE" | "fr-BE" | "en", string>> };

export function HolidayPanel({ items, labels }: { items: HolidayItem[]; labels: { title: string; close: string; empty: string; error: string; conflicts: string } }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function close(item: HolidayItem) {
    setBusy(item.onDate);
    setMessage(null);
    try {
      const res = await upsertException({ onDate: item.onDate, kind: "holiday", name: item.name, templateIds: null });
      if (!res.ok) setMessage({ error: true, text: labels.error });
      else {
        if (res.data.conflicts.length) setMessage({ error: false, text: `${item.dateLabel}: ${labels.conflicts}` });
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="holidays-title" className="grid gap-3 rounded-md border p-4">
      <h2 id="holidays-title" className="text-lg font-semibold">
        {labels.title}
      </h2>
      {message ? (
        <Alert variant={message.error ? "destructive" : "default"} role={message.error ? "alert" : "status"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      {items.length === 0 ? <p className="text-sm text-muted-foreground">{labels.empty}</p> : null}
      <ul className="grid gap-2">
        {items.map((h) => (
          <li key={h.onDate} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="font-medium">{h.label}</span> <span className="text-sm text-muted-foreground">{h.dateLabel}</span>
            </span>
            <Button type="button" size="sm" variant="outline" disabled={busy === h.onDate} onClick={() => void close(h)}>
              {labels.close}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
