"use client";
/**
 * The staff actions of `/admin/memberships/[membershipId]` (credits spec section 5, rules 53 to
 * 55): cancel at period end or now (with a reason), resume, extend the period (the V1 pause),
 * retry the renewal charge and the staff notes. Each posts the membership `version` it was shown,
 * so a change made meanwhile is refused as stale. Strings arrive as props.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Checkbox, FormField, Input, Label, Textarea } from "@beam/ui";
import { cancelMembership, extendMembershipPeriod, resumeMembership, retryRenewalCharge, updateMembershipNotes } from "../actions";
import { ActionDialog, errorMessage, ReasonField, type ActionResultLike, type Labels, str } from "./adjust-dialog";

export type MembershipActionState = {
  membershipId: string;
  version: number;
  status: "pending" | "active" | "past_due" | "cancelled" | "expired";
  cancelAt: string | null;
  periodEndText: string;
  canRetry: boolean;
};

export function MembershipActions({ m, labels: l }: { m: MembershipActionState; labels: Labels }) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = (k: string) => l[`admin.membership.${k}`] ?? k;
  const live = m.status === "active" || m.status === "past_due" || m.status === "pending";
  const periodEndAllowed = m.status === "active" && !m.cancelAt;

  async function simple(run: () => Promise<ActionResultLike>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await run();
      if (r.ok) {
        if (done) setNotice(done);
        router.refresh();
      } else setError(errorMessage(r.error, l));
    } catch {
      setError(l["errors.generic"] ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
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
      <div className="flex flex-wrap gap-2">
        {live ? (
          <ActionDialog
            trigger={t("cancel")}
            title={t("cancel_title")}
            description={t("cancel_description")}
            submitLabel={t("cancel_submit")}
            destructive
            labels={l}
            onSubmit={(f) =>
              cancelMembership({
                membershipId: m.membershipId,
                mode: str(f, "mode", "now"),
                reason: str(f, "reason", ""),
                version: m.version,
              })
            }
          >
            {(fields) => (
              <>
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-medium">{t("mode")}</legend>
                  {periodEndAllowed ? (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name="mode" value="period_end" defaultChecked />
                      {t("mode_period_end").replace("{date}", m.periodEndText)}
                    </label>
                  ) : null}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="mode" value="now" defaultChecked={!periodEndAllowed} />
                    {t("mode_now")}
                  </label>
                </fieldset>
                <ReasonField labels={l} error={fields.reason} />
              </>
            )}
          </ActionDialog>
        ) : null}
        {m.status === "active" && m.cancelAt ? (
          <Button variant="outline" disabled={busy} onClick={() => void simple(() => resumeMembership({ membershipId: m.membershipId, version: m.version }))}>
            {t("resume")}
          </Button>
        ) : null}
        {m.status === "active" || m.status === "past_due" ? (
          <ActionDialog
            trigger={t("extend")}
            title={t("extend_title")}
            description={t("extend_description")}
            submitLabel={t("extend_submit")}
            labels={l}
            onSubmit={(f, clientKey) =>
              extendMembershipPeriod({
                membershipId: m.membershipId,
                days: Number(f.get("days")),
                reason: str(f, "reason", ""),
                alsoExtendInclusions: f.get("alsoExtendInclusions") === "on",
                clientKey,
                version: m.version,
              })
            }
          >
            {(fields) => (
              <>
                <FormField label={t("days")} error={fields.days ?? null} required>
                  <Input name="days" type="number" min={1} max={90} step={1} required inputMode="numeric" />
                </FormField>
                <div className="flex items-center gap-2">
                  <Checkbox id="alsoExtendInclusions" name="alsoExtendInclusions" />
                  <Label htmlFor="alsoExtendInclusions">{t("also_inclusions")}</Label>
                </div>
                <ReasonField labels={l} error={fields.reason} />
              </>
            )}
          </ActionDialog>
        ) : null}
        {m.canRetry ? (
          <Button variant="outline" disabled={busy} onClick={() => void simple(() => retryRenewalCharge({ membershipId: m.membershipId }), t("retry_done"))}>
            {t("retry")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function MembershipNotes({ membershipId, version, notes, labels: l }: { membershipId: string; version: number; notes: string | null; labels: Labels }) {
  const router = useRouter();
  const [state, setState] = useState<{ error?: string; saved?: boolean }>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setState({});
    try {
      const r = await updateMembershipNotes({ membershipId, notes: str(new FormData(e.currentTarget), "notes", ""), version });
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
      <FormField label={l["admin.membership.notes"]} hint={l["admin.membership.notes_hint"]} error={state.error ?? null}>
        <Textarea name="notes" defaultValue={notes ?? ""} maxLength={2000} rows={4} />
      </FormField>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? l["admin.common.saving"] : l["admin.membership.notes_save"]}
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
