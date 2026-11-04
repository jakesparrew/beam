"use client";
/**
 * The schedule template form (booking spec 5.1 `/admin/sessions/templates` "Add schedule" and
 * `/admin/sessions/templates/[id]`). Create takes several start times and makes one template per
 * time (`createTemplates`); edit changes one template with its version (`updateTemplate`, R2).
 * Warnings (room overlap, outside opening hours) never block the save. Texts come from the page.
 */
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, Label, LocalizedInput, type LocalizedInputLabels, type LocalizedValue } from "@beam/ui";
import { createSession } from "../actions/sessions";
import { createTemplates, setTemplateActive, updateTemplate } from "../actions/templates";

const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v : "");

type Locale = "nl-BE" | "fr-BE" | "en";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];

export type TemplateFormValues = {
  id?: string;
  version?: number;
  kind: "day" | "night" | "event";
  name: LocalizedValue<Locale>;
  description: LocalizedValue<Locale>;
  weekdays: number[];
  /** Create: several `HH:mm`; edit: exactly one. */
  startTimes: string[];
  durationMinutes: number;
  capacity: number | null;
  creditKind: "day" | "night" | "";
  creditCost: number;
  productId: string;
  isMemberOnly: boolean;
  location: string;
  activeFromOn: string;
  activeToOn: string;
};

