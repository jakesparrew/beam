/**
 * Health declaration and night emergency contact (booking spec R62b).
 *
 * - Health: forms' `health-declaration` submission is the single source
 *   (`forms.hasValidSubmission`). When `settings.booking_rules.require_health_declaration` is
 *   true, a customer booking of kind `day` or `night` without a valid one is refused with
 *   `health_declaration_required`; otherwise the portal only shows a notice. Staff bookings and
 *   check-in are never blocked.
 * - Emergency contact: for a `night` booking, when `require_emergency_contact_for_nights` is
 *   true and the person has no `persons.emergency_contact`, a customer must send one
 *   (`emergency_contact_required` otherwise); a given contact is written through
 *   `crm.updatePersonFields(..., { onlyEmpty: true })` in the booking transaction. For staff the
 *   same fields are a non-blocking prompt.
 */
import type { Tx } from "@beam/db";
import { persons } from "@beam/db/schema";
import { BookingConflictError, type SessionKind } from "@beam/core/booking";
import { eq, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { updatePersonFields } from "@/modules/crm/api";
import { hasValidSubmission } from "@/modules/forms/api";

export const HEALTH_DECLARATION_FORM = "health-declaration";

export type EmergencyContactInput = { name: string; phone: string; relation?: string };

export type HealthAndContactOutcome = {
  /** null when the rule is off (the declaration was not looked up). */
  healthDeclaration: { valid: boolean; expiresAt: Date | null } | null;
  /** The person needs an emergency contact for this night and has none on file. */
  emergencyContactMissing: boolean;
  emergencyContactWritten: boolean;
};

const hasContact = (c: EmergencyContactInput | undefined): c is EmergencyContactInput => !!c && !!c.name.trim() && !!c.phone.trim();

export async function ensureHealthAndContact(
  tx: Tx,
  ctx: Ctx,
  input: { personId: string; kind: SessionKind; emergencyContact?: EmergencyContactInput; by: "customer" | "staff" },
): Promise<HealthAndContactOutcome> {
  const rules = await getSetting(tx, "booking_rules");
  const out: HealthAndContactOutcome = { healthDeclaration: null, emergencyContactMissing: false, emergencyContactWritten: false };

  if (rules.require_health_declaration && (input.kind === "day" || input.kind === "night")) {
    const health = await hasValidSubmission(tx, { personId: input.personId, formSlug: HEALTH_DECLARATION_FORM });
    out.healthDeclaration = { valid: health.valid, expiresAt: health.expiresAt };
    if (!health.valid && input.by === "customer") throw new BookingConflictError("health_declaration_required");
  }

  if (input.kind === "night" && rules.require_emergency_contact_for_nights) {
    const [person] = await tx.select({ emergencyContact: persons.emergencyContact }).from(persons).where(eq(persons.id, input.personId));
    const onFile = person?.emergencyContact as { name?: string; phone?: string } | null | undefined;
    if (!onFile?.name || !onFile.phone) {
      if (hasContact(input.emergencyContact)) {
        const contact = {
          name: input.emergencyContact.name.trim(),
          phone: input.emergencyContact.phone.trim(),
          ...(input.emergencyContact.relation?.trim() ? { relation: input.emergencyContact.relation.trim() } : {}),
        };
        const { changed } = await updatePersonFields(tx, ctx, input.personId, { emergencyContact: contact }, { onlyEmpty: true });
        out.emergencyContactWritten = changed.length > 0;
      } else if (input.by === "customer") {
        throw new BookingConflictError("emergency_contact_required");
      } else {
        out.emergencyContactMissing = true;
      }
    }
  }
  return out;
}
