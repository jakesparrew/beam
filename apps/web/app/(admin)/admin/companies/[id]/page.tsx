import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CompanyStatus } from "@beam/core/crm";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listStaffForAssignment } from "@/modules/platform/api";
import { getCompany, getTimeline, listTasks } from "@/modules/crm/queries";
import { companyFormLabels, companyOptions, contactListLabels } from "@/modules/crm/companies/queries";
import { brusselsLocal, taskListLabels, toTaskView } from "@/modules/crm/tasks/queries";
import { toTimelineRows } from "@/modules/crm/timeline/queries";
import { CompanyForm } from "@/modules/crm/ui/company-form";
import { ContactList } from "@/modules/crm/ui/contact-list";
import { TaskList } from "@/modules/crm/ui/task-list";
import { PageHeader, Segmented, StatusPill, Surface, type Tone } from "@/modules/platform/ui/admin-kit";
import { BackLink, KpiStrip } from "@/modules/platform/ui/admin-list-kit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPANY_TONE: Record<CompanyStatus, Tone> = { target: "muted", prospect: "info", customer: "ok", partner: "gold", inactive: "muted" };
type Tab = "contacts" | "details" | "tasks" | "timeline" | "referred";

/**
 * `/admin/companies/[id]` (`persons.read`; edit `crm.b2b`), crm spec 5.1, as a detail page in the
 * back-office kit (owner review, November 2026): the header (name, VAT number, status and partner
 * pills), a KPI strip (current contacts, open tasks, referred persons for a partner), then tabs
 * (`?tab=`): contacts (ended ones kept as history), details with the edit form, tasks, the
 * company timeline and, for a partner company, the persons it referred.
 */
