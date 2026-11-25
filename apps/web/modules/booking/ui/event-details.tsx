"use client";
/**
 * Owner requirements 4 and 5 on `/admin/sessions/[id]` of an event or webinar: the edit form
 * (title, description, venue, start and end, capacity, price with 0 = free, WebinarGeek link and
 * broadcast id; `updateSession`) and the media panel (artwork, presentations and supporting
 * materials, and "share with participants"). Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input, LocalizedInput, type LocalizedInputLabels, type LocalizedValue } from "@beam/ui";
import { updateSession } from "../actions/sessions";
import { addSessionMaterial, removeSessionImage, removeSessionMaterial, setMaterialsReleased, uploadSessionImage } from "../actions/event-media";
import { eurosToCents } from "./template-form";

type Locale = "nl-BE" | "fr-BE" | "en";
const LOCALES: readonly Locale[] = ["nl-BE", "fr-BE", "en"];
const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v.trim() : "");

type Result = { ok: true } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

function errorText(res: Result, errors: Record<string, string>): string | null {
  if (res.ok) return null;
  const reason = res.error.code === "conflict" ? res.error.message : res.error.code;
  const fields = res.error.fields ? ` (${Object.keys(res.error.fields).join(", ")})` : "";
  return (errors[reason] ?? errors.validation ?? reason) + fields;
}

export type EventDetailsValues = {
  id: string;
  updatedAt: string;
  isWebinar: boolean;
  title: LocalizedValue<Locale>;
  description: LocalizedValue<Locale>;
  startsLocal: string;
  endsLocal: string;
  capacity: number;
  location: string;
  /** The current public price in euro ("" when free). */
  price: string;
  webinarGeekUrl: string;
  webinarGeekBroadcastId: string;
};

export type EventDetailsLabels = {
  title: LocalizedInputLabels<Locale>;
  description: LocalizedInputLabels<Locale>;
  startsAt: string;
  endsAt: string;
  seats: string;
  location: string;
  price: string;
  priceHint: string;
  webinarGeekUrl: string;
  webinarGeekUrlHint: string;
  webinarGeekId: string;
  webinarGeekIdHint: string;
  save: string;
  saving: string;
  saved: string;
  errors: Record<string, string>;
};

