import Link from "next/link";
import { URL_SEGMENT } from "@beam/core/i18n";
import { EmptyState } from "@beam/ui";
import { requestLocale, translator } from "@/lib/i18n";

/** The 404 page, in the visitor's locale (platform spec section 5). */
export default async function NotFound() {
  const locale = await requestLocale();
  const tr = translator(locale);
  return (
    <main id="main-content" className="mx-auto max-w-xl p-8">
      <EmptyState
        title={<h1>{tr("platform.shell.not_found_title")}</h1>}
        description={tr("platform.shell.not_found_description")}
        action={<Link href={`/${URL_SEGMENT[locale]}` as never}>{tr("platform.shell.not_found_home")}</Link>}
      />
    </main>
  );
}
