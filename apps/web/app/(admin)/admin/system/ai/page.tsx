import { notFound } from "next/navigation";
import { t as translate, type Locale, type MessageParams } from "@beam/core/i18n";
import { wallClock } from "@beam/core/platform";
import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getAiDailyUsage, listAiSqlLog, type AiDailyUsage, type AiSqlLogEntry } from "@/modules/platform/ai-sql";
import { getAiUsage } from "@/modules/platform/queries";

/**
 * `/admin/system/ai` (`system.jobs` or `ai.use`): the AI feature register (blueprint 61: fields
 * sent, when, why, provider, location, retention, training status, output storage, prompt storage
 * and retention) and this month's usage per feature from `v_ai_usage_month`. R4 (platform-P10)
 * adds the per-day charts (calls, cost, read-only SQL runs) and the read-only SQL log.
 */

/**
 * R4 labels. `platform.json` (not part of platform-P10) does not have these keys yet: the
 * catalogue wins once it does, until then these texts are used, in all three locales.
 */
const R4_TEXT = {
  daily_title: { en: "Per day in {month}", "nl-BE": "Per dag in {month}", "fr-BE": "Par jour en {month}" },
  daily_calls: { en: "Claude calls", "nl-BE": "Claude-oproepen", "fr-BE": "Appels à Claude" },
  daily_cost: { en: "Cost", "nl-BE": "Kosten", "fr-BE": "Coût" },
  daily_sql: { en: "Read-only SQL runs (failed)", "nl-BE": "Alleen-lezen SQL-uitvoeringen (mislukt)", "fr-BE": "Exécutions SQL en lecture seule (échouées)" },
  daily_empty: { en: "No AI activity this month.", "nl-BE": "Geen AI-activiteit deze maand.", "fr-BE": "Aucune activité IA ce mois-ci." },
  sql_log_title: { en: "Read-only SQL log", "nl-BE": "Logboek alleen-lezen SQL", "fr-BE": "Journal SQL en lecture seule" },
  sql_log_intro: {
    en: "Statements written by Claude for questions, run as the read-only role on the ai views. Results are never stored; only the column count and row count.",
    "nl-BE": "Door Claude geschreven query's voor vragen, uitgevoerd met de alleen-lezen rol op de ai-views. Resultaten worden nooit bewaard, enkel het aantal kolommen en rijen.",
    "fr-BE": "Requêtes écrites par Claude pour les questions, exécutées avec le rôle en lecture seule sur les vues ai. Les résultats ne sont jamais conservés, seulement le nombre de colonnes et de lignes.",
  },
  sql_log_empty: { en: "No SQL runs this month.", "nl-BE": "Geen SQL-uitvoeringen deze maand.", "fr-BE": "Aucune exécution SQL ce mois-ci." },
  col_time: { en: "Time", "nl-BE": "Tijdstip", "fr-BE": "Moment" },
  col_status: { en: "Status", "nl-BE": "Status", "fr-BE": "Statut" },
  col_sql: { en: "SQL", "nl-BE": "SQL", "fr-BE": "SQL" },
  col_rows: { en: "Rows", "nl-BE": "Rijen", "fr-BE": "Lignes" },
  col_duration: { en: "Duration", "nl-BE": "Duur", "fr-BE": "Durée" },
  status_ok: { en: "Ran", "nl-BE": "Uitgevoerd", "fr-BE": "Exécutée" },
  status_error: { en: "Refused", "nl-BE": "Geweigerd", "fr-BE": "Refusée" },
  truncated: { en: "{rows} (cut at the limit)", "nl-BE": "{rows} (afgekapt op de limiet)", "fr-BE": "{rows} (coupé à la limite)" },
} as const satisfies Record<string, Record<Locale, string>>;

type R4Key = keyof typeof R4_TEXT;

function r4Translator(locale: Locale) {
  return (key: R4Key, params: MessageParams = {}) => {
    const full = `platform.ai_usage.${key}`;
    if (translate.has(locale, full)) return translate(locale, full, params);
    return R4_TEXT[key][locale].replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
  };
}

