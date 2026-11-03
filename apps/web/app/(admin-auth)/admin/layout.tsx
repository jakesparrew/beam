import type { ReactNode } from "react";
import { adminAuthLocale, translator } from "@/lib/i18n";

/** Staff sign-in pages (no shell): a centred column with the brand. */
export default async function AdminAuthLayout({ children }: { children: ReactNode }) {
  const tr = translator(await adminAuthLocale());
  return (
    <div className="flex min-h-dvh items-start justify-center bg-muted/40 px-4 py-12">
      <main id="main-content" className="grid w-full max-w-md gap-6 rounded-lg border bg-background p-6 shadow-sm">
        <p className="text-lg font-semibold tracking-tight">{tr("platform.shell.brand")}</p>
        {children}
      </main>
    </div>
  );
}
