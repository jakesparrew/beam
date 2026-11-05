/**
 * Poll results per option per mode (rule 39, scenario 5: live and replay answers stay apart;
 * webinar-P6). A server component; texts arrive resolved in the staff locale.
 */
import { formatNumber, type Locale } from "@beam/core/i18n";
import { Badge, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { WATCH_MODES, type WatchMode } from "@beam/core/webinar";

export type PollResultView = {
  pollId: string;
  key: string;
  question: string;
  isActive: boolean;
  respondents: Record<WatchMode, number>;
  options: Array<{ key: string; label: string; counts: Record<WatchMode, number> }>;
};

export type PollResultsLabels = { title: string; empty: string; option: string; respondents: string; inactive: string; modes: Record<WatchMode, string> };

export function PollResults({ polls, labels, locale }: { polls: readonly PollResultView[]; labels: PollResultsLabels; locale: Locale }) {
  return (
    <section aria-labelledby="report-polls" className="grid gap-4">
      <h2 id="report-polls" className="text-lg font-semibold">
        {labels.title}
      </h2>
      {polls.length === 0 ? <p className="text-sm text-muted-foreground">{labels.empty}</p> : null}
      {polls.map((p) => (
        <div key={p.pollId} className="overflow-x-auto">
          <Table data-testid={`report-poll-${p.key}`}>
            <TableCaption className="caption-top text-left text-foreground">
              <span className="font-medium">{p.question}</span> <span className="text-muted-foreground">({p.key})</span>{" "}
              {p.isActive ? null : <Badge variant="outline">{labels.inactive}</Badge>}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{labels.option}</TableHead>
                {WATCH_MODES.map((m) => (
                  <TableHead key={m} scope="col" className="text-right">
                    {labels.modes[m]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.options.map((o) => (
                <TableRow key={o.key}>
                  <TableHead scope="row" className="font-normal">
                    {o.label}
                  </TableHead>
                  {WATCH_MODES.map((m) => (
                    <TableCell key={m} className="text-right tabular-nums" data-mode={m}>
                      {formatNumber(o.counts[m], locale)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              <TableRow>
                <TableHead scope="row">{labels.respondents}</TableHead>
                {WATCH_MODES.map((m) => (
                  <TableCell key={m} className="text-right font-medium tabular-nums" data-mode={m}>
                    {formatNumber(p.respondents[m], locale)}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      ))}
    </section>
  );
}
