import { redirect } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Textarea } from "@beam/ui";
import { DPIA_KEYS, DPIA_STATUSES, type DpiaKey, type DpiaStatus } from "@beam/core/ops";
import { requireStaff } from "@/lib/auth";
import { createCtx, getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { updateDpiaRecord } from "@/modules/ops/exports/actions";
import { listAiFeatureDocs, listDpiaRecords } from "@/modules/ops/exports/queries";
import { storeFile } from "@/modules/platform/api";

/**
 * `/admin/privacy/dpia` (`settings.write`, ops spec 5 and 9, rule 70): the register of the six
 * higher-risk processing activities with status, purpose, risks, measures, decision and document,
 * which features each gates (features, watch-time profile fields, automation journeys), and per
 * AI feature the blueprint 61 documentation from platform's `AI_FEATURES`.
 */
const ERROR_KEYS = new Set(["forbidden", "validation", "not_found", "conflict"]);
const MAX_DOCUMENT_BYTES = 10_485_760;

export default async function DpiaRegisterPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireStaff({ permission: "settings.write" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const [records, features] = [await listDpiaRecords(db), listAiFeatureDocs()];
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Brussels" });

  async function save(fd: FormData) {
    "use server";
    const actor = await requireStaff({ permission: "settings.write" });
    const text = (k: string) => {
      const v = fd.get(k);
      return typeof v === "string" ? v : undefined;
    };
    const key = (text("key") ?? "") as DpiaKey;
    const status = (text("status") ?? "") as DpiaStatus;
    let documentFileId: string | undefined;
    const doc = fd.get("document");
    if (doc instanceof File && doc.size > 0) {
      if (doc.size > MAX_DOCUMENT_BYTES || doc.type !== "application/pdf") redirect("/admin/privacy/dpia?error=validation");
      const bytes = new Uint8Array(await doc.arrayBuffer());
      const appDb = await getAppDb();
      documentFileId = await appDb.transaction(async (tx) => {
        const stored = await storeFile(createCtx({ tx, actor }), { kind: "import", name: doc.name || `dpia-${key}.pdf`, mime: "application/pdf", bytes });
        return stored.fileId;
      });
    }
    const result = await updateDpiaRecord({
      key,
      status,
      purpose: text("purpose"),
      risks: text("risks"),
      measures: text("measures"),
      decisionNote: text("decisionNote"),
      ...(documentFileId ? { documentFileId } : {}),
    });
    redirect((result.ok ? "/admin/privacy/dpia?saved=1" : `/admin/privacy/dpia?error=${result.error.code}`) as never);
  }

  const error = sp.error ? (ERROR_KEYS.has(sp.error) ? sp.error : "validation") : null;
  const textField = (name: string, label: string, value: string | null) => (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <Textarea name={name} defaultValue={value ?? ""} rows={3} maxLength={4000} />
    </label>
  );

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{tr("ops.dpia.register_title")}</h1>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{tr(`platform.errors.${error}`)}</AlertDescription>
        </Alert>
      ) : sp.saved ? (
        <Alert>
          <AlertDescription>{tr("platform.settings.saved")}</AlertDescription>
        </Alert>
      ) : null}

      {DPIA_KEYS.map((key) => {
        const r = records.find((x) => x.key === key)!;
        const open = r.status === "approved" || r.status === "not_required";
        return (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3">
                {tr(`ops.dpia.${key}.title`)}
                <Badge variant={open ? "success" : r.status === "rejected" ? "destructive" : "secondary"}>{tr(`ops.dpia.status.${r.status}`)}</Badge>
              </CardTitle>
              <p className="text-sm text-muted-foreground">{tr(`ops.dpia.${key}.description`)}</p>
              {r.gates.length ? <p className="text-sm">{tr("ops.dpia.gates", { features: r.gates.join(", ") })}</p> : null}
              {r.reviewedAt ? <p className="text-xs text-muted-foreground">{tr("platform.settings.last_edit", { who: r.reviewedBy ?? "-", when: fmt.format(r.reviewedAt) })}</p> : null}
            </CardHeader>
            <CardContent>
              <form action={save} className="grid gap-4">
                <input type="hidden" name="key" value={key} />
                <label className="grid max-w-xs gap-1 text-sm font-medium">
                  {tr("platform.jobs.col_status")}
                  <select name="status" defaultValue={r.status} className="h-9 rounded-md border bg-background px-2 text-sm">
                    {DPIA_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {tr(`ops.dpia.status.${s}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-4 md:grid-cols-3">
                  {textField("purpose", tr("platform.ai_settings.purpose"), r.purpose)}
                  {textField("risks", tr("platform.incidents.field_risk"), r.risks)}
                  {textField("measures", tr("platform.security.safeguards"), r.measures)}
                </div>
                <label className="grid gap-1 text-sm font-medium">
                  {tr("site.admin.import.col.decision")}
                  <Textarea name="decisionNote" defaultValue={r.decisionNote ?? ""} rows={2} maxLength={2000} aria-describedby={`${key}-note-hint`} />
                  <span id={`${key}-note-hint`} className="text-xs font-normal text-muted-foreground">
                    {tr("ops.dpia.decision_note_required")}
                  </span>
                </label>
                <label className="grid max-w-md gap-1 text-sm font-medium">
                  PDF {r.documentName ? <span className="font-normal text-muted-foreground">({r.documentName})</span> : null}
                  <Input type="file" name="document" accept="application/pdf" />
                </label>
                <div>
                  <Button type="submit">{tr("platform.settings.save")}</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        );
      })}

      <section className="grid gap-3" aria-labelledby="ai-features">
        <h2 id="ai-features" className="text-lg font-medium">
          {tr("platform.ai_usage.col_feature")}
        </h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">{tr("platform.ai_usage.col_feature")}</th>
                <th className="px-3 py-2">{tr("platform.ai_settings.purpose")}</th>
                <th className="px-3 py-2">{tr("platform.ai_usage.col_provider")}</th>
                <th className="px-3 py-2">{tr("platform.ai_usage.col_retention")}</th>
              </tr>
            </thead>
            <tbody>
              {features.map((f) => (
                <tr key={f.key} className="border-t align-top">
                  <td className="px-3 py-2 font-mono text-xs">
                    {f.key}
                    <span className="block text-muted-foreground">
                      {f.module} · {f.when} · {f.model}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {f.purpose}
                    <span className="block text-xs text-muted-foreground">{f.allowedFields.length ? f.allowedFields.join(", ") : "-"}</span>
                  </td>
                  <td className="px-3 py-2">{f.location}</td>
                  <td className="px-3 py-2">
                    {f.retention}
                    <span className="block text-xs text-muted-foreground">
                      {f.trainingStatus} · {f.outputStorage}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
