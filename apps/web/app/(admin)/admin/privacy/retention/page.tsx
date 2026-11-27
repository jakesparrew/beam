import { redirect } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Input } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { updateRetentionPolicy } from "@/modules/ops/exports/actions";
import { listRetentionPolicies } from "@/modules/ops/exports/queries";
import { PrivacyHeader } from "../privacy-header";

/**
 * `/admin/privacy/retention` (`privacy.run`, ops spec 5 and 9, rule 68): every retention policy
 * by run order with its days, switch and the last sweep (when, rows, status), and an edit form
 * per policy (`updateRetentionPolicy`). `keep` policies have no days and are never swept.
 */
const ERROR_KEYS = new Set(["forbidden", "validation", "not_found", "conflict"]);

export default async function RetentionPoliciesPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const actor = await requireStaff({ permission: "privacy.run" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const db = await getAppDb();
  const policies = await listRetentionPolicies(db);
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" });
  const label = (key: string, description: string) => {
    const k = `ops.retention_policy.${key.replace(".", "_")}`;
    const v = soft(k);
    return v === k ? description : v;
  };
  const statusLabel = (s: string | null) => (s === "ok" ? tr("platform.integrations.ok") : s === "error" ? tr("platform.jobs.error") : (s ?? tr("platform.system.never")));

  async function save(fd: FormData) {
    "use server";
    const keyRaw = fd.get("key");
    const key = typeof keyRaw === "string" ? keyRaw : "";
    const daysRaw = fd.get("days");
    const days = typeof daysRaw === "string" && daysRaw.trim() ? Number(daysRaw) : undefined;
    const result = await updateRetentionPolicy({ key, ...(days !== undefined ? { days } : {}), isActive: fd.get("isActive") === "on" });
    redirect((result.ok ? "/admin/privacy/retention?saved=1" : `/admin/privacy/retention?error=${result.error.code}`) as never);
  }

  const error = sp.error ? (ERROR_KEYS.has(sp.error) ? sp.error : "validation") : null;

  return (
    <div className="grid gap-4">
      <PrivacyHeader active="retention" actor={actor} tr={tr} />
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{tr(`platform.errors.${error}`)}</AlertDescription>
        </Alert>
      ) : sp.saved ? (
        <Alert>
          <AlertDescription>{tr("platform.settings.saved")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-[0.8125rem]">
          <thead className="bg-[#faf9f6]">
            <tr>
              <th scope="col" className="px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5">{tr("platform.ai_usage.col_retention")}</th>
              <th scope="col" className="px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5">{tr("platform.security.col_table")}</th>
              <th scope="col" className="px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5">{tr("crm.segments.builder.days")}</th>
              <th scope="col" className="px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5">{tr("commerce.common.active")}</th>
              <th scope="col" className="px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5">{tr("platform.audit.col_when")}</th>
              <th scope="col" className="px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5">{tr("platform.security.col_rows")}</th>
              <th scope="col" className="px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5">{tr("platform.jobs.col_status")}</th>
              <th scope="col" className="px-3 py-2 text-left text-[0.75rem] font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5">{tr("platform.jobs.col_actions")}</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => {
              const formId = `policy-${p.key.replace(/[^a-z0-9]/g, "-")}`;
              return (
                <tr key={p.key} className="border-t border-border align-top">
                  <td className="px-3 py-2.5 first:pl-5 last:pr-5">
                    <span className="font-medium">{label(p.key, p.description)}</span>
                    <span className="block font-mono text-xs text-muted-foreground">{p.key}</span>
                  </td>
                  <td className="px-3 py-2.5 first:pl-5 last:pr-5 font-mono text-xs">{p.tableName}</td>
                  <td className="px-3 py-2.5 first:pl-5 last:pr-5">
                    {p.action === "keep" ? (
                      "-"
                    ) : (
                      <Input form={formId} type="number" name="days" min={1} max={3653} defaultValue={p.days ?? undefined} className="w-24" aria-label={`${tr("crm.segments.builder.days")} ${p.key}`} />
                    )}
                  </td>
                  <td className="px-3 py-2.5 first:pl-5 last:pr-5">
                    <input form={formId} type="checkbox" name="isActive" defaultChecked={p.isActive} aria-label={`${tr("commerce.common.active")} ${p.key}`} />
                  </td>
                  <td className="px-3 py-2.5 first:pl-5 last:pr-5">{p.lastRunAt ? fmt.format(p.lastRunAt) : tr("platform.system.never")}</td>
                  <td className="px-3 py-2.5 first:pl-5 last:pr-5">{p.lastRunRows ?? "-"}</td>
                  <td className="px-3 py-2.5 first:pl-5 last:pr-5">
                    {p.lastRunStatus ? <Badge variant={p.lastRunStatus === "ok" ? "success" : "destructive"}>{statusLabel(p.lastRunStatus)}</Badge> : "-"}
                  </td>
                  <td className="px-3 py-2.5 first:pl-5 last:pr-5">
                    <form id={formId} action={save}>
                      <input type="hidden" name="key" value={p.key} />
                      <Button type="submit" size="sm" variant="outline">
                        {tr("platform.settings.save")}
                      </Button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
