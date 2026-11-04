import Link from "next/link";
import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { Badge, Button } from "@beam/ui";
import type { CutoverKey } from "@beam/core/ops";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { setCutoverStep } from "@/modules/ops/imports/actions";
import { getCutoverChecklist } from "@/modules/ops/imports/queries";

/** Where each manual or mirrored step is done (rule 53): platform's gate, finance's settings, the DPIA register. */
const STEP_LINKS: Partial<Record<CutoverKey, string>> = {
  go_live_gate_complete: "/admin/system/go-live",
  invoice_issuer_settings_complete: "/admin/settings",
  legal_texts_reviewed: "/admin/settings",
  dpia_sensitive_processing_decided: "/admin/privacy/dpia",
};

async function tick(formData: FormData) {
  "use server";
  const text = (name: string) => {
    const v = formData.get(name);
    return typeof v === "string" ? v : "";
  };
  const key = text("key") as CutoverKey;
  const note = text("note").trim();
  await setCutoverStep({ key, done: formData.get("done") === "true", ...(note ? { note } : {}) });
  revalidatePath("/admin/imports/cutover");
}

/**
 * `/admin/imports/cutover` (view `persons.write`, tick `settings.write`, ops spec 5, rule 53): the
 * 17 cut-over steps in order with their state, who and when, the linked import, and the link to
 * platform's go-live gate. Only the manual steps can be ticked here.
 */
export default async function CutoverPage() {
  const actor = await requireStaff({ permission: "persons.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const list = await getCutoverChecklist(await getAppDb());
  const canTick = hasPermission(actor, "settings.write");
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Brussels" });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/admin/imports" className="text-sm text-muted-foreground hover:underline">
          {tr("ops.imports.title")}
        </Link>
        <h1 className="text-2xl font-semibold">{tr("ops.cutover.title")}</h1>
        <span className="text-sm text-muted-foreground">{tr("ops.cutover.progress", { done: list.done, total: list.total })}</span>
      </div>
      <ol className="grid gap-3" data-testid="cutover-steps">
        {list.steps.map((s, i) => (
          <li key={s.key} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[2rem_1fr_auto] sm:items-start" data-step={s.key}>
            <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{tr(`ops.cutover.${s.key}`)}</span>
                <Badge variant={s.done ? "success" : "outline"}>{s.done ? tr("platform.go_live.confirmed") : tr("platform.go_live.open")}</Badge>
              </div>
              {s.done && s.doneAt ? <span className="text-xs text-muted-foreground">{tr("platform.go_live.confirmed_by", { who: s.doneBy ?? "BEAM", when: fmt.format(s.doneAt) })}</span> : null}
              {s.note ? <span className="text-xs text-muted-foreground">{s.note === "no_suppression_source" ? tr("ops.imports.option.confirm_no_suppression_source") : s.note}</span> : null}
              <div className="flex flex-wrap gap-3 text-xs">
                {s.importId ? (
                  <Link href={`/admin/imports/${s.importId}`} className="underline-offset-4 hover:underline">
                    {tr("ops.imports.title")}
                  </Link>
                ) : null}
                {STEP_LINKS[s.key] ? (
                  <Link href={STEP_LINKS[s.key] as Route} className="underline-offset-4 hover:underline">
                    {tr("platform.go_live.runbook")} {STEP_LINKS[s.key]}
                  </Link>
                ) : null}
              </div>
            </div>
            {s.manual && canTick ? (
              <form action={tick} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="key" value={s.key} />
                <input type="hidden" name="done" value={s.done ? "false" : "true"} />
                {!s.done ? <input name="note" maxLength={500} placeholder={tr("platform.go_live.note")} aria-label={tr("platform.go_live.note")} className="h-9 rounded-md border px-2 text-sm" /> : null}
                <Button type="submit" size="sm" variant={s.done ? "outline" : "default"}>
                  {s.done ? tr("platform.go_live.withdraw") : tr("platform.go_live.confirm")}
                </Button>
              </form>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
