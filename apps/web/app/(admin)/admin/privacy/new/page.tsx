import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { Alert, AlertDescription, Button, Input, Label } from "@beam/ui";
import { PRIVACY_KINDS, RECTIFY_FIELDS, type PrivacyKind } from "@beam/core/ops";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { getPerson, searchPersons } from "@/modules/crm/api";
import { createPrivacyRequest } from "@/modules/ops/privacy/actions";

/**
 * `/admin/privacy/new` (ops spec 5, rule 59): step 1 finds the person (crm search, `?q=`), step 2
 * (`?personId=`) picks the kind, an optional verification note and, for a rectification, the
 * fields to correct (names only). The kinds offered follow the creator's permissions
 * (`persons.export`, `persons.erase`, `persons.write`); `createPrivacyRequest` checks them again.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_KEYS = new Set(["forbidden", "validation", "not_found", "conflict"]);
const KIND_PERMISSION = { export: "persons.export", erase: "persons.erase", restrict: "persons.erase", object: "persons.erase", rectify: "persons.write" } as const;

export default async function NewPrivacyRequestPage({ searchParams }: { searchParams: Promise<{ q?: string; personId?: string; error?: string }> }) {
  const actor = await requireStaff();
  const kinds = PRIVACY_KINDS.filter((k) => hasPermission(actor, KIND_PERMISSION[k]));
  if (!kinds.length) await requireStaff({ permission: "persons.erase" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const db = await getAppDb();
  const q = (sp.q ?? "").trim();
  const personId = sp.personId && UUID.test(sp.personId) ? sp.personId : undefined;
  const person = personId ? await getPerson(db, personId).catch(() => null) : null;
  const error = sp.error ? (ERROR_KEYS.has(sp.error) ? sp.error : "validation") : null;

  async function create(fd: FormData) {
    "use server";
    const str = (k: string) => {
      const v = fd.get(k);
      return typeof v === "string" ? v : "";
    };
    const kind = str("kind") as PrivacyKind;
    const note = str("verificationNote").trim();
    const fields = fd.getAll("rectifyFields").filter((v): v is string => typeof v === "string");
    const result = await createPrivacyRequest({
      personId: str("personId"),
      kind,
      ...(note ? { verificationNote: note } : {}),
      ...(kind === "rectify" ? { rectifyFields: fields } : {}),
    });
    if (result.ok) redirect(`/admin/privacy/${result.data.requestId}` as never);
    redirect(`/admin/privacy/new?personId=${encodeURIComponent(str("personId"))}&error=${result.error.code}` as never);
  }

  if (!person) {
    const matches = q ? await searchPersons(db, { q, limit: 20 }) : [];
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold">{tr("ops.privacy.new")}</h1>
        <form method="get" role="search" className="grid max-w-xl gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="grid gap-1">
            <Label htmlFor="privacy-q">{tr("platform.users.search")}</Label>
            <Input id="privacy-q" name="q" defaultValue={q} placeholder={soft("crm.persons.list.search_placeholder")} autoFocus />
          </div>
          <Button type="submit">{tr("platform.users.search")}</Button>
        </form>
        {matches.length ? (
          <ul className="grid max-w-xl gap-2">
            {matches.map((m) => (
              <li key={m.personId}>
                <Link href={`/admin/privacy/new?personId=${m.personId}` as Route} className="flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 py-2 hover:bg-accent">
                  <span className="font-medium">{m.name}</span>
                  <span className="text-sm text-muted-foreground">{m.customerNumber}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : q ? (
          <p className="text-sm text-muted-foreground">{tr("ops.privacy.empty")}</p>
        ) : null}
      </div>
    );
  }

  const name = [person.firstName, person.lastName].filter(Boolean).join(" ");
  return (
    <div className="grid max-w-2xl gap-6">
      <h1 className="text-2xl font-semibold">{tr("ops.privacy.new")}</h1>
      <p className="font-medium">{name || person.id}</p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{tr(`platform.errors.${error}`)}</AlertDescription>
        </Alert>
      ) : null}
      <form action={create} data-testid="privacy-new" className="grid gap-4">
        <input type="hidden" name="personId" value={person.id} />
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{tr("platform.jobs.col_kind")}</legend>
          {kinds.map((k, i) => (
            <label key={k} className="flex min-h-11 items-center gap-2">
              <input type="radio" name="kind" value={k} defaultChecked={i === 0} required />
              {tr(`ops.privacy.kind.${k}`)}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-1">
          <Label htmlFor="privacy-note">{tr("ops.privacy.verification_note")}</Label>
          <textarea id="privacy-note" name="verificationNote" maxLength={500} rows={3} className="rounded-md border bg-background p-2 text-sm" />
        </div>
        {kinds.includes("rectify") ? (
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{tr("ops.privacy.kind.rectify")}</legend>
            {RECTIFY_FIELDS.map((f) => (
              <label key={f} className="flex min-h-11 items-center gap-2">
                <input type="checkbox" name="rectifyFields" value={f} />
                {tr(`ops.privacy.rectify_field.${f}`)}
              </label>
            ))}
          </fieldset>
        ) : null}
        <Button type="submit" className="w-fit">
          {tr("ops.privacy.new")}
        </Button>
      </form>
    </div>
  );
}
