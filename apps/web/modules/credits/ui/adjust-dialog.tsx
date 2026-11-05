"use client";
/**
 * Staff grant dialogs (credits spec section 5, `/admin/credits/grants/[grantId]`). This file also
 * holds the shared client pieces of the credits back-office: `ActionDialog` (a focus-trapping
 * dialog that posts its form to a server action, keeps the input on error and refreshes the page
 * on success), `useClientKey` (one uuid per opened form, spec section 5) and `errorMessage`
 * (an action error in the catalogue's words). Every string arrives as a prop.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FormField,
  Input,
  Textarea,
} from "@beam/ui";
import { adjustGrant, updateGrantNote } from "../actions";

export type Labels = Record<string, string>;
export type ActionResultLike = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

/** A text field of a submitted form (`fallback` when absent or a file). */
export function str(form: FormData, name: string, fallback: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : fallback;
}

/** Fills `{name}` slots of a simple catalogue message (no plurals: those are formatted on the server). */
export function fill(template: string | undefined, params: Record<string, string | number> = {}): string {
  return (template ?? "").replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

const SPECIFIC = [
  "insufficient",
  "guest_limit",
  "not_shareable",
  "share_limit",
  "stale_version",
  "already_member",
  "no_mandate",
  "too_many_benefits",
  // R2 sharing (credits-P8): a share dialog or the review list names these.
  "already_shared",
  "share_with_owner",
  "grant_not_active",
  "review_item_not_found",
];

/** The words for an action error: a specific credits error when the message names one, else the code's. */
export function errorMessage(error: { code: string; message: string }, l: Labels): string {
  const specific = SPECIFIC.find((k) => error.message === k || error.message.startsWith(`${k}:`));
  if (specific) return l[`errors.${specific}`] ?? error.message;
  if (error.message === "grant_expired") return l["errors.expired"] ?? error.message;
  return l[`errors.${error.code}`] ?? l["errors.generic"] ?? error.message;
}

/** A uuid generated when a form opens and renewed after each successful submit. */
export function useClientKey(): [string, () => void] {
  const [key, setKey] = useState(() => crypto.randomUUID());
  return [key, () => setKey(crypto.randomUUID())];
}

export function ActionDialog({
  trigger,
  title,
  description,
  submitLabel,
  destructive,
  labels: l,
  onSubmit,
  children,
}: {
  trigger: string;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  destructive?: boolean;
  labels: Labels;
  onSubmit: (form: FormData, clientKey: string) => Promise<ActionResultLike>;
  children: (fields: Record<string, string>) => ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [clientKey, renewKey] = useClientKey();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const r = await onSubmit(new FormData(e.currentTarget), clientKey);
      if (r.ok) {
        setOpen(false);
        renewKey();
        router.refresh();
      } else {
        setError(errorMessage(r.error, l));
        setFields(r.error.fields ?? {});
      }
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          renewKey();
          setError(null);
          setFields({});
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={destructive ? "destructive" : "outline"}>{trigger}</Button>
      </DialogTrigger>
      <DialogContent closeLabel={l["admin.common.close"]}>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {children(fields)}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {l["admin.common.cancel"]}
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={busy}>
              {busy ? l["admin.common.saving"] : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The reason field every staff ledger change needs (min 3 characters). */
export function ReasonField({ labels: l, error }: { labels: Labels; error?: string }) {
  return (
    <FormField label={l["admin.common.reason"]} hint={l["admin.common.reason_hint"]} error={error ?? null} required>
      <Textarea name="reason" required minLength={3} maxLength={500} rows={2} />
    </FormField>
  );
}

/** `updateGrantNote`: the staff note of a grant (PII-risk, staff only). */
export function GrantNoteForm({ grantId, note, labels: l }: { grantId: string; note: string | null; labels: Labels }) {
  const router = useRouter();
  const [state, setState] = useState<{ error?: string; saved?: boolean }>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setState({});
    try {
      const r = await updateGrantNote({ grantId, note: str(new FormData(e.currentTarget), "note", "") });
      if (r.ok) {
        setState({ saved: true });
        router.refresh();
      } else setState({ error: errorMessage(r.error, l) });
    } catch {
      setState({ error: l["errors.generic"] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-2">
      <FormField label={l["admin.grant.note"]} hint={l["admin.grant.note_hint"]} error={state.error ?? null}>
        <Textarea name="note" defaultValue={note ?? ""} maxLength={1000} rows={3} />
      </FormField>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? l["admin.common.saving"] : l["admin.grant.note_save"]}
        </Button>
        {state.saved ? (
          <span role="status" className="text-sm text-muted-foreground">
            {l["admin.common.saved"]}
          </span>
        ) : null}
      </div>
    </form>
  );
}

/** `adjustGrant`: a signed number of units with a reason. */
export function AdjustDialog({ grantId, isEuro, labels: l }: { grantId: string; isEuro: boolean; labels: Labels }) {
  return (
    <ActionDialog
      trigger={l["admin.adjust.open"]!}
      title={l["admin.adjust.title"]!}
      description={l["admin.adjust.description"]}
      submitLabel={l["admin.adjust.submit"]!}
      labels={l}
      onSubmit={(f, clientKey) =>
        adjustGrant({ grantId, quantity: Number(f.get("quantity")), reason: str(f, "reason", ""), clientKey })
      }
    >
      {(fields) => (
        <>
          <FormField label={l["admin.adjust.quantity"]} hint={isEuro ? l["admin.adjust.euro_hint"] : undefined} error={fields.quantity ?? null} required>
            <Input name="quantity" type="number" step={1} required inputMode="numeric" />
          </FormField>
          <ReasonField labels={l} error={fields.reason} />
        </>
      )}
    </ActionDialog>
  );
}
