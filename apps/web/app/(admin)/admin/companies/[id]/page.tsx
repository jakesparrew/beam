import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listStaffForAssignment } from "@/modules/platform/api";
import { getCompany, getTimeline, listTasks } from "@/modules/crm/queries";
import { companyFormLabels, companyOptions, contactListLabels } from "@/modules/crm/companies/queries";
import { brusselsLocal, taskListLabels, toTaskView } from "@/modules/crm/tasks/queries";
import { CompanyForm } from "@/modules/crm/ui/company-form";
import { ContactList } from "@/modules/crm/ui/contact-list";
import { TaskList } from "@/modules/crm/ui/task-list";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/companies/[id]` (`persons.read`; edit `crm.b2b`), crm spec 5.1: details, contacts
 * (ended ones kept as history), tasks, the company timeline and, for a partner company, the
 * persons it referred. Opportunities arrive with the R3 pipeline (crm-P8).
 */
export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
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
    getTimeline(db, { companyId: id, limit: 20 }).catch(() => null),
  ]);
  const self = staff.find((s) => s.userId === actor.userId);
  const owners = canAllTasks ? staff.map((s) => ({ value: s.userId, label: s.name })) : [{ value: actor.userId, label: self?.name ?? tr("crm.tasks.tab_mine") }];
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "medium" });
  const today = brusselsLocal(new Date()).slice(0, 10);
  const d = (k: string) => tr(`crm.companies.detail.${k}`);
  const f = (k: string) => tr(`crm.companies.form.${k}`);
  const { sizes, statuses } = companyOptions(tr);
  const address = company.address ? [[company.address.street, company.address.number].filter(Boolean).join(" "), [company.address.postal_code, company.address.city].filter(Boolean).join(" "), company.address.country].filter(Boolean).join(", ") : null;

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
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{company.name}</h1>
        <Badge variant="outline">{tr(`crm.enums.company_status.${company.status}`)}</Badge>
        {company.isPartner ? <Badge variant="secondary">{tr("crm.companies.col_partner")}</Badge> : null}
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{d("details")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="text-sm">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
          {canEdit ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium">{tr("crm.common.edit")}</summary>
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
        </CardContent>
      </Card>

      <section className="grid gap-3" aria-labelledby="contacts-heading">
        <h2 id="contacts-heading" className="text-lg font-semibold">
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
            endedLabel: c.endedOn ? tr("crm.companies.detail.ended", { date: dateFmt.format(new Date(`${c.endedOn}T12:00:00Z`)) }) : null,
          }))}
          canEdit={canEdit}
          locale={locale}
          today={today}
          labels={contactListLabels(tr)}
        />
      </section>

      {company.isPartner ? (
        <section className="grid gap-3" aria-labelledby="referred-heading">
          <h2 id="referred-heading" className="text-lg font-semibold">
            {d("referred")} <span className="text-sm font-normal text-muted-foreground">({tr("crm.companies.detail.referred_count", { count: company.referredCount })})</span>
          </h2>
          {company.referredPersons.length ? (
            <ul className="grid gap-1 sm:grid-cols-2">
              {company.referredPersons.map((p) => (
                <li key={p.id}>
                  <Link href={`/admin/persons/${p.id}` as never} className="text-sm underline-offset-4 hover:underline">
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{tr("crm.common.none")}</p>
          )}
        </section>
      ) : null}

      <section className="grid gap-3" aria-labelledby="tasks-heading">
        <h2 id="tasks-heading" className="text-lg font-semibold">
          {d("tasks")}
        </h2>
        <TaskList
          tasks={tasks.map((t) => toTaskView(t, locale, tr))}
          currentUserId={actor.userId}
          canAssignOthers={canAllTasks}
          owners={owners}
          companyId={company.id}
          labels={taskListLabels(tr)}
        />
      </section>

      <section className="grid gap-3" aria-labelledby="timeline-heading">
        <h2 id="timeline-heading" className="text-lg font-semibold">
          {d("timeline")}
        </h2>
        {timeline ? (
          timeline.items.length ? (
            <ol className="grid gap-2">
              {timeline.items.map((item) => (
                <li key={item.id} className="text-sm">
                  <time className="mr-2 text-muted-foreground" dateTime={item.occurredAt.toISOString()}>
                    {dateFmt.format(item.occurredAt)}
                  </time>
                  {item.kind}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">{tr("crm.common.none")}</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">{tr("crm.common.not_available")}</p>
        )}
      </section>
    </div>
  );
}