export default async function AiUsagePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "system.jobs") && !hasPermission(actor, "ai.use")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.ai_usage.${k}`, p);
  const w = wallClock(new Date());
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : `${w.year}-${String(w.month).padStart(2, "0")}`;
  const db = await getAppDb();
  const [{ usage, register, totalCents }, daily, sqlLog] = await Promise.all([getAiUsage(db, { month }), getAiDailyUsage(db, { month }), listAiSqlLog(db, { month, limit: 50 })]);
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 4 });
  const num = new Intl.NumberFormat(locale);
  const r4 = r4Translator(locale);

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
      <DailySection daily={daily} month={month} locale={locale} r4={r4} />
      <SqlLogSection entries={sqlLog} locale={locale} r4={r4} />
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

type R4 = ReturnType<typeof r4Translator>;

/** A horizontal bar per day; the values are also printed, so nothing depends on the bar alone. */
function DayBars({ title, days, values, format }: { title: string; days: string[]; values: number[]; format: (v: number, i: number) => string }) {
  const max = Math.max(0, ...values);
  return (
    <figure className="grid gap-2 rounded-md border p-3">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <ul className="grid gap-1">
        {days.map((day, i) => {
          const value = values[i] ?? 0;
          const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
          return (
            <li key={day} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-xs">
              <span className="font-mono text-muted-foreground">{day.slice(5)}</span>
              <span className="h-3 rounded-sm bg-muted" aria-hidden="true">
                <span className="block h-3 rounded-sm bg-primary" style={{ width: `${pct}%` }} />
              </span>
              <span className="tabular-nums">{format(value, i)}</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

function DailySection({ daily, month, locale, r4 }: { daily: AiDailyUsage[]; month: string; locale: Locale; r4: R4 }) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
  const num = new Intl.NumberFormat(locale);
  const days = daily.map((d) => d.day);
  return (
    <section className="grid gap-3" aria-labelledby="daily">
      <h2 id="daily" className="text-lg font-medium">
        {r4("daily_title", { month })}
      </h2>
      {daily.length === 0 ? (
        <EmptyState title={r4("daily_empty")} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-3">
          <DayBars title={r4("daily_calls")} days={days} values={daily.map((d) => d.calls)} format={(v) => num.format(v)} />
          <DayBars title={r4("daily_cost")} days={days} values={daily.map((d) => d.costCents / 100)} format={(v) => money.format(v)} />
          <DayBars
            title={r4("daily_sql")}
            days={days}
            values={daily.map((d) => d.sqlRuns)}
            format={(v, i) => {
              const failed = daily[i]?.sqlErrors ?? 0;
              return failed ? `${num.format(v)} (${num.format(failed)})` : num.format(v);
            }}
          />
        </div>
      )}
    </section>
  );
}

function SqlLogSection({ entries, locale, r4 }: { entries: AiSqlLogEntry[]; locale: Locale; r4: R4 }) {
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Brussels" });
  const num = new Intl.NumberFormat(locale);
  return (
    <section className="grid gap-3" aria-labelledby="sql-log">
      <h2 id="sql-log" className="text-lg font-medium">
        {r4("sql_log_title")}
      </h2>
      <p className="text-sm text-muted-foreground">{r4("sql_log_intro")}</p>
      {entries.length === 0 ? (
        <EmptyState title={r4("sql_log_empty")} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{r4("col_time")}</TableHead>
                <TableHead>{r4("col_status")}</TableHead>
                <TableHead>{r4("col_sql")}</TableHead>
                <TableHead>{r4("col_rows")}</TableHead>
                <TableHead>{r4("col_duration")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs">{when.format(e.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant={e.status === "ok" ? "success" : "warning"}>{r4(e.status === "ok" ? "status_ok" : "status_error")}</Badge>
                  </TableCell>
                  <TableCell className="min-w-96 max-w-[48rem]">
                    <code className="block whitespace-pre-wrap break-words font-mono text-xs">{e.sql}</code>
                    {e.error ? <span className="mt-1 block text-xs text-muted-foreground">{e.error}</span> : null}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {e.rowCount === null ? "-" : e.truncated ? r4("truncated", { rows: num.format(e.rowCount) }) : num.format(e.rowCount)}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">{e.durationMs === null ? "-" : `${num.format(e.durationMs)} ms`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
