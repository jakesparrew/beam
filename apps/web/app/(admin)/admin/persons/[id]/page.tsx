import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { buttonVariants } from "@beam/ui";
import { CONSENT_PURPOSES, MARKETING_PURPOSES, TIMELINE_CATEGORIES, type MarketingPurpose } from "@beam/core/crm";
import { formatDate, formatMoney, type Locale } from "@beam/core/i18n";
import { SENSITIVE_FIELD_KEYS } from "@beam/core/privacy";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listPersonEnrolments, PersonAutomationsPanel } from "@/modules/automation/api";
import { listPersonBookings, listOpenOffersForPerson } from "@/modules/booking/api";
import { listPersonOrders } from "@/modules/commerce/api";
import { getMembershipSummary, getPersonCreditSummary } from "@/modules/credits/api";
import { PersonEmailHistory } from "@/modules/email/api";
import { listInvoicesForPerson } from "@/modules/finance/api";
import { getPersonStats } from "@/modules/ops/api";
import { getCurrentLegalVersion } from "@/modules/site/api";
import { listStaffForAssignment } from "@/modules/platform/api";
import { getPersonConsentPanel } from "@/modules/crm/consent/queries";
import { listPersonDeclarations } from "@/modules/crm/declarations/queries";
import { getPerson360, listPersonSegments } from "@/modules/crm/person360/queries";
import { listTasks, taskListLabels, toTaskView } from "@/modules/crm/tasks/queries";
import { getTimeline, toTimelineRows } from "@/modules/crm/timeline/queries";
import { ConsentPanel } from "@/modules/crm/ui/consent-panel";
import { DeclarationCard } from "@/modules/crm/ui/declaration-card";
import { ActionBlock, InteractionForm, NoteForm, PersonHeader } from "@/modules/crm/ui/person-360/header";
import { KpiStrip } from "@/modules/crm/ui/person-360/kpi-strip";
import { OverrideBanner, StatusOverrideForm } from "@/modules/crm/ui/person-360/override-banner";
import { ListPanel, NodePanel, PanelGrid, type PanelRow } from "@/modules/crm/ui/person-360/panels";
import { receptionCardLabels } from "@/modules/crm/ui/person-360/reception-card";
import { safePanel, type SafeResult } from "@/modules/crm/ui/person-360/safe-panel";
import { SensitivePanel } from "@/modules/crm/ui/sensitive-panel";
import { TaskList } from "@/modules/crm/ui/task-list";
import { Timeline } from "@/modules/crm/ui/timeline/timeline";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rowsOr = <T,>(r: SafeResult<T[]>, map: (v: T) => PanelRow): PanelRow[] | null => (r.ok ? r.value.map(map) : null);
const textOf = (v: Record<string, string | undefined> | null | undefined, locale: Locale): string => (v ? (v[locale] ?? Object.values(v).find(Boolean) ?? "") : "");

/**
 * `/admin/persons/[id]`, the customer 360 (`persons.read`; each action its own permission), crm
 * spec 5.1: header with the reception quick view, KPI strip, actions, the panels of every module
 * (each foreign panel through `safePanel()`, so a stub shows "Not available yet"), consents,
 * guardian consent, the sensitive panel (only with `persons.sensitive_read`) and the timeline
 * with category chips and infinite scroll. A merged id redirects to its winner.
 */
