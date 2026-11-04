"use client";
/**
 * `/admin/credits/bulk-extend` (credits spec section 5, rule 32a): days, reason, kinds, sources
 * and the expiry date range, a live preview "N packages will be extended by D days" (the
 * `previewBulkExtend` action) and a confirm dialog that repeats the count before
 * `bulkExtendGrants` runs. Membership grants are never offered (their period moves instead).
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
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
  FormField,
  Input,
  Textarea,
} from "@beam/ui";
import { bulkExtendGrants, previewBulkExtend } from "../actions";
import { errorMessage, useClientKey, type Labels } from "./adjust-dialog";

type Kind = "day" | "night" | "euro";
type Source = "purchase" | "voucher" | "bonus" | "import" | "manual" | "referral" | "transfer";
const KINDS: Kind[] = ["day", "night", "euro"];
const SOURCES: Source[] = ["purchase", "import", "voucher", "bonus", "manual", "referral", "transfer"];

export function BulkExtendForm({ labels: l }: { labels: Labels }) {
  const router = useRouter();
  const [clientKey, renewKey] = useClientKey();
  const [days, setDays] = useState(7);
  const [kinds, setKinds] = useState<Kind[]>(["day", "night"]);
  const [sources, setSources] = useState<Source[]>(["purchase", "import", "voucher", "bonus", "manual"]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<{ matched: number; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const b = (k: string) => l[`admin.bulk_extend.${k}`] ?? k;

  const ready = !!from && !!to && to >= from && kinds.length > 0 && sources.length > 0 && days >= 1 && days <= 90;
  const shown = ready ? preview : null;

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const timer = setTimeout(() => {
      void previewBulkExtend({ days, kinds, sources, expiresFromOn: from, expiresToOn: to }).then((r) => {
        if (live) setPreview(r.ok ? r.data : null);
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ready, days, kinds, sources, from, to]);

  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  function ask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setConfirming(true);
  }

  async function run() {
    setBusy(true);
    setFields({});
    try {
      const r = await bulkExtendGrants({ days, reason: reasonRef.current?.value ?? "", kinds, sources, expiresFromOn: from, expiresToOn: to, clientKey });
      setConfirming(false);
      if (r.ok) {
        setNotice(b("started"));
        renewKey();
        router.refresh();
      } else {
        setError(errorMessage(r.error, l));
        setFields(r.error.fields ?? {});
      }
    } catch {
      setConfirming(false);
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={ask} className="grid max-w-2xl gap-5" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      <FormField label={b("days")} error={fields.days ?? null} required>
        <Input type="number" min={1} max={90} step={1} value={days} onChange={(e) => setDays(Number(e.target.value))} inputMode="numeric" />
      </FormField>
      <FormField label={l["admin.common.reason"]} hint={l["admin.common.reason_hint"]} error={fields.reason ?? null} required>
        <Textarea ref={reasonRef} name="reason" required minLength={3} maxLength={500} rows={2} />
      </FormField>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{b("kinds")}</legend>
        <div className="flex flex-wrap gap-4">
          {KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds(toggle(kinds, k, e.target.checked))} />
              {l[`enum.kind.${k}`]}
            </label>
          ))}
        </div>
        {fields.kinds ? <p className="text-sm text-destructive">{fields.kinds}</p> : null}
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{b("sources")}</legend>
        <div className="flex flex-wrap gap-4">
          {SOURCES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sources.includes(s)} onChange={(e) => setSources(toggle(sources, s, e.target.checked))} />
              {l[`enum.source.${s}`]}
            </label>
          ))}
        </div>
        {fields.sources ? <p className="text-sm text-destructive">{fields.sources}</p> : null}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={b("from")} error={fields.expiresFromOn ?? null} required>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label={b("to")} error={fields.expiresToOn ?? null} required>
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </div>
      <p className="text-sm" aria-live="polite">
        {shown ? <strong>{shown.text}</strong> : <span className="text-muted-foreground">{b("preview_hint")}</span>}
      </p>
      <div>
        <Button type="submit" disabled={!shown || shown.matched === 0 || busy}>
          {b("submit")}
        </Button>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent closeLabel={l["admin.common.close"]}>
          <DialogHeader>
            <DialogTitle>{b("confirm_title")}</DialogTitle>
            <DialogDescription>{shown?.text}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              {l["admin.common.cancel"]}
            </Button>
            <Button type="button" onClick={() => void run()} disabled={busy}>
              {busy ? l["admin.common.saving"] : b("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
