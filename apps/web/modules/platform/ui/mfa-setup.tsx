"use client";
/**
 * MFA enrolment (`/admin/mfa/setup`, PL-4): the QR code and manual key, one valid code to
 * confirm, then the 10 recovery codes once with "Download as .txt" and "I stored them".
 * Also the recovery-code regeneration of `/admin/account`.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, Label } from "@beam/ui";
import { confirmMfaEnrolment, regenerateRecoveryCodes, startMfaEnrolment } from "../actions";
import { fill, formValue } from "./login-form";

export type MfaSetupLabels = {
  intro: string;
  qrAlt: string;
  manualKey: string;
  code: string;
  confirm: string;
  invalid: string;
  loading: string;
  codesTitle: string;
  codesIntro: string;
  download: string;
  stored: string;
  continue: string;
  fileHeading: string;
  generic: string;
};

export function RecoveryCodes({ codes, labels, email, onDone }: { codes: string[]; labels: MfaSetupLabels; email: string; onDone: () => void }) {
  const [stored, setStored] = useState(false);
  function download() {
    const text = `${fill(labels.fileHeading, { email })}\n\n${codes.join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "beam-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section aria-labelledby="recovery-codes-title" className="grid gap-4">
      <h2 id="recovery-codes-title" className="text-lg font-semibold">
        {labels.codesTitle}
      </h2>
      <p>{labels.codesIntro}</p>
      <ul className="grid grid-cols-2 gap-2 font-mono text-sm" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button type="button" variant="outline" onClick={download}>
        {labels.download}
      </Button>
      <div className="flex items-center gap-2">
        <Checkbox id="codes-stored" checked={stored} onCheckedChange={(v) => setStored(v === true)} />
        <Label htmlFor="codes-stored">{labels.stored}</Label>
      </div>
      <Button type="button" disabled={!stored} onClick={onDone}>
        {labels.continue}
      </Button>
    </section>
  );
}

export function MfaSetup({ labels, email }: { labels: MfaSetupLabels; email: string }) {
  const router = useRouter();
  const [enrolment, setEnrolment] = useState<{ uri: string; svg: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    void startMfaEnrolment({}).then((result) => {
      if (!live) return;
      if (result.ok) setEnrolment({ uri: result.data.otpauthUri, svg: result.data.qrSvg });
      else if (result.error.message === "mfa_already_enrolled") router.push("/admin/mfa/verify");
      else setError(labels.generic);
    });
    return () => {
      live = false;
    };
  }, [labels.generic, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await confirmMfaEnrolment({ code: formValue(new FormData(event.currentTarget), "code").trim() });
    setPending(false);
    if (result.ok) setCodes(result.data.recoveryCodes);
    else setError(result.error.code === "validation" ? labels.invalid : labels.generic);
  }

  if (codes) return <RecoveryCodes codes={codes} labels={labels} email={email} onDone={() => router.push("/admin")} />;
  const secret = enrolment ? (new URL(enrolment.uri).searchParams.get("secret") ?? "") : "";
  return (
    <div className="grid gap-4">
      <p>{labels.intro}</p>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {enrolment ? (
        <>
          <div role="img" aria-label={labels.qrAlt} className="mx-auto w-56 bg-white p-2" dangerouslySetInnerHTML={{ __html: enrolment.svg }} />
          <p className="text-sm">
            {labels.manualKey}: <code className="break-all font-mono" data-testid="totp-secret">{secret.replace(/(.{4})/g, "$1 ").trim()}</code>
          </p>
          <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
            <FormField label={labels.code}>
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required />
            </FormField>
            <Button type="submit" disabled={pending}>
              {labels.confirm}
            </Button>
          </form>
        </>
      ) : (
        <p role="status">{labels.loading}</p>
      )}
    </div>
  );
}

export function RegenerateCodesForm({ labels, email, submitLabel }: { labels: MfaSetupLabels; email: string; submitLabel: string }) {
  const router = useRouter();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await regenerateRecoveryCodes({ code: formValue(new FormData(event.currentTarget), "code").trim() });
    if (result.ok) setCodes(result.data.recoveryCodes);
    else setError(result.error.code === "validation" ? labels.invalid : labels.generic);
  }
  if (codes)
    return (
      <RecoveryCodes
        codes={codes}
        labels={labels}
        email={email}
        onDone={() => {
          setCodes(null);
          router.refresh();
        }}
      />
    );
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 max-w-md" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <FormField label={labels.code}>
        <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required />
      </FormField>
      <Button type="submit">{submitLabel}</Button>
    </form>
  );
}
