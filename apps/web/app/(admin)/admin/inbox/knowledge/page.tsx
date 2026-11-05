import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Alert, AlertDescription, Badge, Button, Input, Label, Textarea } from "@beam/ui";
import { formatDateTime, LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { actorHasPermission, getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { adminLocale, translator } from "@/lib/i18n";
import { saveKnowledgeArticle } from "@/modules/crm/knowledge/actions";
import { listKnowledgeArticles, type KnowledgeArticleRow } from "@/modules/crm/knowledge/queries";

const LOCALE_KEY: Record<Locale, string> = { "nl-BE": "nl_BE", "fr-BE": "fr_BE", en: "en" };
const ERRORS = new Set(["key_taken", "missing", "too_long", "forbidden"]);

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/** The editor's submit: one `saveKnowledgeArticle` call, then back to the list (or the form with the error). */
async function saveArticleForm(form: FormData) {
  "use server";
  const id = field(form, "id") || undefined;
  const localized = (prefix: string): LocalizedText => Object.fromEntries(LOCALES.map((l) => [l, field(form, `${prefix}_${l}`)]));
  const result = await saveKnowledgeArticle({ id, key: field(form, "key").trim(), title: localized("title"), body: localized("body"), isActive: form.get("isActive") === "on" });
  if (result.ok) redirect("/admin/inbox/knowledge?saved=1" as never);
  const fields = result.error.fields ?? {};
  const code =
    result.error.code === "forbidden"
      ? "forbidden"
      : fields.key === "taken"
        ? "key_taken"
        : Object.values(fields).includes("too_long")
          ? "too_long"
          : Object.values(fields).includes("missing_locales")
            ? "missing"
            : "other";
  redirect(`/admin/inbox/knowledge?error=${code}&${id ? `edit=${id}` : "new=1"}` as never);
}

/**
 * `/admin/inbox/knowledge` (R4, crm spec 5.1): the BEAM policies AI reply drafts use (rule 3.58).
 * Key, title, active and last edit per article; create and edit with every language
 * (`settings.write`); an inactive article is never in a prompt. `persons.read` to view.
 */
export default async function InboxKnowledgePage({ searchParams }: { searchParams: Promise<{ edit?: string; new?: string; saved?: string; error?: string }> }) {
  const actor = await requireStaff({ permission: "persons.read" });
  if (!(await flag("ff_crm_inbox", actor))) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const k = (key: string) => tr(`crm.inbox.knowledge.${key}`);
  const canEdit = actorHasPermission(actor, "settings.write");
  const db = await getAppDb();
  const articles = await listKnowledgeArticles(db, { includeInactive: true });

  const editing: KnowledgeArticleRow | null = sp.edit ? (articles.find((a) => a.id === sp.edit) ?? null) : null;
  const showForm = canEdit && (sp.new === "1" || !!editing);
  const error = sp.error ? (ERRORS.has(sp.error) ? k(`error_${sp.error}`) : k("error")) : null;

  return (
    <div className="grid gap-6">
      <Link href="/admin/inbox" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        {k("back")}
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{k("title")}</h1>
          <p className="max-w-prose text-sm text-muted-foreground">{k("intro")}</p>
        </div>
        {canEdit && !showForm ? (
          <Button asChild>
            <Link href={"/admin/inbox/knowledge?new=1" as never}>{k("new")}</Link>
          </Button>
        ) : null}
      </header>

      {sp.saved ? (
        <Alert>
          <AlertDescription>{k("saved")}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {showForm ? (
        <form action={saveArticleForm} className="grid gap-4 rounded-md border p-4">
          {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
          <div className="grid gap-1">
            <Label htmlFor="kb-key">{k("key")}</Label>
            <Input id="kb-key" name="key" required pattern="[a-z0-9_\-]{2,64}" defaultValue={editing?.key ?? ""} className="max-w-sm font-mono" />
            <p className="text-xs text-muted-foreground">{k("key_hint")}</p>
          </div>
          {LOCALES.map((l) => (
            <fieldset key={l} className="grid gap-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{tr(`crm.enums.locale.${LOCALE_KEY[l]}`)}</legend>
              <div className="grid gap-1">
                <Label htmlFor={`kb-title-${l}`}>{k("article_title")}</Label>
                <Input id={`kb-title-${l}`} name={`title_${l}`} required maxLength={200} defaultValue={editing?.title[l] ?? ""} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`kb-body-${l}`}>{k("body")}</Label>
                <Textarea id={`kb-body-${l}`} name={`body_${l}`} required maxLength={5000} rows={6} defaultValue={editing?.body[l] ?? ""} />
              </div>
            </fieldset>
          ))}
          <p className="text-xs text-muted-foreground">{k("body_hint")}</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={editing ? editing.isActive : true} className="size-4" />
            <span>{k("active")}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">{k("save")}</Button>
            <Button variant="outline" asChild>
              <Link href="/admin/inbox/knowledge">{k("cancel")}</Link>
            </Button>
          </div>
        </form>
      ) : null}

      {articles.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{k("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">{k("key")}</th>
                <th className="px-3 py-2 font-medium">{k("article_title")}</th>
                <th className="px-3 py-2 font-medium">{k("status")}</th>
                <th className="px-3 py-2 font-medium">{k("last_edited")}</th>
                {canEdit ? <th className="px-3 py-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {articles.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{a.key}</td>
                  <td className="px-3 py-2">{a.title[locale] ?? a.key}</td>
                  <td className="px-3 py-2">
                    <Badge variant={a.isActive ? "default" : "secondary"}>{a.isActive ? k("active") : k("inactive")}</Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDateTime(a.updatedAt, locale, "short")}
                    {a.updatedByName ? ` · ${a.updatedByName}` : ""}
                  </td>
                  {canEdit ? (
                    <td className="px-3 py-2 text-right">
                      <Link href={`/admin/inbox/knowledge?edit=${a.id}` as never} className="underline-offset-4 hover:underline">
                        {k("edit")}
                      </Link>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
