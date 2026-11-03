"use client";
/**
 * The second sign-in step (`/admin/mfa/verify`, PL-3, PL-5): a 6-digit code, or a recovery
 * code through the toggle. Wrong codes count toward the lockout; a locked account shows
 * "Account locked until HH:mm".
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input } from "@beam/ui";
import { useRecoveryCode as submitRecoveryCode, verifyTotp } from "../actions";
import { fill, formValue } from "./login-form";

export type TotpLabels = {
  code: string;
  submit: string;
  submitting: string;
  invalid: string;
  locked: string;
  useRecovery: string;
  useTotp: string;
  recovery: string;
  recoverySubmit: string;
  generic: string;
};

export function TotpForm({ labels, returnTo, locale }: { labels: TotpLabels; returnTo?: string; locale: string }) {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = formValue(new FormData(event.currentTarget), "code").trim();
    setPending(true);
    setError(null);
    const input = { code, ...(returnTo ? { returnTo } : {}) };
    const result = recovery ? await submitRecoveryCode(input) : await verifyTotp(input);
    setPending(false);
    if (result.ok) {
      router.push(result.data.next as never);
      router.refresh();
      return;
    }
    const { code: errorCode, message, fields } = result.error;
    if (message === "locked") {
      const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" }).format(new Date(fields?.locked_until ?? Date.now()));
      setError(fill(labels.locked, { time }));
    } else if (errorCode === "validation") setError(labels.invalid);
    else setError(labels.generic);
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {recovery ? (
        <FormField label={labels.recovery} key="recovery">
          <Input name="code" autoComplete="off" spellCheck={false} required />
        </FormField>
      ) : (
        <FormField label={labels.code} key="totp">
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required />
        </FormField>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? labels.submitting : recovery ? labels.recoverySubmit : labels.submit}
      </Button>
      <Button type="button" variant="link" onClick={() => setRecovery((r) => !r)}>
        {recovery ? labels.useTotp : labels.useRecovery}
      </Button>
    </form>
  );
}