export type TemplateFormLabels = {
  kind: string;
  kinds: Record<"day" | "night" | "event", string>;
  name: LocalizedInputLabels<Locale>;
  description: LocalizedInputLabels<Locale>;
  weekdays: string;
  weekdayNames: string[];
  startTimes: string;
  startTime: string;
  duration: string;
  seats: string;
  beds: string;
  creditKind: string;
  creditCost: string;
  product: string;
  none: string;
  memberOnly: string;
  location: string;
  activeFrom: string;
  activeTo: string;
  save: string;
  saving: string;
  saved: string;
  incompleteName: string;
  warningOverlap: string;
  warningHours: string;
  errors: Record<string, string>;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const isComplete = (v: LocalizedValue<Locale>) => LOCALES.every((l) => (v[l] ?? "").trim().length > 0);

export function TemplateForm({ initial, products, labels }: { initial: TemplateFormValues; products: Array<{ id: string; label: string }>; labels: TemplateFormLabels }) {
  const router = useRouter();
  const editing = !!initial.id;
  const [kind, setKind] = useState(initial.kind);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [weekdays, setWeekdays] = useState<number[]>(initial.weekdays);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  function toggleDay(wd: number, on: boolean) {
    setWeekdays((cur) => (on ? [...new Set([...cur, wd])].sort((a, b) => a - b) : cur.filter((d) => d !== wd)));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (k: string) => str(form.get(k)).trim();
    const num = (k: string) => (text(k) === "" ? null : Number(text(k)));
    const times = text("startTimes").split(/[\s,;]+/).filter(Boolean);
    const capacity = num("capacity");
    const desc = LOCALES.some((l) => (description[l] ?? "").trim()) ? description : null;
    const common = {
      name,
      description: desc,
      weekdays,
      durationMinutes: num("durationMinutes") ?? 0,
      capacitySeats: kind === "night" ? null : capacity,
      capacityBeds: kind === "night" ? capacity : null,
      creditKind: text("creditKind") === "" ? null : (text("creditKind") as "day" | "night"),
      creditCost: num("creditCost") ?? 0,
      productId: text("productId") || null,
      isMemberOnly: form.get("isMemberOnly") === "on",
      location: text("location") || null,
      activeFromOn: text("activeFromOn"),
      activeToOn: text("activeToOn") || null,
    };
    setPending(true);
    setError(null);
    setNotes([]);
    try {
      const res = editing
        ? await updateTemplate({ ...common, id: initial.id, expectedVersion: initial.version, kind, startTime: times[0] })
        : await createTemplates({ ...common, kind, startTimes: times });
      if (!res.ok) {
        const reason = res.error.code === "conflict" ? res.error.message : res.error.code;
        const fields = res.error.fields ? ` (${Object.keys(res.error.fields).join(", ")})` : "";
        setError((labels.errors[reason] ?? labels.errors.validation ?? reason) + fields);
        return;
      }
      const warnings = res.data.warnings;
      setNotes([
        labels.saved,
        ...(!editing && !isComplete(name) ? [labels.incompleteName] : []),
        ...warnings.map((w) => (w.code === "location_overlap" ? labels.warningOverlap : `${labels.warningHours} (${labels.weekdayNames[Number(w.detail) - 1] ?? w.detail})`)),
      ]);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notes.length ? (
        <Alert role="status">
          <AlertDescription>
            <ul className="list-disc pl-4">
              {[...new Set(notes)].map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={labels.kind}>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as TemplateFormValues["kind"])} className={selectClass}>
            {(["day", "night", "event"] as const).map((k) => (
              <option key={k} value={k}>
                {labels.kinds[k]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.location}>
          <Input name="location" defaultValue={initial.location} maxLength={200} />
        </FormField>
        <FormField label={kind === "night" ? labels.beds : labels.seats} required>
          <Input name="capacity" type="number" min={0} defaultValue={initial.capacity ?? ""} required />
        </FormField>
      </div>
      <LocalizedInput name="name" value={name} onChange={setName} locales={LOCALES} labels={labels.name} />
      <LocalizedInput name="description" value={description} onChange={setDescription} locales={LOCALES} labels={labels.description} multiline />
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{labels.weekdays}</legend>
        <div className="flex flex-wrap gap-3">
          {labels.weekdayNames.map((label, i) => (
            <Label key={label} className="flex min-h-11 items-center gap-2">
              <Checkbox checked={weekdays.includes(i + 1)} onCheckedChange={(on) => toggleDay(i + 1, on === true)} />
              {label}
            </Label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={editing ? labels.startTime : labels.startTimes} required hint={editing ? undefined : "09:00, 11:30, 14:00"}>
          <Input name="startTimes" defaultValue={initial.startTimes.join(", ")} required />
        </FormField>
        <FormField label={labels.duration} required>
          <Input name="durationMinutes" type="number" min={15} max={1440} defaultValue={initial.durationMinutes} required />
        </FormField>
        <FormField label={labels.product}>
          <select name="productId" defaultValue={initial.productId} className={selectClass}>
            <option value="">{labels.none}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.creditKind}>
          <select name="creditKind" defaultValue={initial.creditKind} className={selectClass}>
            <option value="">{labels.none}</option>
            <option value="day">{labels.kinds.day}</option>
            <option value="night">{labels.kinds.night}</option>
          </select>
        </FormField>
        <FormField label={labels.creditCost}>
          <Input name="creditCost" type="number" min={0} max={10} defaultValue={initial.creditCost} />
        </FormField>
        <Label className="flex min-h-11 items-center gap-2 self-end">
          <Checkbox name="isMemberOnly" defaultChecked={initial.isMemberOnly} />
          {labels.memberOnly}
        </Label>
        <FormField label={labels.activeFrom} required>
          <Input name="activeFromOn" type="date" defaultValue={initial.activeFromOn} required />
        </FormField>
        <FormField label={labels.activeTo}>
          <Input name="activeToOn" type="date" defaultValue={initial.activeToOn} />
        </FormField>
      </div>
      <div>
        <Button type="submit" disabled={pending || weekdays.length === 0}>
          {pending ? labels.saving : labels.save}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// One-off session or event (`/admin/sessions/new`, R5, R50)
// ---------------------------------------------------------------------------

const EVENT_CATEGORIES = ["lecture", "concert", "member_event", "experience", "webinar", "special_activity", "partner_event"] as const;
type EventCategory = (typeof EVENT_CATEGORIES)[number];

export type SessionFormLabels = Omit<TemplateFormLabels, "weekdays" | "weekdayNames" | "startTimes" | "startTime" | "activeFrom" | "activeTo" | "incompleteName" | "warningHours" | "name" | "description" | "saved"> & {
  title: LocalizedInputLabels<Locale>;
  description: LocalizedInputLabels<Locale>;
  startsAt: string;
  eventCategory: string;
  eventCategories: Record<EventCategory, string>;
  company: string;
  createDraft: string;
  createPublish: string;
  /** "Translate the title into {locales} before publishing." with `{locales}` left in. */
  missingLocales: string;
  localeNames: Record<Locale, string>;
};

export function SessionForm({
  products,
  companies,
  labels,
}: {
  products: Array<{ id: string; label: string }>;
  companies: Array<{ id: string; label: string }>;
  labels: SessionFormLabels;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<TemplateFormValues["kind"]>("event");
  const [category, setCategory] = useState<EventCategory>("lecture");
  const [title, setTitle] = useState<LocalizedValue<Locale>>({});
  const [description, setDescription] = useState<LocalizedValue<Locale>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = LOCALES.filter((l) => !(title[l] ?? "").trim());

  async function submit(form: HTMLFormElement, publish: boolean) {
    const f = new FormData(form);
    const text = (k: string) => str(f.get(k)).trim();
    const capacity = text("capacity") === "" ? undefined : Number(text("capacity"));
    const desc = LOCALES.some((l) => (description[l] ?? "").trim()) ? description : undefined;
    setPending(true);
    setError(null);
    try {
      const res = await createSession({
        kind,
        ...(kind === "event" ? { eventCategory: category } : {}),
        ...(kind === "event" && category === "partner_event" && text("partnerCompanyId") ? { partnerCompanyId: text("partnerCompanyId") } : {}),
        title,
        ...(desc ? { description: desc } : {}),
        startsAt: text("startsAt"),
        durationMinutes: Number(text("durationMinutes")),
        ...(kind === "night" ? { capacityBeds: capacity } : { capacitySeats: capacity }),
        creditKind: text("creditKind") === "" ? null : text("creditKind"),
        creditCost: Number(text("creditCost") || 0),
        ...(text("productId") ? { productId: text("productId") } : {}),
        ...(kind === "event" && category === "member_event" ? {} : { isMemberOnly: f.get("isMemberOnly") === "on" }),
        ...(text("location") ? { location: text("location") } : {}),
        publish,
      });
      if (!res.ok) {
        const reason = res.error.code === "conflict" ? res.error.message : res.error.code;
        const fields = res.error.fields ? ` (${Object.keys(res.error.fields).join(", ")})` : "";
        setError((labels.errors[reason] ?? labels.errors.validation ?? reason) + fields);
        return;
      }
      router.push(`/admin/sessions/day/${text("startsAt").slice(0, 10)}` as Route);
    } finally {
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    void submit(event.currentTarget, submitter?.value === "publish");
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={labels.kind}>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as TemplateFormValues["kind"])} className={selectClass}>
            {(["day", "night", "event"] as const).map((k) => (
              <option key={k} value={k}>
                {labels.kinds[k]}
              </option>
            ))}
          </select>
        </FormField>
        {kind === "event" ? (
          <FormField label={labels.eventCategory} required>
            <select name="eventCategory" value={category} onChange={(e) => setCategory(e.target.value as EventCategory)} className={selectClass}>
              {EVENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {labels.eventCategories[c]}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
        {kind === "event" && category === "partner_event" ? (
          <FormField label={labels.company} required>
            <select name="partnerCompanyId" className={selectClass} required>
              <option value="">{labels.none}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
      </div>
      <LocalizedInput name="title" value={title} onChange={setTitle} locales={LOCALES} labels={labels.title} />
      <LocalizedInput name="description" value={description} onChange={setDescription} locales={LOCALES} labels={labels.description} multiline />
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={labels.startsAt} required>
          <Input name="startsAt" type="datetime-local" required />
        </FormField>
        <FormField label={labels.duration} required>
          <Input name="durationMinutes" type="number" min={15} max={2880} defaultValue={120} required />
        </FormField>
        <FormField label={kind === "night" ? labels.beds : labels.seats} required>
          <Input key={`cap-${kind}`} name="capacity" type="number" min={0} defaultValue={kind === "night" ? 6 : 12} required />
        </FormField>
        <FormField label={labels.creditKind}>
          <select key={`ck-${kind}`} name="creditKind" defaultValue={kind === "event" ? "" : kind} className={selectClass}>
            <option value="">{labels.none}</option>
            <option value="day">{labels.kinds.day}</option>
            <option value="night">{labels.kinds.night}</option>
          </select>
        </FormField>
        <FormField label={labels.creditCost}>
          <Input key={`cost-${kind}`} name="creditCost" type="number" min={0} max={10} defaultValue={kind === "event" ? 0 : 1} />
        </FormField>
        <FormField label={labels.product}>
          <select name="productId" defaultValue="" className={selectClass}>
            <option value="">{labels.none}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={labels.location}>
          <Input name="location" maxLength={200} />
        </FormField>
        <Label className="flex min-h-11 items-center gap-2 self-end">
          <Checkbox key={`member-${category}`} name="isMemberOnly" defaultChecked={kind === "event" && category === "member_event"} disabled={kind === "event" && category === "member_event"} />
          {labels.memberOnly}
        </Label>
      </div>
      {missing.length ? <p className="text-sm text-muted-foreground">{labels.missingLocales.replace("{locales}", missing.map((l) => labels.localeNames[l]).join(", "))}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="draft" variant="outline" disabled={pending}>
          {pending ? labels.saving : labels.createDraft}
        </Button>
        <Button type="submit" name="intent" value="publish" disabled={pending || missing.length > 0}>
          {labels.createPublish}
        </Button>
      </div>
    </form>
  );
}

/** Activate or deactivate a template (`setTemplateActive`; activation needs a complete name). */
export function TemplateActiveToggle({ id, isActive, labels }: { id: string; isActive: boolean; labels: { activate: string; deactivate: string; incomplete: string; error: string } }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError(null);
          void setTemplateActive({ id, isActive: !isActive })
            .then((res) => {
              if (res.ok) router.refresh();
              else setError(res.error.code === "validation" ? labels.incomplete : labels.error);
            })
            .finally(() => setPending(false));
        }}
      >
        {isActive ? labels.deactivate : labels.activate}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
