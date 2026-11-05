import type { Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { askQuestion } from "@/modules/ops/ai/actions";
import { isPersonIdColumn, type NlStatus } from "@/modules/ops/ai/ask";
import { ASK_EXAMPLES, getQuestion, listQuestions, type QuestionDetail } from "@/modules/ops/ai/queries";
import { holdsAny } from "@/modules/ops/reports/registry";
import { staffReadCtx } from "@/modules/ops/reports/queries";

/**
 * `/admin/dashboard/ask` (ops spec 5, rule 77; `ai.use` and `reports.read`, behind `ff_ops_ai`):
 * the question box with the six blueprint examples as chips, the answer of the selected question
 * (status, explanation, the table with `person_id` cells as links to the person, the collapsed
 * generated SQL) and the user's earlier questions. Asking posts through the `askQuestion` action
 * and reloads the page on `?id=<questionId>`.
 */
export const dynamic = "force-dynamic";

const ASK_PATH = "/admin/dashboard/ask";
const STATUS_VARIANT: Record<NlStatus, "success" | "secondary" | "destructive" | "warning"> = {
  answered: "success",
  refused: "secondary",
  error: "destructive",
  timeout: "warning",
  budget_exceeded: "warning",
};

/** The form's server action: asks, then shows the answer (or the error with the question kept). */
async function onAsk(form: FormData) {
  "use server";
  const raw = form.get("question");
  const question = typeof raw === "string" ? raw : "";
  const r = await askQuestion({ question });
  if (r.ok) redirect(`${ASK_PATH}?id=${r.data.questionId}` as Route);
  const error = r.error.code === "validation" ? "validation" : r.error.code === "not_found" ? "not_found" : "generic";
  if (error === "not_found") redirect(ASK_PATH as Route);
  redirect(`${ASK_PATH}?error=${error}&q=${encodeURIComponent(question.slice(0, 500))}` as Route);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(cellText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default async function AskPage({ searchParams }: { searchParams: Promise<{ id?: string; error?: string; q?: string }> }) {
  const ctx = await staffReadCtx({ permission: "ai.use" });
  if (!holdsAny(ctx.actor, "reports.read")) notFound();
  if (!(await flag("ff_ops_ai", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const [history, current] = await Promise.all([listQuestions(ctx), sp.id ? getQuestion(ctx, sp.id).catch((): QuestionDetail | null => null) : Promise.resolve(null)]);
  const errorText = sp.error === "validation" ? tr("ops.ask.error.validation") : sp.error ? tr("ops.ask.error.generic") : null;

  return (
    <div className="grid gap-6" data-testid="ops-ask">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("ops.ask.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("ops.ask.intro")}</p>
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-6">
          <form action={onAsk} className="grid gap-3" data-testid="ask-form">
            <Label htmlFor="ask-question">{tr("ops.ask.label")}</Label>
            <Textarea id="ask-question" name="question" required minLength={3} maxLength={500} rows={3} placeholder={tr("ops.ask.placeholder")} defaultValue={sp.q ?? ""} />
            {errorText ? (
              <Alert variant="destructive">
                <AlertDescription>{errorText}</AlertDescription>
              </Alert>
            ) : null}
            <div>
              <Button type="submit">{tr("ops.ask.submit")}</Button>
            </div>
          </form>
          <div className="grid gap-2">
            <p className="text-sm font-medium">{tr("ops.ask.examples_title")}</p>
            <div className="flex flex-wrap gap-2" data-testid="ask-examples">
              {ASK_EXAMPLES.map((key) => (
                <form key={key} action={onAsk}>
                  <input type="hidden" name="question" value={tr(`ops.ask.example.${key}`)} />
                  <Button type="submit" variant="outline" size="sm">
                    {tr(`ops.ask.example.${key}`)}
                  </Button>
                </form>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {current ? <Answer q={current} tr={tr} /> : history.length === 0 ? <EmptyState title={tr("ops.ask.empty")} description={tr("ops.ask.intro")} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tr("ops.ask.history_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tr("ops.ask.history_empty")}</p>
          ) : (
            <ul className="grid gap-2" data-testid="ask-history">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={STATUS_VARIANT[h.status]}>{tr(`ops.ask.status.${h.status}`)}</Badge>
                  <Link href={`${ASK_PATH}?id=${h.id}` as Route} className="underline-offset-4 hover:underline">
                    {h.question}
                  </Link>
                  <span className="text-muted-foreground">{formatDateTime(h.createdAt, ctx.locale)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Answer({ q, tr }: { q: QuestionDetail; tr: (key: string, params?: Record<string, string | number>) => string }) {
  const statusText = q.status === "answered" ? null : tr(`ops.ask.status_text.${q.status}`);
  return (
    <Card data-testid="ask-answer" data-status={q.status}>
      <CardHeader className="grid gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {tr("ops.ask.answer_title")}
          <Badge variant={STATUS_VARIANT[q.status]}>{tr(`ops.ask.status.${q.status}`)}</Badge>
        </CardTitle>
        <p className="text-sm">{q.question}</p>
      </CardHeader>
      <CardContent className="grid gap-4">
        {statusText ? (
          <Alert variant={q.status === "error" ? "destructive" : "default"}>
            <AlertDescription>
              {statusText} {q.status === "budget_exceeded" || q.status === "error" ? tr("ops.ask.unavailable") : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {q.explanation && q.status === "answered" ? (
          <div className="grid gap-1">
            <p className="text-sm font-medium">{tr("ops.ask.explanation")}</p>
            <p className="text-sm" data-testid="ask-explanation">
              {q.explanation}
            </p>
          </div>
        ) : null}
        {q.status === "answered" ? (
          q.rows === null ? (
            <p className="text-sm text-muted-foreground">{tr("ops.ask.rows_expired")}</p>
          ) : q.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tr("ops.ask.no_rows")}</p>
          ) : (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                {tr("ops.ask.rows", { count: q.rows.length })}
                {q.columns.some(isPersonIdColumn) ? ` · ${tr("ops.ask.privacy_note")}` : ""}
              </p>
              <div className="overflow-x-auto">
                <Table data-testid="ask-table">
                  <TableHeader>
                    <TableRow>
                      {q.columns.map((c) => (
                        <TableHead key={c}>{c}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {q.rows.map((row, i) => (
                      <TableRow key={i}>
                        {q.columns.map((c, j) => {
                          const value = row[j];
                          if (isPersonIdColumn(c) && typeof value === "string" && q.personNames[value.toLowerCase()]) {
                            return (
                              <TableCell key={c}>
                                <Link href={`/admin/persons/${value}` as Route} className="underline-offset-4 hover:underline" data-testid="ask-person-link">
                                  {q.personNames[value.toLowerCase()]}
                                </Link>
                              </TableCell>
                            );
                          }
                          return <TableCell key={c}>{cellText(value)}</TableCell>;
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )
        ) : q.status === "refused" && q.explanation ? (
          <p className="text-sm text-muted-foreground">{q.explanation}</p>
        ) : null}
        {q.sql ? (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{tr("ops.ask.sql")}</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs" data-testid="ask-sql">
              {q.sql}
            </pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
