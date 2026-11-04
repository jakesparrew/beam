import { EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, listFlags, listStaffUsers } from "@/modules/platform/queries";
import { CustomerTesterForm, FlagEditor } from "@/modules/platform/ui/flag-editor";

/**
 * `/admin/settings/flags` (`flags.manage`): the declared flags joined with their rows (a flag
 * without a row is `off`, PL-43): state, staff and person testers, last change; and the customer
 * tester switch (`setCustomerTester`). The person picker degrades to an id field (crm search).
 */
export default async function FlagsPage() {
  await requireStaff({ permission: "flags.manage" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string) => tr(`platform.flags.${k}`);
  const db = await getAppDb();
  const [flags, staff] = await Promise.all([listFlags(db), listStaffUsers(db, { status: "active" })]);
  const labels = catalogueSection(locale, "platform.flags");
  const errors = catalogueSection(locale, "platform.errors");
  const staffOptions = staff.rows.map((u) => ({ id: u.id, name: u.name ?? u.email }));

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      {flags.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <ul className="grid gap-4">
          {flags.map((f) => (
            <li key={f.key}>
              <FlagEditor flag={{ ...f, updatedAt: f.updatedAt ? f.updatedAt.toISOString() : null }} staff={staffOptions} labels={labels} errors={errors} />
            </li>
          ))}
        </ul>
      )}
      <CustomerTesterForm labels={labels} errors={errors} />
    </div>
  );
}