export function EventDetailsForm({ initial, labels }: { initial: EventDetailsValues; labels: EventDetailsLabels }) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const price = str(f.get("price"));
    const priceCents = eurosToCents(price);
    if (Number.isNaN(priceCents)) {
      setMessage({ error: true, text: `${labels.errors.validation ?? "validation"} (${labels.price})` });
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const res = await updateSession({
        id: initial.id,
        expectedUpdatedAt: initial.updatedAt,
        title,
        description: LOCALES.some((l) => (description[l] ?? "").trim()) ? description : null,
        startsAt: str(f.get("startsAt")),
        endsAt: str(f.get("endsAt")),
        capacitySeats: Number(str(f.get("capacity"))),
        location: str(f.get("location")) || null,
        // Only a changed price touches the product (an event may still use a product picked earlier).
        ...(price !== initial.price ? { priceCents } : {}),
        ...(initial.isWebinar
          ? { webinarGeekUrl: str(f.get("webinarGeekUrl")) || null, webinarGeekBroadcastId: str(f.get("webinarGeekBroadcastId")) || null }
          : {}),
      });
      const failed = errorText(res, labels.errors);
      setMessage(failed ? { error: true, text: failed } : { error: false, text: labels.saved });
      if (!failed) router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate data-testid="event-details-form">
      {message ? (
        <Alert variant={message.error ? "destructive" : "default"} role={message.error ? "alert" : "status"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <LocalizedInput name="title" value={title} onChange={setTitle} locales={LOCALES} labels={labels.title} />
      <LocalizedInput name="description" value={description} onChange={setDescription} locales={LOCALES} labels={labels.description} multiline />
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={labels.startsAt} required>
          <Input name="startsAt" type="datetime-local" defaultValue={initial.startsLocal} required />
        </FormField>
        <FormField label={labels.endsAt} required>
          <Input name="endsAt" type="datetime-local" defaultValue={initial.endsLocal} required />
        </FormField>
        <FormField label={labels.seats} required>
          <Input name="capacity" type="number" min={0} defaultValue={initial.capacity} required />
        </FormField>
        <FormField label={labels.price} hint={labels.priceHint}>
          <Input name="price" inputMode="decimal" placeholder="0" defaultValue={initial.price} />
        </FormField>
        <FormField label={labels.location}>
          <Input name="location" maxLength={200} defaultValue={initial.location} />
        </FormField>
      </div>
      {initial.isWebinar ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={labels.webinarGeekUrl} hint={labels.webinarGeekUrlHint}>
            <Input name="webinarGeekUrl" type="url" inputMode="url" placeholder="https://" maxLength={2000} defaultValue={initial.webinarGeekUrl} />
          </FormField>
          <FormField label={labels.webinarGeekId} hint={labels.webinarGeekIdHint}>
            <Input name="webinarGeekBroadcastId" inputMode="numeric" maxLength={20} defaultValue={initial.webinarGeekBroadcastId} />
          </FormField>
        </div>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? labels.saving : labels.save}
        </Button>
      </div>
    </form>
  );
}

export type EventMediaLabels = {
  artwork: string;
  artworkHint: string;
  artworkAlt: string;
  materials: string;
  materialsHint: string;
  noMaterials: string;
  upload: string;
  uploading: string;
  remove: string;
  released: string;
  notReleased: string;
  release: string;
  unrelease: string;
  errors: Record<string, string>;
};

export function EventMediaPanel({
  sessionId,
  imageUrl,
  materials,
  releasedAt,
  labels,
}: {
  sessionId: string;
  imageUrl: string | null;
  materials: Array<{ id: string; name: string; url: string }>;
  /** Formatted release time, null while hidden. */
  releasedAt: string | null;
  labels: EventMediaLabels;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<Result>) {
    setPending(true);
    setError(null);
    try {
      const res = await work();
      const failed = errorText(res, labels.errors);
      if (failed) setError(failed);
      else router.refresh();
    } finally {
      setPending(false);
    }
  }

  function uploadWith(send: (fd: FormData) => Promise<Result>) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const fd = new FormData(form);
      fd.set("sessionId", sessionId);
      void run(() => send(fd)).then(() => form.reset());
    };
  }

  return (
    <div className="grid gap-6" data-testid="event-media">
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-3">
        <h3 className="font-semibold">{labels.artwork}</h3>
        {imageUrl ? (
          <div className="flex flex-wrap items-end gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- stored image from /api/public/files */}
            <img src={imageUrl} alt={labels.artworkAlt} className="h-40 w-auto max-w-full rounded-md border object-cover" />
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void run(() => removeSessionImage({ id: sessionId }))}>
              {labels.remove}
            </Button>
          </div>
        ) : null}
        <form onSubmit={uploadWith(uploadSessionImage)} className="flex flex-wrap items-end gap-2">
          <FormField label={labels.artwork} hint={labels.artworkHint} className="min-w-64">
            <Input name="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required />
          </FormField>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? labels.uploading : labels.upload}
          </Button>
        </form>
      </div>

      <div className="grid gap-3">
        <h3 className="font-semibold">{labels.materials}</h3>
        <p className="text-sm text-muted-foreground">{labels.materialsHint}</p>
        {materials.length === 0 ? <p className="text-sm text-muted-foreground">{labels.noMaterials}</p> : null}
        <ul className="grid gap-2">
          {materials.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <a href={m.url} className="underline underline-offset-4">
                {m.name}
              </a>
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void run(() => removeSessionMaterial({ id: sessionId, fileId: m.id }))}>
                {labels.remove}
              </Button>
            </li>
          ))}
        </ul>
        <form onSubmit={uploadWith(addSessionMaterial)} className="flex flex-wrap items-end gap-2">
          <FormField label={labels.materials} className="min-w-64">
            <Input name="file" type="file" required />
          </FormField>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? labels.uploading : labels.upload}
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span role="status">{releasedAt ? labels.released.replace("{date}", releasedAt) : labels.notReleased}</span>
          <Button type="button" variant={releasedAt ? "outline" : "default"} size="sm" disabled={pending} onClick={() => void run(() => setMaterialsReleased({ id: sessionId, released: !releasedAt }))}>
            {releasedAt ? labels.unrelease : labels.release}
          </Button>
        </div>
      </div>
    </div>
  );
}
