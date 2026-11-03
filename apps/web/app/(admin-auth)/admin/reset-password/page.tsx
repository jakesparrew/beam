import Link from "next/link";
import { adminAuthLocale, translator } from "@/lib/i18n";
import { RequestResetForm } from "@/modules/platform/ui/login-form";

/** `/admin/reset-password`: always "If the address is known we sent a link" (PL-7, PL-10). */
export default async function RequestResetPage() {
  const tr = translator(await adminAuthLocale());
  return (
    <>
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("platform.reset.request_title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("platform.reset.request_intro")}</p>
      </header>
      <RequestResetForm labels={{ email: tr("platform.login.email"), submit: tr("platform.reset.request_submit"), sent: tr("platform.reset.sent") }} />
      <Link href="/admin/login" className="text-sm underline">
        {tr("platform.reset.back_to_login")}
      </Link>
    </>
  );
}
