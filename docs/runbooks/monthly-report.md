# Runbook: monthly SLA report

Owner: Sidestream (prepares), BEAM owner or technical_admin (reviews and sends). Source: platform
spec PL-89, PL-89a.

## What happens automatically

`platform.build_monthly_report` runs at 07:10 Brussels time on the 1st of each month and writes a
draft for the previous month on `/admin/system/reports`:

- uptime and downtime from the Better Stack SLA API (target 99.5 %; red below it);
- security incidents by severity;
- support requests per severity: received, resolved, median first response, breaches;
- dead jobs, Slack alerts sent;
- backups OK and failed, the last restore drill (written by `record-backup.ts`);
- AI spend, database size and files size.

A rerun updates the draft; a sent report is never changed.

## Review (first working day of the month)

1. Open the draft. If Better Stack could not be reached (the job retried and gave up), enter the
   uptime by hand from the Better Stack dashboard; the source becomes "entered by hand".
2. Add notes: incidents and their resolution, failed backups that were re-run, key rotations,
   rollbacks, MFA resets by script, anything below target and what is done about it.
3. "Send report": the email `platform.monthly_report` goes to `settings.support.report_recipients`
   with the figures in the body, and the report becomes read-only. Sending twice is refused.

## If the job did not run

Check `/admin/system/jobs` for `platform.build_monthly_report` (dead or missing). Retry it, or
enqueue it for a given month from a console with `{ "monthOn": "YYYY-MM-01" }`.
