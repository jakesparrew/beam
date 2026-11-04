/**
 * The reception quick view (crm spec 5.1, rules 3.54 and 3.55, cross-module D15): name, customer
 * number, status and member badge, minor flag, tags, the emergency contact and the three
 * declaration states. Rendered in the 360 header and, through crm's api, on booking's check-in
 * desk. A server-compatible component without hooks; every string is a prop
 * (`receptionCardLabels(tr)` builds them from the `crm.reception` catalogue).
 */
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import type { PersonStatus } from "@beam/core/crm";

export type ReceptionCardView = {
  name: string;
  customerNumber: string;
  status: PersonStatus;
  isMember: boolean;
  tags: string[];
  emergencyContact: { name: string; phone: string } | null;
  declarations: { termsAccepted: boolean; healthDeclarationValid: boolean; guardianConsentValid: boolean };
  isMinor: boolean;
};

export type ReceptionCardLabels = {
  title: string;
  member: string;
  minor: string;
  tags: string;
  emergencyContact: string;
  noEmergencyContact: string;
  termsAccepted: string;
  termsMissing: string;
  healthValid: string;
  healthMissing: string;
  guardianValid: string;
  guardianMissing: string;
  statuses: Record<PersonStatus, string>;
};

/** The labels from the `crm.reception` and `crm.enums.person_status` catalogue keys. */
export function receptionCardLabels(tr: (key: string) => string): ReceptionCardLabels {
  const r = (k: string) => tr(`crm.reception.${k}`);
  return {
    title: r("title"),
    member: r("member"),
    minor: r("minor"),
    tags: r("tags"),
    emergencyContact: r("emergency_contact"),
    noEmergencyContact: r("no_emergency_contact"),
    termsAccepted: r("terms_accepted"),
    termsMissing: r("terms_missing"),
    healthValid: r("health_valid"),
    healthMissing: r("health_missing"),
    guardianValid: r("guardian_valid"),
    guardianMissing: r("guardian_missing"),
    statuses: {
      lead: tr("crm.enums.person_status.lead"),
      customer: tr("crm.enums.person_status.customer"),
      member: tr("crm.enums.person_status.member"),
    },
  };
}

function State({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <li className="flex items-center gap-2 text-sm" data-state={ok ? "ok" : "missing"}>
      <span aria-hidden="true" className={ok ? "text-success" : "text-destructive"}>
        {ok ? "✓" : "✕"}
      </span>
      <span>{ok ? yes : no}</span>
    </li>
  );
}

export function ReceptionCard({ card, labels, compact = false }: { card: ReceptionCardView; labels: ReceptionCardLabels; compact?: boolean }) {
  return (
    <Card data-testid="reception-card" className={compact ? "gap-2 py-3" : undefined}>
      <CardHeader>
        <CardTitle className="text-base">{labels.title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{card.name || "—"}</span>
          <span className="text-sm text-muted-foreground">{card.customerNumber}</span>
          <Badge variant="outline">{labels.statuses[card.status]}</Badge>
          {card.isMember ? <Badge variant="success">{labels.member}</Badge> : null}
          {card.isMinor ? <Badge variant="warning">{labels.minor}</Badge> : null}
        </div>
        {card.tags.length ? (
          <div className="flex flex-wrap items-center gap-1" aria-label={labels.tags}>
            {card.tags.map((t) => (
              <Badge key={t} variant="secondary">
                {t}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="text-sm">
          <span className="text-muted-foreground">{labels.emergencyContact}: </span>
          {card.emergencyContact ? (
            <span>
              {card.emergencyContact.name} · <a href={`tel:${card.emergencyContact.phone}`}>{card.emergencyContact.phone}</a>
            </span>
          ) : (
            <span>{labels.noEmergencyContact}</span>
          )}
        </div>
        <ul className="grid gap-1">
          <State ok={card.declarations.termsAccepted} yes={labels.termsAccepted} no={labels.termsMissing} />
          <State ok={card.declarations.healthDeclarationValid} yes={labels.healthValid} no={labels.healthMissing} />
          {card.isMinor ? <State ok={card.declarations.guardianConsentValid} yes={labels.guardianValid} no={labels.guardianMissing} /> : null}
        </ul>
      </CardContent>
    </Card>
  );
}
