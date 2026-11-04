"use client";
/** `revokeGrant` (rule 28): removes every remaining unit; the dialog states the count (formatted on the server). */
import { revokeGrant } from "../actions";
import { ActionDialog, ReasonField, type Labels, str } from "./adjust-dialog";

export function RevokeDialog({ grantId, description, labels: l }: { grantId: string; description: string; labels: Labels }) {
  return (
    <ActionDialog
      trigger={l["admin.revoke.open"]!}
      title={l["admin.revoke.title"]!}
      description={description}
      submitLabel={l["admin.revoke.submit"]!}
      destructive
      labels={l}
      onSubmit={(f, clientKey) => revokeGrant({ grantId, reason: str(f, "reason", ""), clientKey })}
    >
      {(fields) => <ReasonField labels={l} error={fields.reason} />}
    </ActionDialog>
  );
}
