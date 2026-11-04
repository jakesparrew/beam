/**
 * The commercial status badge (crm spec 5.1): lead, customer or member, with a pin when the
 * status was set by hand (rule 3.11) and an optional member badge. Every string is a prop.
 */
import { Badge } from "@beam/ui";
import type { PersonStatus } from "@beam/core/crm";

export type StatusBadgeLabels = {
  statuses: Record<PersonStatus, string>;
  overridePin: string;
  member?: string;
};

const VARIANT: Record<PersonStatus, "default" | "secondary" | "outline"> = { member: "default", customer: "secondary", lead: "outline" };

export function StatusBadge({
  status,
  isOverridden = false,
  derivedStatus,
  isMember = false,
  labels,
}: {
  status: PersonStatus;
  isOverridden?: boolean;
  derivedStatus?: PersonStatus;
  isMember?: boolean;
  labels: StatusBadgeLabels;
}) {
  const title = isOverridden && derivedStatus && derivedStatus !== status ? `${labels.overridePin}: ${labels.statuses[derivedStatus]}` : isOverridden ? labels.overridePin : undefined;
  return (
    <span className="inline-flex items-center gap-1" data-testid="person-status">
      <Badge variant={VARIANT[status]} title={title}>
        {isOverridden ? (
          <span aria-label={labels.overridePin} role="img" className="mr-1">
            📌
          </span>
        ) : null}
        {labels.statuses[status]}
      </Badge>
      {isMember && labels.member && status !== "member" ? <Badge variant="default">{labels.member}</Badge> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Server-side label sets of the person screens (client components receive strings only)
// ---------------------------------------------------------------------------

type Tr = (key: string, params?: Record<string, string | number>) => string;

export function statusBadgeLabels(tr: Tr): StatusBadgeLabels {
  return {
    statuses: { lead: tr("crm.enums.person_status.lead"), customer: tr("crm.enums.person_status.customer"), member: tr("crm.enums.person_status.member") },
    overridePin: tr("crm.persons.list.override_pin"),
    member: tr("crm.persons.list.col_member"),
  };
}

/** `nl-BE` → `crm.enums.locale.nl_BE`. */
export function localeOptions(tr: Tr): { value: string; label: string }[] {
  return (["nl-BE", "fr-BE", "en"] as const).map((l) => ({ value: l, label: tr(`crm.enums.locale.${l.replace("-", "_")}`) }));
}

export function channelOptions(tr: Tr): { value: string; label: string }[] {
  return (["email", "phone", "whatsapp"] as const).map((c) => ({ value: c, label: tr(`crm.enums.preferred_channel.${c}`) }));
}

export function sourceOptions(tr: Tr, sources: readonly string[]): { value: string; label: string }[] {
  return sources.map((s) => ({ value: s, label: tr(`crm.enums.acquisition_source.${s}`) }));
}

/** Labels of `PersonForm` (create and edit). `emailTaken` stays a template with `{customerNumber}`. */
export function personFormLabels(tr: Tr, template: (key: string) => string) {
  const n = (k: string) => tr(`crm.persons.new.${k}`);
  const e = (k: string) => tr(`crm.persons.edit.${k}`);
  return {
    firstName: n("first_name"),
    lastName: n("last_name"),
    email: n("email"),
    phone: n("phone"),
    locale: n("locale"),
    address: n("address"),
    street: n("street"),
    number: n("number"),
    box: n("box"),
    postalCode: n("postal_code"),
    city: n("city"),
    country: n("country"),
    birthOn: n("birth_on"),
    preferredChannel: n("preferred_channel"),
    acquisitionSource: n("acquisition_source"),
    acquisitionCampaign: n("acquisition_campaign"),
    linkedinUrl: e("linkedin_url"),
    emergencyContact: e("emergency_contact"),
    emergencyName: e("emergency_name"),
    emergencyPhone: e("emergency_phone"),
    emergencyRelation: e("emergency_relation"),
    needIdentity: n("need_identity"),
    duplicatesTitle: n("duplicates_title"),
    duplicatesIntro: n("duplicates_intro"),
    openExisting: n("open_existing"),
    createAnyway: n("create_anyway"),
    emailTaken: template("crm.persons.edit.email_taken"),
    openMerge: e("open_merge"),
    loginTaken: e("login_taken"),
    staleVersion: tr("crm.common.stale_version"),
    reload: tr("crm.common.reload"),
    save: tr("crm.common.save"),
    saving: tr("crm.common.saving"),
    saved: tr("crm.common.saved"),
    cancel: tr("crm.common.cancel"),
    none: tr("crm.common.none"),
    error: tr("crm.common.error"),
    reasons: Object.fromEntries(["external_id", "email_variant", "phone", "name_birth", "name_postal"].map((r) => [r, tr(`crm.enums.duplicate_reason.${r}`)])),
  };
}
