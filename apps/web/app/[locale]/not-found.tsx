import Link from "next/link";
import { URL_SEGMENT } from "@beam/core/i18n";
import { EmptyState } from "@beam/ui";
import { requestLocale, translator } from "@/lib/i18n";

/** 404 inside a locale (site and portal), in that locale. */
export default async function LocaleNotFound() {
  const locale = await requestLocale();
  const tr = translator(locale);
  return (
    <main id="main-content" className="mx-auto max-w-xl p-8" data-not-found="">
      <EmptyState
        title={<h1>{tr("platform.shell.not_found_title")}</h1>}
        description={tr("platform.shell.not_found_description")}
        action={<Link href={`/${URL_SEGMENT[locale]}` as never}>{tr("platform.shell.not_found_home")}</Link>}
      />
    </main>
  );
}