export default async function CompanyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const company = await getCompany(db, id);
  if (!company) notFound();

  const canEdit = hasPermission(actor, "crm.b2b");
  const canAllTasks = hasPermission(actor, "tasks.all");
  const [tasks, staff, timeline] = await Promise.all([
    listTasks(db, { userId: actor.userId, scope: canAllTasks ? "all" : "mine", companyId: id }),
    listStaffForAssignment(db, { permission: "persons.read" }),
    getTimeline(db, { companyId: id, limit: 20 })
      .then((page) => toTimelineRows(db, page.items, locale))
      .catch(() => null),
  ]);
  const self = staff.find((s) => s.userId === actor.userId);
  const owners = canAllTasks ? staff.map((s) => ({ value: s.userId, label: s.name })) : [{ value: actor.userId, label: self?.name ?? tr("crm.tasks.tab_mine") }];
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "medium" });
  const today = brusselsLocal(new Date()).slice(0, 10);
  const d = (k: string, p?: Record<string, string | number>) => tr(`crm.companies.detail.${k}`, p);
  const f = (k: string) => tr(`crm.companies.form.${k}`);
  const { sizes, statuses } = companyOptions(tr);
  const address = company.address ? [[company.address.street, company.address.number].filter(Boolean).join(" "), [company.address.postal_code, company.address.city].filter(Boolean).join(" "), company.address.country].filter(Boolean).join(", ") : null;
  const currentContacts = company.contactList.filter((c) => !c.endedOn).length;
  const openTasks = tasks.filter((t) => t.status === "open").length;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "contacts", label: d("contacts"), count: currentContacts },
    { key: "details", label: d("details") },
    { key: "tasks", label: d("tasks"), count: openTasks },
    { key: "timeline", label: d("timeline") },
    ...(company.isPartner ? [{ key: "referred" as const, label: d("referred_short"), count: company.referredCount }] : []),
  ];
  const wanted = (await searchParams).tab;
  const tab: Tab = tabs.find((t) => t.key === wanted)?.key ?? "contacts";
  const tabHref = (t: Tab) => (t === "contacts" ? `/admin/companies/${id}` : `/admin/companies/${id}?tab=${t}`) as Route;

  const details: Array<[string, string | null]> = [
    [f("vat"), company.vatNumber],
    [f("status"), tr(`crm.enums.company_status.${company.status}`)],
    [f("size"), company.size ? tr(`crm.enums.company_size.${company.size}`) : null],
    [f("industry"), company.industry],
    [f("website"), company.website],
    [f("address"), address],
    [f("owner"), company.ownerName],
    ...(company.isPartner ? ([[f("commission"), company.partnerCommissionPct === null ? null : `${company.partnerCommissionPct} %`]] as Array<[string, string | null]>) : []),
    [f("notes"), company.notes],
  ];

  return (
    <div className="grid gap-4">
      <BackLink href="/admin/companies">{tr("crm.companies.title")}</BackLink>
      <PageHeader
        title={company.name}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tabular-nums">{company.vatNumber ?? tr("crm.companies.no_vat")}</span>
            {company.industry ? <span>· {company.industry}</span> : null}
            <StatusPill tone={COMPANY_TONE[company.status]}>{tr(`crm.enums.company_status.${company.status}`)}</StatusPill>
            {company.isPartner && company.status !== "partner" ? <StatusPill tone="gold">{tr("crm.companies.col_partner")}</StatusPill> : null}
          </span>
        }
      />

      <KpiStrip
        items={[
          { key: "contacts", label: d("contacts"), value: String(currentContacts), href: tabHref("contacts") },
          { key: "tasks", label: d("open_tasks"), value: String(openTasks), href: tabHref("tasks"), ...(tasks.some((t) => t.status === "open" && t.isOverdue) ? { tone: "bad" as const } : {}) },
          ...(company.isPartner ? [{ key: "referred", label: d("referred_short"), value: String(company.referredCount), href: tabHref("referred") }] : []),
          { key: "owner", label: f("owner"), value: company.ownerName ?? "–" },
        ]}
      />

      <div className="overflow-x-auto">
        <Segmented label={company.name} items={tabs.map((t) => ({ key: t.key, label: t.label, href: tabHref(t.key), active: t.key === tab, ...(t.count !== undefined ? { count: t.count } : {}) }))} />
      </div>

      {tab === "contacts" ? (
        <section className="grid gap-2" aria-labelledby="contacts-heading">
          <h2 id="contacts-heading" className="sr-only">
            {d("contacts")}
          </h2>
          <ContactList
            companyId={company.id}
            contacts={company.contactList.map((c) => ({
              id: c.id,
              personId: c.personId,
              name: c.name,
              position: c.position,
              decisionRole: c.decisionRole,
              isPrimary: c.isPrimary,
              endedLabel: c.endedOn ? d("ended", { date: dateFmt.format(new Date(`${c.endedOn}T12:00:00Z`)) }) : null,
            }))}
            canEdit={canEdit}
            locale={locale}
            today={today}
            labels={contactListLabels(tr)}
          />
        </section>
      ) : null}

      {tab === "details" ? (
        <Surface className="grid gap-4" aria-label={d("details")}>
          <dl className="grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-4 gap-y-2">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-[0.75rem] font-medium text-muted-foreground">{label}</dt>
                <dd className="text-[0.8125rem] break-words">{value ?? <span className="text-muted-foreground">–</span>}</dd>
              </div>
            ))}
          </dl>
          {canEdit ? (
            <details className="border-t border-border pt-3">
              <summary className="cursor-pointer text-[0.8125rem] font-semibold">{tr("crm.common.edit")}</summary>
              <div className="pt-4">
                <CompanyForm
                  initial={{
                    id: company.id,
                    name: company.name,
                    vatNumber: company.vatNumber ?? "",
                    street: company.address?.street ?? "",
                    number: company.address?.number ?? "",
                    postalCode: company.address?.postal_code ?? "",
                    city: company.address?.city ?? "",
                    country: company.address?.country ?? "BE",
                    website: company.website ?? "",
                    industry: company.industry ?? "",
                    size: company.size ?? "",
                    status: company.status,
                    ownerUserId: company.ownerUserId ?? "",
                    notes: company.notes ?? "",
                    isPartner: company.isPartner,
                    partnerCommissionPct: company.partnerCommissionPct === null ? "" : String(company.partnerCommissionPct),
                  }}
                  sizes={sizes}
                  statuses={statuses}
                  owners={staff.map((s) => ({ value: s.userId, label: s.name }))}
                  labels={companyFormLabels(tr)}
                />
              </div>
            </details>
          ) : null}
        </Surface>
      ) : null}

      {tab === "tasks" ? (
        <section className="grid gap-2" aria-labelledby="tasks-heading">
          <h2 id="tasks-heading" className="sr-only">
            {d("tasks")}
          </h2>
          <TaskList tasks={tasks.map((t) => toTaskView(t, locale, tr))} currentUserId={actor.userId} canAssignOthers={canAllTasks} owners={owners} companyId={company.id} labels={taskListLabels(tr)} compact />
        </section>
      ) : null}

      {tab === "timeline" ? (
        <Surface flush aria-label={d("timeline")}>
          {timeline ? (
            timeline.length ? (
              <ol className="divide-y divide-border">
                {timeline.map((item) => (
                  <li key={item.id} className="grid grid-cols-[9rem_1fr] gap-3 px-5 py-2.5 text-[0.8125rem]">
                    <time className="text-muted-foreground tabular-nums" dateTime={item.occurredAt}>
                      {item.timeLabel}
                    </time>
                    <span className="grid leading-tight">
                      <span>{item.summary}</span>
                      <span className="text-[0.75rem] text-muted-foreground">{item.categoryLabel}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="px-5 py-4 text-[0.8125rem] text-muted-foreground">{tr("crm.common.none")}</p>
            )
          ) : (
            <p className="px-5 py-4 text-[0.8125rem] text-muted-foreground">{tr("crm.common.not_available")}</p>
          )}
        </Surface>
      ) : null}

      {tab === "referred" && company.isPartner ? (
        <Surface flush aria-labelledby="referred-heading">
          <h2 id="referred-heading" className="border-b border-border px-5 py-2.5 text-[0.875rem] font-semibold">
            {d("referred")} <span className="font-normal text-muted-foreground">({d("referred_count", { count: company.referredCount })})</span>
          </h2>
          {company.referredPersons.length ? (
            <ul className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0">
              {company.referredPersons.map((p) => (
                <li key={p.id} className="px-5 py-2">
                  <Link href={`/admin/persons/${p.id}` as never} className="text-[0.8125rem] font-medium hover:underline">
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-4 text-[0.8125rem] text-muted-foreground">{tr("crm.common.none")}</p>
          )}
        </Surface>
      ) : null}
    </div>
  );
}
