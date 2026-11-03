"use client";
/**
 * Client forms of the sign-in screens and the shared admin frame. Strings arrive as props
 * (resolved on the server from the `platform` catalogue); `fill()` fills `{name}` and simple
 * ICU plurals for values only known in the browser (minutes, counts).
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  AdminShell,
  Alert,
  AlertDescription,
  Button,
  FormField,
  Input,
  ReportProblemDialog,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type AdminShellProps,
  type ReportProblemLabels,
} from "@beam/ui";
import {
  customerPasswordSignIn,
  reportProblem,
  requestMagicLink,
  requestPasswordReset,
  revokeMyOtherSessions,
  revokeSession,
  signOut,
  staffSignIn,
  updateMyProfile,
} from "../actions";

type Params = Record<string, string | number>;

/** Fills `{name}` placeholders and `{n, plural, one {...} other {...}}` blocks (with `#`). */
export function fill(template: string, params: Params = {}): string {
  let out = template;
  const plural = /\{(\w+), plural,((?:[^{}]|\{[^{}]*\})*)\}/;
  for (let m = plural.exec(out); m; m = plural.exec(out)) {
    const n = Number(params[m[1]!] ?? 0);
    const forms: Record<string, string> = {};
    for (const f of m[2]!.matchAll(/(=\d+|\w+)\s*\{([^{}]*)\}/g)) forms[f[1]!] = f[2] ?? "";
    const chosen = forms[`=${n}`] ?? (n === 1 ? forms.one : undefined) ?? forms.other ?? "";
    out = out.replace(m[0], chosen.replace(/#/g, String(n)));
  }
  return out.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

/** A text field of a submitted form ("" for a missing field or a file). */
export function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

const timeOf = (iso: string | undefined, locale: string) =>
  iso ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" }).format(new Date(iso)) : "";

function useSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return { pending, setPending, error, setError };
}

function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Admin frame: AdminShell with the "Report a problem" dialog (PL-86)
// ---------------------------------------------------------------------------

/** Auth.js's sign-out page deletes the database session and the cookie, then returns to the login. */
export const ADMIN_SIGN_OUT_HREF = "/api/auth/signout?callbackUrl=%2Fadmin%2Flogin";

export function AdminFrame(props: Omit<AdminShellProps, "userMenu"> & { reportLabels: ReportProblemLabels; emergencyPhone: string }) {
  const { reportLabels, emergencyPhone, children, ...shell } = props;
  const [open, setOpen] = useState(false);
  return (
    <>
      <AdminShell {...shell} userMenu={{ onReportProblem: () => setOpen(true), signOutHref: ADMIN_SIGN_OUT_HREF }}>
        {children}
      </AdminShell>
      <ReportProblemDialog open={open} onOpenChange={setOpen} labels={reportLabels} emergencyPhone={emergencyPhone} onSubmit={(input) => reportProblem(input)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Staff login (/admin/login)
// ---------------------------------------------------------------------------

export type LoginLabels = {
  email: string;
  password: string;
  submit: string;
  submitting: string;
  invalid: string;
  locked: string;
  rateLimited: string;
  generic: string;
};

export function LoginForm({ labels, returnTo, locale, footer }: { labels: LoginLabels; returnTo?: string; locale: string; footer?: ReactNode }) {
  const router = useRouter();
  const s = useSubmit();
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    s.setPending(true);
    s.setError(null);
    const result = await staffSignIn({ email: formValue(form, "email"), password: formValue(form, "password") });
    s.setPending(false);
    if (result.ok) {
      const next = returnTo ? `${result.data.next}?returnTo=${encodeURIComponent(returnTo)}` : result.data.next;
      router.push(next as never);
      return;
    }
    const { code, message, fields } = result.error;
    if (message === "locked") s.setError(fill(labels.locked, { time: timeOf(fields?.locked_until, locale) }));
    else if (code === "rate_limited") s.setError(fill(labels.rateLimited, { minutes: Math.max(1, Math.ceil(Number(fields?.retry_after ?? 60) / 60)) }));
    else if (code === "unauthorized" || code === "validation") s.setError(labels.invalid);
    else s.setError(labels.generic);
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4" noValidate>
      <ErrorBox message={s.error} />
      <FormField label={labels.email}>
        <Input name="email" type="email" autoComplete="username" required />
      </FormField>
      <FormField label={labels.password}>
        <Input name="password" type="password" autoComplete="current-password" required />
      </FormField>
      <Button type="submit" disabled={s.pending}>
        {s.pending ? labels.submitting : labels.submit}
      </Button>
      {footer}
    </form>
  );
}

export function RequestResetForm({ labels }: { labels: { email: string; submit: string; sent: string } }) {
  const [sent, setSent] = useState(false);
  const s = useSubmit();
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    s.setPending(true);
    await requestPasswordReset({ email: formValue(new FormData(event.currentTarget), "email"), audience: "staff" });
    s.setPending(false);
    setSent(true);
  }
  if (sent) return <p role="status">{labels.sent}</p>;
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
      <FormField label={labels.email}>
        <Input name="email" type="email" autoComplete="username" required />
      </FormField>
      <Button type="submit" disabled={s.pending}>
        {labels.submit}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Customer login (/[locale]/account/login)
// ---------------------------------------------------------------------------

export type PortalLoginLabels = {
  email: string;
  submit: string;
  submitting: string;
  magicTab: string;
  passwordTab: string;
  password: string;
  passwordSubmit: string;
  invalidEmail: string;
  invalidCredentials: string;
  rateLimited: string;
  generic: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function PortalLoginForm({ labels, locale, seg, returnTo }: { labels: PortalLoginLabels; locale: "nl-BE" | "fr-BE" | "en"; seg: string; returnTo?: string }) {
  const router = useRouter();
  const s = useSubmit();
  async function onMagic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = formValue(new FormData(event.currentTarget), "email").trim();
    if (!EMAIL_RE.test(email)) return s.setError(labels.invalidEmail);
    s.setPending(true);
    s.setError(null);
    const result = await requestMagicLink({ email, locale, ...(returnTo ? { returnTo } : {}) });
    s.setPending(false);
    if (result.ok) router.push(`/${seg}/account/login/check-email?email=${encodeURIComponent(email)}` as never);
    else s.setError(result.error.code === "validation" ? labels.invalidEmail : labels.generic);
  }
  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    s.setPending(true);
    s.setError(null);
    const result = await customerPasswordSignIn({ email: formValue(form, "email"), password: formValue(form, "password"), locale, ...(returnTo ? { returnTo } : {}) });
    s.setPending(false);
    if (result.ok) return router.push(result.data.next as never);
    if (result.error.code === "rate_limited") s.setError(fill(labels.rateLimited, { minutes: Math.max(1, Math.ceil(Number(result.error.fields?.retry_after ?? 60) / 60)) }));
    else s.setError(labels.invalidCredentials);
  }
  return (
    <Tabs defaultValue="magic" className="grid gap-4">
      <TabsList>
        <TabsTrigger value="magic">{labels.magicTab}</TabsTrigger>
        <TabsTrigger value="password">{labels.passwordTab}</TabsTrigger>
      </TabsList>
      <ErrorBox message={s.error} />
      <TabsContent value="magic">
        <form onSubmit={(e) => void onMagic(e)} className="grid gap-4" noValidate>
          <FormField label={labels.email}>
            <Input name="email" type="email" autoComplete="email" required />
          </FormField>
          <Button type="submit" disabled={s.pending}>
            {s.pending ? labels.submitting : labels.submit}
          </Button>
        </form>
      </TabsContent>
      <TabsContent value="password">
        <form onSubmit={(e) => void onPassword(e)} className="grid gap-4" noValidate>
          <FormField label={labels.email}>
            <Input name="email" type="email" autoComplete="username" required />
          </FormField>
          <FormField label={labels.password}>
            <Input name="password" type="password" autoComplete="current-password" required />
          </FormField>
          <Button type="submit" disabled={s.pending}>
            {labels.passwordSubmit}
          </Button>
        </form>
      </TabsContent>
    </Tabs>
  );
}

/** The resend button of the check-email and error pages (respects the PL-11 limit server-side). */
export function ResendLinkForm({ labels, locale, email }: { labels: { email: string; submit: string; sent: string }; locale: "nl-BE" | "fr-BE" | "en"; email?: string }) {
  const [sent, setSent] = useState(false);
  const s = useSubmit();
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    s.setPending(true);
    await requestMagicLink({ email: formValue(new FormData(event.currentTarget), "email"), locale });
    s.setPending(false);
    setSent(true);
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
      <FormField label={labels.email}>
        <Input name="email" type="email" autoComplete="email" defaultValue={email} required />
      </FormField>
      <Button type="submit" variant="outline" disabled={s.pending}>
        {labels.submit}
      </Button>
      {sent ? <p role="status">{labels.sent}</p> : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Own account helpers (/admin/account, /[locale]/account/security)
// ---------------------------------------------------------------------------

export function SignOutButton({ label, variant = "outline" }: { label: string; variant?: "outline" | "default" | "ghost" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      id="sign-out"
      type="button"
      variant={variant}
      disabled={pending}
      onClick={() => void (async () => {
        setPending(true);
        const result = await signOut({});
        router.push((result.ok ? result.data.next : "/admin/login") as never);
        router.refresh();
      })()}
    >
      {label}
    </Button>
  );
}

export function ProfileForm({ labels, name, locale, locales }: { labels: { name: string; locale: string; save: string; saved: string; generic: string }; name: string; locale: string; locales: { value: string; label: string }[] }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await updateMyProfile({ name: formValue(form, "name"), locale: formValue(form, "locale") });
    setStatus(result.ok ? labels.saved : labels.generic);
    if (result.ok) router.refresh();
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 max-w-md">
      <FormField label={labels.name}>
        <Input name="name" defaultValue={name} required maxLength={120} />
      </FormField>
      <FormField label={labels.locale}>
        <select name="locale" defaultValue={locale} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
          {locales.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </FormField>
      <Button type="submit">{labels.save}</Button>
      {status ? <p role="status">{status}</p> : null}
    </form>
  );
}

export function RevokeSessionButton({ sessionId, label }: { sessionId: string; label: string }) {
  const router = useRouter();
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => void (async () => (await revokeSession({ sessionId })).ok && router.refresh())()}>
      {label}
    </Button>
  );
}

export function SignOutOthersButton({ label, done }: { label: string; done: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant="outline"
        onClick={() => void (async () => {
          const result = await revokeMyOtherSessions({});
          if (result.ok) {
            setMessage(fill(done, { count: result.data.count }));
            router.refresh();
          }
        })()}
      >
        {label}
      </Button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
