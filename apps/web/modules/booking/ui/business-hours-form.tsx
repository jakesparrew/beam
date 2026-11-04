"use client";
/**
 * `settings.business_hours` editor (booking spec 3.0b, 5.1 `/admin/sessions/rules` tab 2): the
 * opening hours per weekday (or closed), the reception phone and a note for customers in three
 * locales. It submits platform's `updateSetting` (passed in by the page as `save`). Business
 * hours never generate sessions; special hours are session exceptions.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, Label, LocalizedInput, type LocalizedInputLabels, type LocalizedValue } from "@beam/ui";
import type { BusinessHours } from "@beam/core/booking";

const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v : "");

type Locale = "nl-BE" | "fr-BE" | "en";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];
type SaveResult = { ok: true; data: { version: number } } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

export type BusinessHoursLabels = {
  weekdayNames: string[];
  closed: string;
  opensAt: string;
  closesAt: string;
  phone: string;
  note: LocalizedInputLabels<Locale>;
  save: string;
  saving: string;
  saved: string;
  stale: string;
  invalid: string;
};

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function BusinessHoursForm({ value, version, save, labels }: { value: BusinessHours; version: number; save: (input: unknown) => Promise<SaveResult>; labels: BusinessHoursLabels }) {
  const router = useRouter();
  const [current, setCurrent] = useState(version);
  const [closed, setClosed] = useState<Record<number, boolean>>(Object.fromEntries(DAYS.map((d) => [d, value.week[d] === null])));
  const [note, setNote] = useState<LocalizedValue<Locale>>(value.note ?? {});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const week = Object.fromEntries(
      DAYS.map((d) => [d, closed[d] ? null : { opens_at: str(f.get(`opens_${d}`)).slice(0, 5), closes_at: str(f.get(`closes_${d}`)).slice(0, 5) }]),
    ) as BusinessHours["week"];
    const cleanNote = Object.fromEntries(LOCALES.filter((l) => (note[l] ?? "").trim()).map((l) => [l, note[l]!.trim()]));
    const next: BusinessHours = {
      week,
      reception_phone: str(f.get("phone")).trim() || null,
      note: Object.keys(cleanNote).length ? cleanNote : null,
    };
    setPending(true);
    setMessage(null);
    try {
      const res = await save({ key: "business_hours", value: next, expectedVersion: current });
      if (res.ok) {
        setCurrent(res.data.version);
        setMessage({ error: false, text: labels.saved });
        router.refresh();
      } else setMessage({ error: true, text: res.error.code === "conflict" ? labels.stale : labels.invalid });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      {message ? (
        <Alert variant={message.error ? "destructive" : "default"} role={message.error ? "alert" : "status"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="grid gap-2">
        {DAYS.map((d) => {
          const day = value.week[d];
          return (
            <li key={d} className="grid items-end gap-2 sm:grid-cols-[10rem_8rem_1fr_1fr]">
              <span className="font-medium">{labels.weekdayNames[d - 1]}</span>
              <Label className="flex min-h-11 items-center gap-2">
                <Checkbox checked={closed[d]} onCheckedChange={(on) => setClosed((c) => ({ ...c, [d]: on === true }))} />
                {labels.closed}
              </Label>
              <FormField label={labels.opensAt}>
                <Input name={`opens_${d}`} type="time" defaultValue={day?.opens_at ?? "08:30"} disabled={closed[d]} />
              </FormField>
              <FormField label={labels.closesAt}>
                <Input name={`closes_${d}`} type="time" defaultValue={day?.closes_at ?? "19:00"} disabled={closed[d]} />
              </FormField>
            </li>
          );
        })}
      </ul>
      <FormField label={labels.phone}>
        <Input name="phone" type="tel" defaultValue={value.reception_phone ?? ""} maxLength={40} />
      </FormField>
      <LocalizedInput name="note" value={note} onChange={setNote} locales={LOCALES} labels={labels.note} multiline />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? labels.saving : labels.save}
        </Button>
      </div>
    </form>
  );
}
