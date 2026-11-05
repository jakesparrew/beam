/**
 * `/admin/forms/[formId]/submissions/[submissionId]` (view: `forms.write` and `persons.read`;
 * reveal: `persons.sensitive_read`; delete: `forms.publish`; forms spec section 5): the submission
 * rendered against its pinned version in the staff locale, with the sensitive answers as a locked
 * card and the resend, revoke and delete actions.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getSubmission, screenLabels } from "@/modules/forms/queries";
import { SubmissionDetail } from "@/modules/forms/ui/admin/submission-detail";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function SubmissionPage({ params }: { params: Promise<{ formId: string; submissionId: string }> }) {
  const actor = await requireStaff({ permission: "forms.write" });
  if (!hasPermission(actor, "persons.read")) notFound();
  const { formId, submissionId } = await params;
  if (!UUID.test(formId) || !UUID.test(submissionId)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const detail = await getSubmission(await getAppDb(), submissionId, locale);
  if (!detail || detail.formId !== formId) notFound();
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{tr("forms.submissions.detail_title", { date: formatDateTime(detail.startedAt, locale) })}</h1>
          <p className="text-sm text-muted-foreground">{detail.formName[locale] || detail.formSlug}</p>
        </div>
        <Link className="text-sm underline" href={`/admin/forms/${formId}/submissions` as never}>
          {tr("forms.submissions.back_to_list")}
        </Link>
      </header>
      <SubmissionDetail
        detail={detail}
        locale={locale}
        labels={screenLabels(locale, ["submissions", "builder"])}
        can={{ write: true, publish: hasPermission(actor, "forms.publish"), reveal: hasPermission(actor, "persons.sensitive_read") }}
      />
    </div>
  );
}
