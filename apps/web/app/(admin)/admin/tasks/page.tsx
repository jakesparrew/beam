import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listStaffForAssignment } from "@/modules/platform/api";
import { getTaskCounts, listTasks } from "@/modules/crm/queries";
import { taskListLabels, toTaskView } from "@/modules/crm/tasks/queries";
import { TaskList } from "@/modules/crm/ui/task-list";
import { PageHeader } from "@/modules/platform/ui/admin-kit";
import { ListToolbar, listToolbarLabels } from "@/modules/platform/ui/admin-list-kit";

const TABS = ["mine", "all", "overdue", "today"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/admin/tasks` (`persons.read`), crm spec 5.1 and rule 3.43: tabs Mine / All (with `tasks.all`)
 * / Overdue / Today, overdue tasks first and red. Overdue and Today cover every owner for a user
 * with `tasks.all`, else the user's own tasks. Back-office kit (owner review, November 2026): one
 * header, the list toolbar (a search on the task, client or company; the tabs as chips with their
 * counts), the task table with "Done" first.
 */
export default async function TasksPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const canAll = hasPermission(actor, "tasks.all");
  const tabs = TABS.filter((t) => t !== "all" || canAll);
  const tab: Tab = (tabs as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "mine";
  const scope = tab === "mine" || !canAll ? "mine" : "all";
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const needle = q?.toLowerCase();

  const [all, counts, staff] = await Promise.all([
    listTasks(db, { userId: actor.userId, scope, ...(tab === "overdue" ? { overdueOnly: true } : {}), ...(tab === "today" ? { dueToday: true } : {}) }),
    getTaskCounts(db, actor.userId),
    listStaffForAssignment(db, { permission: "persons.read" }),
  ]);
  // ponytail: the search runs on the loaded tasks (at most 200 per tab); a query filter if a tab outgrows that.
  const rows = needle ? all.filter((r) => [r.title, r.personName, r.companyName, r.notes].some((v) => v?.toLowerCase().includes(needle))) : all;
  const self = staff.find((s) => s.userId === actor.userId);
  const owners = canAll ? staff.map((s) => ({ value: s.userId, label: s.name })) : [{ value: actor.userId, label: self?.name ?? tr("crm.tasks.tab_mine") }];
  const tabLabel: Record<Tab, string> = { mine: tr("crm.tasks.tab_mine"), all: tr("crm.tasks.tab_all"), overdue: tr("crm.tasks.tab_overdue"), today: tr("crm.tasks.tab_today") };
  const tabCount: Partial<Record<Tab, number>> = { mine: counts.open, overdue: counts.overdue, today: counts.dueToday };

  return (
    <div className="grid gap-4">
      <PageHeader title={tr("crm.tasks.title")} />
      <ListToolbar
        labels={listToolbarLabels(tr)}
        search={{ placeholder: tr("crm.tasks.search_placeholder"), defaultValue: q }}
        hidden={{ tab: sp.tab ? tab : undefined }}
        chips={{
          label: tr("crm.tasks.title"),
          items: tabs.map((t) => ({
            key: t,
            label: tabLabel[t],
            href: { pathname: "/admin/tasks", query: { tab: t, ...(q ? { q } : {}) } },
            active: t === tab,
            ...(tabCount[t] !== undefined && (canAll ? t === "mine" : true) ? { count: tabCount[t] } : {}),
          })),
        }}
      />
      <TaskList tasks={rows.map((r) => toTaskView(r, locale, tr))} currentUserId={actor.userId} canAssignOthers={canAll} owners={owners} labels={taskListLabels(tr)} />
    </div>
  );
}
