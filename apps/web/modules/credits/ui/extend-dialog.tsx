"use client";
/** `extendGrant` (rules 31, 32): a later expiry date (end of that Brussels day) with a reason. */
import { FormField, Input } from "@beam/ui";
import { extendGrant } from "../actions";
import { ActionDialog, ReasonField, type Labels, str } from "./adjust-dialog";

export function ExtendDialog({ grantId, currentExpiresOn, labels: l }: { grantId: string; currentExpiresOn: string | null; labels: Labels }) {
  return (
    <ActionDialog
      trigger={l["admin.extend.open"]!}
      title={l["admin.extend.title"]!}
      description={l["admin.extend.description"]}
      submitLabel={l["admin.extend.submit"]!}
      labels={l}
      onSubmit={(f, clientKey) =>
        extendGrant({ grantId, newExpiresAt: str(f, "newExpiresAt", ""), reason: str(f, "reason", ""), clientKey })
      }
    >
      {(fields) => (
        <>
          <FormField label={l["admin.extend.new_date"]} error={fields.newExpiresAt ?? null} required>
            <Input name="newExpiresAt" type="date" required min={currentExpiresOn ?? undefined} />
          </FormField>
          <ReasonField labels={l} error={fields.reason} />
        </>
      )}
    </ActionDialog>
  );
}
