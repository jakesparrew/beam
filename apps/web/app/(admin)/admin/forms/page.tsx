import Link from "next/link";
import { buttonVariants } from "@beam/ui";
import { FORM_KINDS, type FormKind, type FormStatus } from "@beam/core/forms";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { listForms, screenLabels } from "@/modules/forms/queries";
import { FormList } from "@/modules/forms/ui/admin/form-list";

type Search = { q?: string; status?: string; kind?: string };

const STATUSES: readonly FormStatus[] = ["draft", "published", "archived"];
const pick = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => (list.includes(v as T) ? (v as T) : undefined);

/** `/admin/forms` (`forms.write`, forms spec section 5): every form with its 30-day funnel. */
export default async function FormsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireStaff({ permission: "forms.write" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const labels = screenLabels(locale, ["list", "kind", "status"]);
  const status = pick(STATUSES, sp.status);
  const kind = pick<FormKind>(FORM_KINDS, sp.kind);
  const q = sp.q?.trim() || undefined;
  const rows = await listForms(await getAppDb(), { status, kind, q });
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{labels["list.title"] ?? "⟦forms.list.title⟧"}</h1>
        <Link href="/admin/forms/new" className={buttonVariants()}>
          {labels["list.new"] ?? "⟦forms.list.new⟧"}
        </Link>
      </header>
      <FormList rows={rows} labels={labels} locale={locale} searchParams={{ q: sp.q, status: sp.status, kind: sp.kind }} filtered={!!(q || status || kind)} />
    </div>
  );
}
