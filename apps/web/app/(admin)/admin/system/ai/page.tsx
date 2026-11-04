import { notFound } from "next/navigation";
import { wallClock } from "@beam/core/platform";
import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getAiUsage } from "@/modules/platform/queries";

/**
 * `/admin/system/ai` (`system.jobs` or `ai.use`): the AI feature register (blueprint 61: fields
 * sent, when, why, provider, location, retention, training status, output storage, prompt storage
 * and retention) and this month's usage per feature from `v_ai_usage_month`.
 */
export default async function AiUsagePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "system.jobs") && !hasPermission(actor, "ai.use")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.ai_usage.${k}`, p);
  const w = wallClock(new Date());
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : `${w.year}-${String(w.month).padStart(2, "0")}`;
  const { usage, register, totalCents } = await getAiUsage(await getAppDb(), { month });
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 4 });
  const num = new Intl.NumberFormat(locale);

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      <section className="grid gap-3" aria-labelledby="usage">
        <h2 id="usage" className="text-lg font-medium">
          {t("usage_title", { month, total: money.format(totalCents / 100) })}
        </h2>
        <form method="get" className="flex items-end gap-2">
          <label className="grid gap-1 text-sm">
            {t("month")}
            <input type="month" name="month" defaultValue={month} className="h-9 rounded-md border bg-background px-2" />
          </label>
          <button type="submit" className="h-9 rounded-md border px-3 text-sm">
            {tr("platform.table.apply")}
          </button>
        </form>
        {usage.length === 0 ? (
          <EmptyState title={t("empty")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_feature")}</TableHead>
                <TableHead>{t("col_model")}</TableHead>
                <TableHead>{t("col_calls")}</TableHead>
                <TableHead>{t("col_tokens")}</TableHead>
                <TableHead>{t("col_cost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.map((u) => (
                <TableRow key={`${u.feature}-${u.model}`}>
                  <TableCell className="font-mono text-xs">{u.feature}</TableCell>
                  <TableCell>{u.model}</TableCell>
                  <TableCell>{num.format(u.calls)}</TableCell>
                  <TableCell>
                    {num.format(u.inputTokens)} / {num.format(u.outputTokens)}
                  </TableCell>
                  <TableCell>{money.format(u.costCents / 100)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="grid gap-3" aria-labelledby="register">
        <h2 id="register" className="text-lg font-medium">
          {t("register_title")}
        </h2>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_feature")}</TableHead>
                <TableHead>{t("col_purpose")}</TableHead>
                <TableHead>{t("col_fields")}</TableHead>
                <TableHead>{t("col_when")}</TableHead>
                <TableHead>{t("col_provider")}</TableHead>
                <TableHead>{t("col_location")}</TableHead>
                <TableHead>{t("col_retention")}</TableHead>
                <TableHead>{t("col_training")}</TableHead>
                <TableHead>{t("col_output_storage")}</TableHead>
                <TableHead>{t("col_prompt_storage")}</TableHead>
                <TableHead>{t("col_prompt_retention")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {register.map((f) => (
                <TableRow key={f.key}>
                  <TableCell className="font-mono text-xs">{f.key}</TableCell>
                  <TableCell className="min-w-64 text-xs">{f.purpose}</TableCell>
                  <TableCell className="text-xs">{f.allowedFields.length ? f.allowedFields.join(", ") : t("no_personal_data")}</TableCell>
                  <TableCell>{f.when}</TableCell>
                  <TableCell>{f.provider}</TableCell>
                  <TableCell>{f.location}</TableCell>
                  <TableCell className="text-xs">{f.retention}</TableCell>
                  <TableCell className="text-xs">{f.trainingStatus}</TableCell>
                  <TableCell className="text-xs">{f.outputStorage}</TableCell>
                  <TableCell className="text-xs">{f.promptStorage}</TableCell>
                  <TableCell className="text-xs">{f.promptRetention}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
