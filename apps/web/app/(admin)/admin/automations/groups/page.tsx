import Link from "next/link";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, listGroups } from "@/modules/automation/queries";
import { GroupFormDialog } from "@/modules/automation/ui/group-form";

/**
 * `/admin/automations/groups` (automation spec 5): the groups (key, exclusive, lane, priority,
 * automations). Viewing needs `automations.write`; with `automations.publish` (R2,
 * automation-P7) the page offers "New group" and "Edit" per row (`upsertGroup`) and links to the
 * rules page and the conflict report.
 */
export default async function AutomationGroupsPage() {
  const actor = await requireStaff({ permission: "automations.write" });
  const canEdit = hasPermission(actor, "automations.publish");
  const locale = await adminLocale();
  const l = automationLabels(locale, ["groups", "common", "errors"]);
  const groups = await listGroups(await getAppDb());
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <Link href="/admin/automations" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
            {l["common.back"]}
          </Link>
          <h1 className="text-2xl font-semibold">{l["groups.title"]}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{l["groups.description"]}</p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/admin/automations/rules">{l["groups.rules_link"]}</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/admin/automations/conflicts">{l["groups.conflicts_link"]}</Link>
            </Button>
            <GroupFormDialog labels={l} />
          </div>
        ) : null}
      </div>
      {canEdit ? null : <p className="text-sm text-muted-foreground">{l["groups.read_only"]}</p>}
      <Table data-testid="group-table">
        <TableHeader>
          <TableRow>
            <TableHead>{l["groups.col_key"]}</TableHead>
            <TableHead>{l["groups.col_name"]}</TableHead>
            <TableHead>{l["groups.col_exclusive"]}</TableHead>
            <TableHead>{l["groups.col_lane"]}</TableHead>
            <TableHead className="text-right">{l["groups.col_priority"]}</TableHead>
            <TableHead className="text-right">{l["groups.col_count"]}</TableHead>
            {canEdit ? (
              <TableHead>
                <span className="sr-only">{l["groups.col_actions"]}</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((g) => (
            <TableRow key={g.id} data-key={g.key}>
              <TableCell className="font-mono text-xs">{g.key}</TableCell>
              <TableCell>
                {g.name}
                {g.description ? <span className="block text-xs text-muted-foreground">{g.description}</span> : null}
              </TableCell>
              <TableCell>{g.isExclusive ? <Badge variant="outline">{l["common.yes"]}</Badge> : l["common.no"]}</TableCell>
              <TableCell className="font-mono text-xs">{g.lane ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{g.priority}</TableCell>
              <TableCell className="text-right tabular-nums">{g.automationCount}</TableCell>
              {canEdit ? (
                <TableCell className="text-right">
                  <GroupFormDialog
                    group={{ id: g.id, key: g.key, name: g.name, description: g.description, isExclusive: g.isExclusive, lane: g.lane, priority: g.priority }}
                    labels={l}
                  />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