export default async function Person360Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = await getAppDb();
  const data = await getPerson360(db, id);
  if (!data) notFound();
  if (data.redirectTo && data.redirectTo !== id) redirect(`/admin/persons/${data.redirectTo}` as never);

  const locale = await adminLocale();
  const tr = translator(locale);
  const h = (k: string, p?: Record<string, string | number>) => tr(`crm.person360.header.${k}`, p);
  const pl = (k: string) => tr(`crm.person360.panels.${k}`);
  const a = (k: string) => tr(`crm.person360.actions.${k}`);
  const na = pl("not_available");
  const canWrite = hasPermission(actor, "persons.write");
  const canSensitive = hasPermission(actor, "persons.sensitive_read");
  const canMerge = hasPermission(actor, "persons.merge");
  const canAllTasks = hasPermission(actor, "tasks.all");
  const { person, status } = data;
  const statusLabel = (s: string) => tr(`crm.enums.person_status.${s}`);
  const date = (d: Date | string | null | undefined) => (d ? formatDate(d, locale) : null);
  const money = (cents: number) => formatMoney(cents, locale);

  const [credits, membership, bookings, offers, orders, invoices, stats, enrolments, emails, automationsNode, segmentsOfPerson, tasks, staff, consent, declarations, guardianVersion, timeline] =
    await Promise.all([
      safePanel(() => getPersonCreditSummary(db, person.id)),
      safePanel(() => getMembershipSummary(db, person.id)),
      safePanel(() => listPersonBookings(db, person.id, { limit: 20 })),
      safePanel(() => listOpenOffersForPerson(db, person.id)),
      safePanel(() => listPersonOrders(db, person.id, { limit: 20 })),
      safePanel(() => listInvoicesForPerson(db, person.id)),
      safePanel(() => getPersonStats(db, person.id)),
      safePanel(() => listPersonEnrolments(db, person.id)),
      safePanel(() => Promise.resolve<ReactNode>(PersonEmailHistory({ personId: person.id }))),
      safePanel(() => Promise.resolve<ReactNode>(PersonAutomationsPanel({ personId: person.id }))),
      safePanel(() => listPersonSegments(db, person.id)),
      safePanel(() => listTasks(db, { userId: actor.userId, scope: canAllTasks ? "all" : "mine", personId: person.id, status: "open" })),
      safePanel(() => listStaffForAssignment(db, { permission: "persons.read" })),
      safePanel(() => getPersonConsentPanel(db, person.id)),
      safePanel(() => listPersonDeclarations(db, person.id)),
      safePanel(() => getCurrentLegalVersion(db, "guardian_consent")),
      safePanel(async () => {
        const page = await getTimeline(db, { personId: person.id, limit: 50 });
        return { rows: await toTimelineRows(db, page.items, locale), next: page.nextBefore ? { occurredAt: page.nextBefore.occurredAt.toISOString(), id: page.nextBefore.id } : null };
      }),
    ]);

  const addr = person.address;
  const address = addr ? [[addr.street, addr.number, addr.box].filter(Boolean).join(" "), [addr.postal_code, addr.city].filter(Boolean).join(" "), addr.country].filter(Boolean).join(", ") : null;
  const acq = person.acquisition as { source?: string; campaign?: string; captured_at?: string };
  const banners = [person.erasedAt ? tr("crm.person360.banners.erased") : null, person.processingRestrictedAt ? tr("crm.person360.banners.restricted") : null].filter((b): b is string => !!b);
  const reception = receptionCardLabels(tr);

  const stat = stats.ok ? stats.value : null;
  const kpis = stat
    ? [
        { key: "revenue", label: pl("revenue"), value: money(stat.revenueCents) },
        { key: "purchases", label: pl("purchases"), value: String(stat.purchases) },
        { key: "visits", label: pl("visits"), value: String(stat.visits) },
        { key: "no_shows", label: pl("no_shows"), value: String(stat.noShows) },
        { key: "last_visit", label: pl("last_visit"), value: date(stat.lastVisitAt) ?? "—" },
        { key: "ltv", label: pl("ltv"), value: money(stat.predictedValueCents ?? stat.revenueCents) },
      ]
    : null;

  const staffList = staff.ok ? staff.value : [];
  const self = staffList.find((s) => s.userId === actor.userId);
  const owners = canAllTasks ? staffList.map((s) => ({ value: s.userId, label: s.name })) : [{ value: actor.userId, label: self?.name ?? tr("crm.tasks.tab_mine") }];

  const purposeLabel = (p: string) => tr(`crm.enums.consent_purpose.${p}`);
  const c = (k: string) => tr(`crm.consentPanel.${k}`);
  const latestDecl = declarations.ok ? (declarations.value[0] ?? null) : null;
  const v = (k: string) => tr(`crm.person360.timeline_ui.${k}`);

  return (
    <div className="grid gap-6" data-testid="person-360">
      {status.showConflictBanner && status.override ? (
        <OverrideBanner
          personId={person.id}
          labels={{
            message: tr("crm.person360.banners.override_conflict", { override: statusLabel(status.override), derived: statusLabel(status.derivedStatus) }),
            keep: tr("crm.person360.banners.keep"),
            clear: tr("crm.person360.banners.clear_override"),
            reason: a("override_reason"),
            error: tr("crm.common.error"),
          }}
        />
      ) : null}

      <PersonHeader
        view={{
          id: person.id,
          name: person.name,
          customerNumberLabel: h("customer_number", { customerNumber: person.customerNumber }),
          statusLabel: statusLabel(status.status),
          derivedLabel: status.override ? h("status_derived", { status: statusLabel(status.derivedStatus) }) : null,
          overrideLabel: status.override ? h("status_override", { status: statusLabel(status.override) }) : null,
          isMember: status.isMember,
          isTester: person.isTester,
          localeLabel: tr(`crm.enums.locale.${person.locale.replace("-", "_")}`),
          email: person.email,
          phone: person.phone,
          address,
          birthOn: date(person.birthOn),
          acquisition: {
            source: acq.source ? tr(`crm.enums.acquisition_source.${acq.source}`) : null,
            campaign: acq.campaign ?? null,
            date: acq.captured_at ? h("acquired_on", { date: date(acq.captured_at) ?? "" }) : null,
          },
          partner: person.partnerCompany,
          companies: data.companies.map((co) => ({ id: co.companyId, name: co.name, position: co.position })),
          tags: data.tags.map((t) => ({ key: t.key, label: textOf(t.name, locale) || t.key, color: t.color })),
          emergencyContact: person.emergencyContact,
          banners,
          reception: data.reception,
        }}
        labels={{
          member: h("member"),
          tester: tr("crm.person360.header.tester"),
          locale: h("locale"),
          contact: h("contact"),
          acquisition: h("acquisition"),
          campaign: h("acquisition_campaign"),
          partner: h("partner"),
          companies: h("companies"),
          emergencyContact: h("emergency_contact"),
          noEmergencyContact: h("no_emergency_contact"),
          tags: tr("crm.person360.actions.tag"),
          birthOn: tr("crm.person360.header.birth_on"),
          reception,
        }}
      />

      <KpiStrip title={pl("kpis")} items={kpis} notAvailable={na} />

      <nav className="flex flex-wrap gap-2" aria-label={tr("crm.common.actions")}>
        {canWrite ? (
          <Link href={`/admin/persons/${person.id}/edit` as never} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {a("edit")}
          </Link>
        ) : null}
        {canMerge ? (
          <Link href={"/admin/persons/duplicates"} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {a("merge_with")}
          </Link>
        ) : null}
        <Link href={"/admin/sessions"} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {a("book")}
        </Link>
      </nav>

      {canWrite && !person.erasedAt ? (
        <div className="grid gap-3 md:grid-cols-2">
          <ActionBlock title={a("add_note")} testId="action-note">
            <NoteForm
              personId={person.id}
              canSensitive={canSensitive}
              labels={{ title: a("add_note"), body: a("note_body"), sensitive: a("note_sensitive"), save: tr("crm.common.save"), saved: tr("crm.common.saved"), error: tr("crm.common.error") }}
            />
          </ActionBlock>
          <ActionBlock title={a("log_interaction")} testId="action-interaction">
            <InteractionForm
              personId={person.id}
              labels={{
                title: a("log_interaction"),
                channel: a("interaction_channel"),
                purpose: a("interaction_purpose"),
                summary: a("interaction_summary"),
                occurredAt: a("interaction_occurred_at"),
                save: tr("crm.common.save"),
                saved: tr("crm.common.saved"),
                error: tr("crm.common.error"),
                channels: Object.fromEntries(["call", "email", "whatsapp", "in_person", "meeting", "other"].map((k) => [k, tr(`crm.enums.interaction_channel.${k}`)])),
                purposes: Object.fromEntries(["service", "sales_follow_up", "reactivation", "b2b"].map((k) => [k, tr(`crm.enums.interaction_purpose.${k}`)])),
              }}
            />
          </ActionBlock>
          <ActionBlock title={status.override ? a("clear_override") : a("set_override")} testId="action-override">
            <StatusOverrideForm
              personId={person.id}
              current={status.override}
              labels={{
                title: a("set_override"),
                status: a("set_override"),
                none: a("clear_override"),
                reason: a("override_reason"),
                save: tr("crm.common.save"),
                error: tr("crm.common.error"),
                statuses: { lead: statusLabel("lead"), customer: statusLabel("customer"), member: statusLabel("member") },
              }}
            />
          </ActionBlock>
        </div>
      ) : null}

      <PanelGrid>
        <ListPanel
          title={pl("credits")}
          testId="panel-credits"
          rows={credits.ok ? credits.value.byKind.map((k) => ({ id: k.kind, primary: tr(`crm.person360.credit_kinds.${k.kind}`), secondary: k.nextExpiresAt ? date(k.nextExpiresAt) : null, badge: String(k.remainingUnits) })) : null}
          empty={tr("crm.common.none")}
          notAvailable={na}
        />
        <ListPanel
          title={pl("membership")}
          testId="panel-membership"
          rows={membership.ok ? (membership.value ? [{ id: "membership", primary: textOf(membership.value.productName, locale), secondary: date(membership.value.currentPeriodEndAt), badge: membership.value.status }] : []) : null}
          empty={tr("crm.common.none")}
          notAvailable={na}
        />
        <ListPanel
          title={pl("bookings")}
          testId="panel-bookings"
          rows={rowsOr(bookings, (b) => ({ id: b.bookingId, primary: textOf(b.title, locale), secondary: date(b.startsAt), badge: b.status }))}
          empty={tr("crm.common.none")}
          notAvailable={na}
        />
        <ListPanel
          title={pl("waitlist")}
          testId="panel-waitlist"
          rows={rowsOr(offers, (o) => ({ id: o.entryId, primary: textOf(o.title, locale), secondary: date(o.startsAt), badge: date(o.offerExpiresAt) }))}
          empty={tr("crm.common.none")}
          notAvailable={na}
        />
        <ListPanel
          title={pl("orders")}
          testId="panel-orders"
          rows={rowsOr(orders, (o) => ({ id: o.orderId, primary: o.reference, secondary: `${date(o.paidAt ?? o.createdAt) ?? ""} · ${money(o.totalCents)}`, badge: o.status }))}
          empty={tr("crm.common.none")}
          notAvailable={na}
        />
        <ListPanel
          title={pl("invoices")}
          testId="panel-invoices"
          rows={rowsOr(invoices, (i) => ({ id: i.id, primary: i.number, secondary: `${date(i.issuedOn) ?? ""} · ${money(i.totalCents)}`, badge: i.status }))}
          empty={tr("crm.common.none")}
          notAvailable={na}
        />
        <ListPanel
          title={pl("automations")}
          testId="panel-automations"
          rows={rowsOr(enrolments, (e) => ({ id: e.enrolmentId, primary: e.automationName, secondary: e.nextStepAt ? `${e.nextStepKey ?? ""} · ${date(e.nextStepAt)}` : null, badge: e.status }))}
          empty={tr("crm.common.none")}
          notAvailable={na}
          footer={automationsNode.ok ? <div className="pt-3">{automationsNode.value}</div> : null}
        />
        <ListPanel
          title={pl("segments")}
          testId="panel-segments"
          rows={rowsOr(segmentsOfPerson, (s) => ({ id: s.id, primary: s.name, href: `/admin/segments/${s.id}`, badge: tr(`crm.enums.segment_kind.${s.kind}`) }))}
          empty={tr("crm.common.none")}
          notAvailable={na}
        />
      </PanelGrid>

      <section className="grid gap-3" aria-labelledby="tasks-heading">
        <h2 id="tasks-heading" className="text-lg font-semibold">
          {pl("tasks")}
        </h2>
        {tasks.ok ? (
          <TaskList tasks={tasks.value.map((t) => toTaskView(t, locale, tr))} currentUserId={actor.userId} canAssignOthers={canAllTasks} owners={owners} personId={person.id} labels={taskListLabels(tr)} />
        ) : (
          <p className="text-sm text-muted-foreground">{na}</p>
        )}
      </section>

      <NodePanel title={pl("emails")} node={emails.ok ? emails.value : null} notAvailable={na} testId="panel-emails" />

      {consent.ok ? (
        <ConsentPanel
          view={{
            personId: person.id,
            email: person.email,
            canWrite,
            purposes: CONSENT_PURPOSES.map((p) => {
              const cur = consent.value.current[p];
              const reachable = (MARKETING_PURPOSES as readonly string[]).includes(p) ? consent.value.reachable[p as MarketingPurpose] : null;
              return { purpose: p, label: purposeLabel(p), status: cur?.status ?? null, method: cur ? tr(`crm.enums.consent_method.${cur.method}`) : null, recordedAt: date(cur?.recordedAt), reachable };
            }),
            history: consent.value.history.map((r) => ({
              id: r.id,
              purposeLabel: purposeLabel(r.purpose),
              statusLabel: tr(`crm.enums.consent_status.${r.status}`),
              methodLabel: tr(`crm.enums.consent_method.${r.method}`),
              source: r.source,
              wordingVersion: r.wordingVersion,
              recordedAt: date(r.recordedAt) ?? "",
            })),
            suppressions: consent.value.suppressions.map((s) => ({ id: s.id, scopeLabel: tr(`crm.enums.suppression_scope.${s.scope}`), reasonLabel: tr(`crm.enums.suppression_reason.${s.reason}`), createdAt: date(s.createdAt) ?? "" })),
          }}
          labels={{
            title: pl("consents"),
            history: pl("consent_history"),
            suppressions: pl("suppressions"),
            none: tr("crm.common.none"),
            granted: tr("crm.enums.consent_status.granted"),
            withdrawn: tr("crm.enums.consent_status.withdrawn"),
            notRecorded: c("not_recorded"),
            reachable: c("reachable"),
            unreachable: c("unreachable"),
            grant: c("grant"),
            withdraw: c("withdraw"),
            unsubscribeAll: a("unsubscribe_all"),
            unsubscribeAllNote: c("unsubscribe_all_note"),
            error: tr("crm.common.error"),
            columns: { purpose: c("col_purpose"), status: c("col_status"), method: c("col_method"), source: c("col_source"), version: c("col_version"), date: c("col_date"), scope: c("col_scope"), reason: c("col_reason") },
          }}
        />
      ) : (
        <NodePanel title={pl("consents")} node={null} notAvailable={na} />
      )}

      {declarations.ok ? (
        <DeclarationCard
          view={{
            personId: person.id,
            isMinor: data.reception.isMinor,
            isValid: data.reception.declarations.guardianConsentValid,
            latestStatus: latestDecl?.status ?? null,
            canWrite,
            publishedVersion: guardianVersion.ok && guardianVersion.value ? guardianVersion.value.version : null,
            rows: declarations.value.map((d) => ({
              id: d.id,
              statusLabel: tr(`crm.enums.declaration_status.${d.status}`),
              methodLabel: tr(`crm.enums.declaration_method.${d.method}`),
              versionLabel: tr("crm.declarations.version", { version: d.documentVersion }),
              acceptedOn: tr("crm.declarations.accepted_on", { date: date(d.acceptedAt) ?? "" }),
              guardianName: d.guardianName,
            })),
            guardianOptions: [],
          }}
          labels={{
            title: tr("crm.declarations.title"),
            record: tr("crm.declarations.record"),
            revoke: tr("crm.declarations.revoke"),
            revokeReason: tr("crm.declarations.revoke_reason"),
            guardian: tr("crm.declarations.guardian"),
            guardianId: tr("crm.declarations.guardian_id"),
            valid: tr("crm.declarations.valid"),
            invalid: tr("crm.declarations.invalid"),
            none: tr("crm.declarations.none"),
            nonePublished: tr("crm.declarations.none_published"),
            minorNotice: tr("crm.declarations.minor_notice"),
            reacceptance: tr("crm.declarations.reacceptance"),
            method: tr("crm.declarations.method"),
            error: tr("crm.common.error"),
          }}
        />
      ) : null}

      {canSensitive ? (
        <SensitivePanel
          view={{
            personId: person.id,
            present: data.sensitiveKeys.map((s) => ({ key: s.key, label: tr(`crm.enums.sensitive_key.${s.key}`), updated: tr("crm.person360.sensitive.updated", { date: date(s.updatedAt) ?? "" }) })),
            options: SENSITIVE_FIELD_KEYS.map((k) => ({ key: k, label: tr(`crm.enums.sensitive_key.${k}`) })),
          }}
          labels={{
            title: pl("sensitive"),
            hidden: tr("crm.person360.sensitive.hidden"),
            reveal: tr("crm.person360.sensitive.reveal"),
            empty: tr("crm.person360.sensitive.empty"),
            value: tr("crm.person360.sensitive.value"),
            key: tr("crm.person360.sensitive.key"),
            save: tr("crm.common.save"),
            clear: tr("crm.person360.sensitive.clear"),
            edit: tr("crm.common.edit"),
            cancel: tr("crm.common.cancel"),
            error: tr("crm.common.error"),
          }}
        />
      ) : null}

      {timeline.ok ? (
        <Timeline
          personId={person.id}
          initialRows={timeline.value.rows}
          initialNext={timeline.value.next}
          chips={TIMELINE_CATEGORIES.map((k) => ({ key: k, label: tr(`crm.timeline.categories.${k}`) }))}
          canReveal={canSensitive}
          labels={{
            title: tr("crm.timeline.title"),
            empty: tr("crm.timeline.empty"),
            loadMore: tr("crm.timeline.load_more"),
            sensitiveNote: tr("crm.timeline.sensitive_note"),
            reveal: tr("crm.timeline.reveal"),
            all: v("all"),
            error: tr("crm.common.error"),
            loading: tr("crm.common.loading"),
          }}
        />
      ) : (
        <NodePanel title={tr("crm.timeline.title")} node={null} notAvailable={na} />
      )}
    </div>
  );
}
