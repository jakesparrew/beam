"use client";
/**
 * Staff user forms (`/admin/settings/users`, `/admin/settings/users/[id]`; PL-9, PL-10, PL-16):
 * the invite form, the profile and role form, and the account controls (disable or enable,
 * reset MFA with a reason, unlock, resend the invite, revoke sessions). The server enforces the
 * owner rules; the form only hides choices the actor cannot make.
 */
import { useState, type FormEvent } from "react";
import { Button, FormField, Input, Switch } from "@beam/ui";
import { LOCALES } from "@beam/core/i18n";
import { inviteStaffUser, resendInvite, resetUserMfa, revokeAllSessions, revokeSession, setUserStatus, unlockUser, updateStaffUser } from "../actions";
import { formValue } from "./login-form";
import { Feedback, lab, useRun, type Labels } from "./settings-form";

type RoleOption = { key: string; label: string };
const LOCALE_NAMES: Record<string, string> = { "nl-BE": "Nederlands", "fr-BE": "Français", en: "English" };

function RoleSelect({ name, roles, defaultValue, label }: { name: string; roles: RoleOption[]; defaultValue: string; label: string }) {
  return (
    <FormField label={label}>
      <select name={name} defaultValue={defaultValue} className="h-9 rounded-md border bg-background px-2 text-sm">
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
    </FormField>
  );
}

function LocaleSelect({ defaultValue, label }: { defaultValue: string; label: string }) {
  return (
    <FormField label={label}>
      <select name="locale" defaultValue={defaultValue} className="h-9 rounded-md border bg-background px-2 text-sm">
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </FormField>
  );
}

export function InviteUserForm({ roles, labels, errors }: { roles: RoleOption[]; labels: Labels; errors: Labels }) {
  const r = useRun(errors);
  const [key, setKey] = useState(0);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = formValue(form, "email");
    const ok = await r.run(
      () => inviteStaffUser({ email, name: formValue(form, "name"), roleKey: formValue(form, "roleKey"), locale: formValue(form, "locale") }),
      lab(labels, "invited", { email }),
    );
    if (ok) setKey((k) => k + 1);
  }
  return (
    <form key={key} onSubmit={(e) => void onSubmit(e)} className="grid max-w-2xl gap-3 rounded-md border p-4" noValidate aria-labelledby="invite-title">
      <h2 id="invite-title" className="text-lg font-medium">
        {lab(labels, "invite_title")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lab(labels, "name")}>
          <Input name="name" required maxLength={120} />
        </FormField>
        <FormField label={lab(labels, "email")}>
          <Input name="email" type="email" required autoComplete="off" />
        </FormField>
        <RoleSelect name="roleKey" roles={roles} defaultValue={roles.find((x) => x.key === "reception")?.key ?? roles[0]?.key ?? ""} label={lab(labels, "role")} />
        <LocaleSelect defaultValue="nl-BE" label={lab(labels, "locale")} />
      </div>
      <Feedback ok={r.ok} error={r.error} />
      <div>
        <Button type="submit" disabled={r.pending}>
          {lab(labels, "invite_submit")}
        </Button>
      </div>
    </form>
  );
}

export type EditableUser = {
  id: string;
  name: string | null;
  email: string;
  locale: string;
  roleKey: string;
  isTester: boolean;
  status: "active" | "disabled";
  locked: boolean;
  invitePending: boolean;
  mfaEnrolled: boolean;
};

export function UserProfileForm({ user, roles, labels, errors }: { user: EditableUser; roles: RoleOption[]; labels: Labels; errors: Labels }) {
  const r = useRun(errors);
  const [tester, setTester] = useState(user.isTester);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await r.run(
      () => updateStaffUser({ userId: user.id, name: formValue(form, "name"), locale: formValue(form, "locale"), roleKey: formValue(form, "roleKey"), isTester: tester }),
      lab(labels, "saved"),
    );
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid max-w-2xl gap-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lab(labels, "name")}>
          <Input name="name" defaultValue={user.name ?? ""} required maxLength={120} />
        </FormField>
        <LocaleSelect defaultValue={user.locale} label={lab(labels, "locale")} />
        <RoleSelect name="roleKey" roles={roles} defaultValue={user.roleKey} label={lab(labels, "role")} />
        <div className="flex items-center gap-3 pt-6">
          <Switch id="user-tester" checked={tester} onCheckedChange={setTester} />
          <label htmlFor="user-tester" className="text-sm">
            {lab(labels, "tester")}
          </label>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{lab(labels, "role_change_hint")}</p>
      <Feedback ok={r.ok} error={r.error} />
      <div>
        <Button type="submit" disabled={r.pending}>
          {lab(labels, "save")}
        </Button>
      </div>
    </form>
  );
}

export function UserAccountControls({ user, labels, errors }: { user: EditableUser; labels: Labels; errors: Labels }) {
  const r = useRun(errors);
  const [reason, setReason] = useState("");
  return (
    <div className="grid max-w-2xl gap-4">
      <div className="flex flex-wrap gap-2">
        {user.status === "active" ? (
          <Button type="button" variant="destructive" disabled={r.pending} onClick={() => void r.run(() => setUserStatus({ userId: user.id, status: "disabled" }), lab(labels, "disabled_done"))}>
            {lab(labels, "disable")}
          </Button>
        ) : (
          <Button type="button" variant="outline" disabled={r.pending} onClick={() => void r.run(() => setUserStatus({ userId: user.id, status: "active" }), lab(labels, "enabled_done"))}>
            {lab(labels, "enable")}
          </Button>
        )}
        {user.locked ? (
          <Button type="button" variant="outline" disabled={r.pending} onClick={() => void r.run(() => unlockUser({ userId: user.id }), lab(labels, "unlocked"))}>
            {lab(labels, "unlock")}
          </Button>
        ) : null}
        {user.invitePending && user.status === "active" ? (
          <Button type="button" variant="outline" disabled={r.pending} onClick={() => void r.run(() => resendInvite({ userId: user.id }), lab(labels, "invite_resent"))}>
            {lab(labels, "resend_invite")}
          </Button>
        ) : null}
        <Button type="button" variant="outline" disabled={r.pending} onClick={() => void r.run(() => revokeAllSessions({ userId: user.id }), lab(labels, "sessions_revoked"))}>
          {lab(labels, "revoke_all")}
        </Button>
      </div>
      {user.mfaEnrolled ? (
        <div className="grid gap-2 rounded-md border p-3">
          <FormField label={lab(labels, "reset_mfa_reason")}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={500} />
          </FormField>
          <div>
            <Button type="button" variant="destructive" disabled={r.pending || reason.trim().length < 5} onClick={() => void r.run(() => resetUserMfa({ userId: user.id, reason }), lab(labels, "mfa_reset_done"))}>
              {lab(labels, "reset_mfa")}
            </Button>
          </div>
        </div>
      ) : null}
      <Feedback ok={r.ok} error={r.error} />
    </div>
  );
}

export function RevokeSessionButton({ sessionId, labels, errors }: { sessionId: string; labels: Labels; errors: Labels }) {
  const r = useRun(errors);
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={r.pending} onClick={() => void r.run(() => revokeSession({ sessionId }), null)}>
        {lab(labels, "revoke")}
      </Button>
      {r.error ? (
        <span role="alert" className="text-xs text-destructive">
          {r.error}
        </span>
      ) : null}
    </span>
  );
}
