import Link from "next/link";
import { safeReturnTo } from "@/lib/auth";
import { adminAuthLocale, loginLabels, translator } from "@/lib/i18n";
import { LoginForm } from "@/modules/platform/ui/login-form";

/** `/admin/login`: email and password, then the TOTP step (PL-3, PL-7). */
export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo } = await searchParams;
  const locale = await adminAuthLocale();
  const tr = translator(locale);
  const target = returnTo ? safeReturnTo(returnTo, "/admin") : undefined;
  return (
    <>
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("platform.login.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("platform.login.intro")}</p>
      </header>
      <LoginForm
        labels={loginLabels(tr, locale)}
        locale={locale}
        {...(target ? { returnTo: target } : {})}
        footer={
          <Link href="/admin/reset-password" className="text-sm underline">
            {tr("platform.login.forgot_password")}
          </Link>
        }
      />
    </>
  );
}
