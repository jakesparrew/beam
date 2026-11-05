"use client";
/**
 * The sharing section of one package (credits rules 40 to 42, R2).
 *
 * - `variant="portal"` (`/[locale]/account/packages/[grantId]`, owner of a `named` package): the
 *   people it is shared with (first name and initial, limit, used, status), "Stop sharing"
 *   (`revokeMyPackageShare`) and the invite form while fewer than 5 shares are active.
 * - `variant="staff"` (the staff grant screen, `credits.adjust`): the sharing mode and monthly
 *   guest limit (`updateGrantSharing`), the named shares with full names (`revokePackageShare`) and
 *   the staff invite form (`addPackageShare`). Without `canEdit` the panel is read-only.
 *
 * The host page formats every row and passes every string (`creditsLabels` of `admin.common`,
 * `errors`, `enum.sharing_mode`, `portal.sharing` and, for staff, `admin.sharing`).
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Badge, Button, FormField, Input, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { revokeMyPackageShare, revokePackageShare, updateGrantSharing } from "../actions";
import { ActionDialog, fill, str, type Labels } from "./adjust-dialog";
import { ShareInviteForm, sharingError } from "./share-invite-form";

export type ShareView = {
  shareId: string;
  name: string;
  /** "at most 3" or "up to what is left", formatted by the page. */
  limitText: string;
  /** Units the person used, formatted by the page (portal). */
  usedText?: string;
  status: "active" | "revoked";
  sinceText: string;
};

export type SharingSettingsView = { mode: "none" | "guests" | "named"; maxGuestUsesPerMonth: number; shareable: boolean };

export function SharingPanel({
  grantId,
  variant,
  shares,
  canAdd,
  canEdit,
  notice,
  settings,
  labels: l,
}: {
  grantId: string;
  variant: "portal" | "staff";
  shares: ShareView[];
  /** The invite form is shown (portal: mode named, active, fewer than 5 active shares). */
  canAdd: boolean;
  /** Staff hold `credits.adjust` (portal: always true for the owner). */
  canEdit: boolean;
  /** A line shown instead of the form (limit reached, not shareable). */
  notice?: string | null;
  settings?: SharingSettingsView;
  labels: Labels;
}) {
  const g = variant === "portal" ? "portal.sharing" : "admin.sharing";
  const titleId = `sharing-${grantId}`;
  return (
    <section aria-labelledby={titleId} className="grid gap-4">
      <h2 id={titleId} className="text-lg font-semibold">
        {l[`${g}.title`]}
      </h2>
      {variant === "portal" && l["portal.sharing.intro"] ? <p className="max-w-prose text-sm text-muted-foreground">{l["portal.sharing.intro"]}</p> : null}
      {variant === "staff" && settings ? <SharingSettingsForm grantId={grantId} settings={settings} canEdit={canEdit} labels={l} /> : null}
      {shares.length === 0 ? (
        <p className="text-sm text-muted-foreground">{variant === "portal" ? l["portal.sharing.empty"] : l["admin.grant.shares_empty"] ?? l["portal.sharing.empty"]}</p>
      ) : (
        <Table>
          <TableCaption>{variant === "portal" ? l["portal.sharing.list_caption"] : l["admin.sharing.shares_caption"]}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{l[`${g}.col_name`]}</TableHead>
              <TableHead scope="col">{l[`${g}.col_limit`]}</TableHead>
              {variant === "portal" ? <TableHead scope="col">{l["portal.sharing.col_used"]}</TableHead> : <TableHead scope="col">{l["admin.sharing.col_since"]}</TableHead>}
              <TableHead scope="col">{l[`${g}.col_status`]}</TableHead>
              {canEdit ? (
                <TableHead scope="col">
                  <span className="sr-only">{l[`${g}.revoke`]}</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shares.map((s) => (
              <TableRow key={s.shareId}>
                <TableCell>{s.name}</TableCell>
                <TableCell>{s.limitText}</TableCell>
                <TableCell>{variant === "portal" ? (s.usedText ?? "") : s.sinceText}</TableCell>
                <TableCell>
                  <Badge variant={s.status === "active" ? "default" : "secondary"}>{l[`${g}.status_${s.status}`]}</Badge>
                </TableCell>
                {canEdit ? (
                  <TableCell>
                    {s.status === "active" ? (
                      <ActionDialog
                        trigger={l[`${g}.revoke`] ?? ""}
                        title={fill(l[`${g}.revoke_label`], { name: s.name })}
                        description={variant === "portal" ? fill(l["portal.sharing.revoke_confirm"], { name: s.name }) : undefined}
                        submitLabel={l[`${g}.revoke`] ?? ""}
                        destructive
                        labels={l}
                        onSubmit={() => (variant === "portal" ? revokeMyPackageShare({ shareId: s.shareId }) : revokePackageShare({ shareId: s.shareId }))}
                      >
                        {() => null}
                      </ActionDialog>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {notice ? <p className="text-sm">{notice}</p> : null}
      {canAdd && canEdit ? <ShareInviteForm grantId={grantId} variant={variant} labels={l} /> : null}
    </section>
  );
}

/** Staff: the grant's sharing mode and monthly guest limit (rule 40). */
function SharingSettingsForm({ grantId, settings, canEdit, labels: l }: { grantId: string; settings: SharingSettingsView; canEdit: boolean; labels: Labels }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ error?: string; saved?: boolean }>({});
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    setState({});
    try {
      const mode = str(f, "mode", settings.mode) as SharingSettingsView["mode"];
      const r = await updateGrantSharing({ grantId, mode, maxGuestUsesPerMonth: Number(str(f, "maxGuestUsesPerMonth", "0")) });
      if (r.ok) {
        setState({ saved: true });
        router.refresh();
      } else setState({ error: sharingError(r.error, l) });
    } catch {
      setState({ error: l["errors.generic"] });
    } finally {
      setBusy(false);
    }
  }
  const modes = ["none", "guests", "named"] as const;
  const disabled = !canEdit || !settings.shareable;
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" noValidate>
      <FormField label={l["admin.sharing.mode"]}>
        <select name="mode" defaultValue={settings.mode} disabled={disabled} className="min-h-11 rounded-md border bg-background px-3">
          {modes.map((m) => (
            <option key={m} value={m}>
              {l[`enum.sharing_mode.${m}`] ?? m}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label={l["admin.sharing.max_guests"]} hint={l["admin.sharing.max_guests_hint"]}>
        <Input name="maxGuestUsesPerMonth" type="number" inputMode="numeric" min={0} max={31} defaultValue={settings.maxGuestUsesPerMonth} disabled={disabled} />
      </FormField>
      {canEdit && settings.shareable ? (
        <Button type="submit" disabled={busy} className="w-fit">
          {busy ? l["admin.common.saving"] : l["admin.sharing.save"]}
        </Button>
      ) : null}
      {!settings.shareable ? <p className="text-sm text-muted-foreground sm:col-span-3">{l["admin.sharing.not_shareable"]}</p> : null}
      {state.error ? (
        <Alert variant="destructive" role="alert" className="sm:col-span-3">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.saved ? (
        <p role="status" className="text-sm sm:col-span-3">
          {l["admin.sharing.saved"]}
        </p>
      ) : null}
    </form>
  );
}
