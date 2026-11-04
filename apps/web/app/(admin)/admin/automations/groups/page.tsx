import Link from "next/link";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { automationLabels, listGroups } from "@/modules/automation/queries";

/**
 * `/admin/automations/groups` (`automations.write`, automation spec 5): the V1 read-only table of
 * groups (key, exclusive, lane, priority, automations); editing comes with automation-P7 (R2).
 */
export default async function AutomationGroupsPage() {
  await requireStaff({ permission: "automations.write" });
  const locale = await adminLocale();
  const l = automationLabels(locale, ["groups", "common"]);
  const groups = await listGroups(await getAppDb());
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <Link href="/admin/automations" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          {l["common.back"]}
        </Link>
        <h1 className="text-2xl font-semibold">{l["groups.title"]}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{l["groups.description"]}</p>
      </div>
      <Table data-testid="group-table">
        <TableHeader>
          <TableRow>
            <TableHead>{l["groups.col_key"]}</TableHead>
            <TableHead>{l["groups.col_name"]}</TableHead>
            <TableHead>{l["groups.col_exclusive"]}</TableHead>
            <TableHead>{l["groups.col_lane"]}</TableHead>
            <TableHead className="text-right">{l["groups.col_priority"]}</TableHead>
            <TableHead className="text-right">{l["groups.col_count"]}</TableHead>
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
