import Link from "next/link";
import { cn } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listStaffForAssignment } from "@/modules/platform/api";
import { getTaskCounts, listTasks } from "@/modules/crm/queries";
import { taskListLabels, toTaskView } from "@/modules/crm/tasks/queries";
import { TaskList } from "@/modules/crm/ui/task-list";

const TABS = ["mine", "all", "overdue", "today"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/admin/tasks` (`persons.read`), crm spec 5.1 and rule 3.43: tabs Mine / All (with `tasks.all`)
 * / Overdue / Today, overdue tasks first and red. Overdue and Today cover every owner for a user
 * with `tasks.all`, else the user's own tasks.
 */
export default async function TasksPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const canAll = hasPermission(actor, "tasks.all");
  const tabs = TABS.filter((t) => t !== "all" || canAll);
  const tab: Tab = (tabs as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "mine";
  const scope = tab === "mine" || !canAll ? "mine" : "all";

  const [rows, counts, staff] = await Promise.all([
    listTasks(db, { userId: actor.userId, scope, ...(tab === "overdue" ? { overdueOnly: true } : {}), ...(tab === "today" ? { dueToday: true } : {}) }),
    getTaskCounts(db, actor.userId),
    listStaffForAssignment(db, { permission: "persons.read" }),
  ]);
  const self = staff.find((s) => s.userId === actor.userId);
  const owners = canAll ? staff.map((s) => ({ value: s.userId, label: s.name })) : [{ value: actor.userId, label: self?.name ?? tr("crm.tasks.tab_mine") }];
  const tabLabel: Record<Tab, string> = { mine: tr("crm.tasks.tab_mine"), all: tr("crm.tasks.tab_all"), overdue: tr("crm.tasks.tab_overdue"), today: tr("crm.tasks.tab_today") };
  const tabCount: Partial<Record<Tab, number>> = { mine: counts.open, overdue: counts.overdue, today: counts.dueToday };

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{tr("crm.tasks.title")}</h1>
      <nav className="flex flex-wrap gap-1 border-b" aria-label={tr("crm.tasks.title")}>
        {tabs.map((t) => (
          <Link
            key={t}
            href={{ pathname: "/admin/tasks", query: { tab: t } }}
            aria-current={t === tab ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", t === tab ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {tabLabel[t]}
            {tabCount[t] !== undefined && (canAll ? t === "mine" : true) ? (
              <span className={cn("ml-2 rounded-full px-2 text-xs", t === "overdue" && counts.overdue > 0 ? "bg-destructive text-destructive-foreground" : "bg-muted")}>{tabCount[t]}</span>
            ) : null}
          </Link>
        ))}
      </nav>
      <TaskList tasks={rows.map((r) => toTaskView(r, locale, tr))} currentUserId={actor.userId} canAssignOthers={canAll} owners={owners} labels={taskListLabels(tr)} />
    </div>
  );
}
