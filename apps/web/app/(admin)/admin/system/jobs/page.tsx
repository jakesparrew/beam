import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, jobsTableLabels, translator } from "@/lib/i18n";
import { listJobKinds, listJobs, type JobLane, type JobStatus } from "@/modules/platform/queries";
import { JobsTable } from "@/modules/platform/ui/jobs-table";

const STATUSES = ["pending", "running", "succeeded", "failed", "dead", "all"] as const;
const LANES = ["fast", "bulk"] as const;

type Search = { status?: string; kind?: string; lane?: string; q?: string; cursor?: string };

/** `/admin/system/jobs` (`system.jobs`): default filter `dead`; Retry and Discard. */
export default async function JobsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireStaff({ permission: "system.jobs" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as JobStatus | "all") : "dead";
  const lane = (LANES as readonly string[]).includes(sp.lane ?? "") ? (sp.lane as JobLane) : undefined;
  const [{ rows, nextCursor }, kinds] = await Promise.all([
    listJobs(db, { status, ...(lane ? { lane } : {}), ...(sp.kind ? { kind: sp.kind } : {}), ...(sp.q ? { q: sp.q } : {}), cursor: sp.cursor ?? null }),
    listJobKinds(db),
  ]);
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("platform.jobs.title")}</h1>
        <p className="text-muted-foreground">{tr("platform.jobs.intro")}</p>
      </header>
      <JobsTable
        rows={rows.map((r) => ({ ...r, runAt: r.runAt.toISOString() }))}
        kinds={kinds}
        nextCursor={nextCursor}
        searchParams={{ status: sp.status, kind: sp.kind, lane: sp.lane, q: sp.q }}
        canManage
        locale={locale}
        labels={jobsTableLabels(tr)}
      />
    </div>
  );
}
