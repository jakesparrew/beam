"use client";
/**
 * Password input with a zxcvbn strength meter and the browser-side HIBP check (PL-1, PL-13).
 * A breached password disables submit; a timeout or error of the HIBP call allows it. The
 * server repeats length, zxcvbn and email checks (`checkPasswordPolicy`).
 */
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, FormField, Input } from "@beam/ui";
import { acceptInvite, changeMyPassword, resetPassword } from "../actions";
import { checkPwnedPassword, type PwnedVerdict } from "./hibp";
import { fill, formValue } from "./login-form";

export type PasswordStrengthLabels = {
  label: string;
  /** `Strength: {level}` */
  strength: string;
  scores: [string, string, string, string, string];
  /** `At least {min} characters ...` */
  hint: string;
  breached: string;
};

type Scorer = (password: string, inputs: string[]) => number;
let scorer: Promise<Scorer> | undefined;

function loadScorer(): Promise<Scorer> {
  scorer ??= Promise.all([import("@zxcvbn-ts/core"), import("@zxcvbn-ts/language-common"), import("@zxcvbn-ts/language-en")]).then(([core, common, en]) => {
    const z = new core.ZxcvbnFactory({ dictionary: { ...common.dictionary, ...en.dictionary }, graphs: common.adjacencyGraphs, translations: en.translations });
    return (password, inputs) => z.check(password.slice(0, 100), inputs).score;
  });
  return scorer;
}

export function PasswordStrength({
  name,
  labels,
  minLength,
  email,
  error,
  onBlockedChange,
}: {
  name: string;
  labels: PasswordStrengthLabels;
  minLength: number;
  email?: string;
  error?: string | null;
  onBlockedChange?: (blocked: boolean) => void;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  // Results remember the value they were computed for, so a stale result never shows.
  const [scored, setScored] = useState<{ value: string; score: number } | null>(null);
  const [checked, setChecked] = useState<{ value: string; verdict: PwnedVerdict } | null>(null);

  useEffect(() => {
    if (!value) return;
    let live = true;
    void loadScorer().then((scoreOf) => {
      if (live) setScored({ value, score: scoreOf(value, email ? [email, email.split("@")[0] ?? ""] : []) });
    });
    const timer = setTimeout(() => {
      void checkPwnedPassword(value).then((verdict) => {
        if (!live) return;
        setChecked({ value, verdict });
        onBlockedChange?.(verdict === "breached");
      });
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [value, email, onBlockedChange]);

  const score = scored && scored.value === value ? scored.score : null;
  const verdict: PwnedVerdict = checked && checked.value === value ? checked.verdict : "unknown";
  const level = score === null ? null : labels.scores[score];
  const meterId = `${id}-meter`;
  return (
    <div className="grid gap-2">
      <FormField label={labels.label} hint={fill(labels.hint, { min: minLength })} error={verdict === "breached" ? labels.breached : (error ?? null)}>
        <Input
          name={name}
          type="password"
          autoComplete="new-password"
          required
          minLength={minLength}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            // A changed password is unchecked until the HIBP answer for it arrives.
            onBlockedChange?.(false);
          }}
          aria-describedby={meterId}
        />
      </FormField>
      <div id={meterId} aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="flex h-1.5 w-40 gap-1" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`h-full flex-1 rounded ${score !== null && score > i ? (score >= 3 ? "bg-primary" : "bg-destructive") : "bg-muted"}`} />
          ))}
        </div>
        {level ? <span>{fill(labels.strength, { level })}</span> : null}
      </div>
    </div>
  );
}

export type SetPasswordLabels = PasswordStrengthLabels & {
  current?: string;
  submit: string;
  done?: string;
  invalidToken: string;
  wrongPassword?: string;
  policy: Record<string, string>;
  generic: string;
};

/** Invite (`acceptInvite`), reset (`resetPassword`) and change (`changeMyPassword`) in one form. */
export function SetPasswordForm({
  mode,
  token,
  labels,
  minLength,
  email,
  askCurrent,
}: {
  mode: "invite" | "reset" | "change";
  token?: string;
  labels: SetPasswordLabels;
  minLength: number;
  email?: string;
  askCurrent?: boolean;
}) {
  const router = useRouter();
  const [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = formValue(form, "password");
    setPending(true);
    setError(null);
    const result =
      mode === "invite"
        ? await acceptInvite({ token, password })
        : mode === "reset"
          ? await resetPassword({ token, password })
          : await changeMyPassword({ newPassword: password, ...(askCurrent ? { currentPassword: formValue(form, "currentPassword") } : {}) });
    setPending(false);
    if (result.ok) {
      if ("next" in result.data) router.push(result.data.next as never);
      else {
        setDone(true);
        event.currentTarget?.reset();
      }
      return;
    }
    const { code, message, fields } = result.error;
    if (code === "not_found") setError(labels.invalidToken);
    else if (message === "wrong_password") setError(labels.wrongPassword ?? labels.generic);
    else if (message === "password_policy") setError((fields?.password ?? "").split(",").map((r) => labels.policy[r] ?? labels.generic).join(" "));
    else setError(labels.generic);
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 max-w-md" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {askCurrent && labels.current ? (
        <FormField label={labels.current}>
          <Input name="currentPassword" type="password" autoComplete="current-password" required />
        </FormField>
      ) : null}
      <PasswordStrength name="password" labels={labels} minLength={minLength} email={email} onBlockedChange={setBlocked} />
      <Button type="submit" disabled={pending || blocked}>
        {labels.submit}
      </Button>
      {done && labels.done ? <p role="status">{labels.done}</p> : null}
    </form>
  );
}
