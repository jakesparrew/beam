import Link from "next/link";
import { Button, EmptyState } from "@beam/ui";
import { adminLocale, translator } from "@/lib/i18n";

/** A missing automation id (automation spec 5). */
export default async function AutomationNotFound() {
  const tr = translator(await adminLocale());
  return (
    <div data-not-found="">
      <EmptyState
        title={tr("automation.errors.not_found")}
        action={
          <Button variant="outline" asChild>
            <Link href="/admin/automations">{tr("automation.list.title")}</Link>
          </Button>
        }
      />
    </div>
  );
}
