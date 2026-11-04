# Runbook: security incidents

Owner: Sidestream (registers and handles), BEAM owner (informed, decides on notifications to the
Data Protection Authority and to data subjects). Source: platform spec PL-73, PL-73a, blueprint 65.

## When

Anything that may affect the confidentiality, integrity or availability of personal data: a
leaked secret, unauthorised access, a lost device with an active session, data sent to the wrong
person, a critical or high pentest finding, a failed restore drill, prolonged downtime.

## Steps

1. **Register at once** on `/admin/system/incidents` → "Record an incident": title, severity
   (`critical`, `high`, `normal`) and discovery time. `critical` and `high` post to Slack.
   Write ids, never customer names or health data.
2. **Contain**: revoke sessions (`/admin/settings/users/<id>` → "Sign out everywhere"), disable
   accounts, rotate secrets (`rotate-keys.md`), switch a feature flag off, or roll back
   (`rollback.md`). Set status `contained`.
3. **Inform BEAM within 24 hours** of discovery (contractual limit). Fill "BEAM notified at"; it
   cannot be changed afterwards. After 20 hours without it, `platform.check_alerts` posts a
   reminder to Slack.
4. **Fill the seven fields** as you learn more: discovery time, systems affected, data affected,
   risk, actions taken, notifications (DPA within 72 hours when required, data subjects when the
   risk is high; BEAM decides), resolution.
5. **Resolve** when the cause is removed and the data is safe: status `resolved`, resolution
   filled. Transitions: `open → contained → resolved`, `open → resolved`, and `resolved → open`
   with a note (reopening clears the resolution time). Anything else is refused.
6. **Learn**: link related support requests to the incident on `/admin/system/support`, add a
   test or a control, and mention the incident in the monthly report.

## Severity guide

| Severity | Examples |
| --- | --- |
| critical | Personal or health data exposed to outsiders; production down; payment data at risk. |
| high | A secret leaked without known misuse; a critical/high pentest finding; a failed restore drill. |
| normal | A contained mistake with no exposure; a low pentest finding worth tracking. |

An open critical or high incident blocks the go-live item `security_confirmed` (PL-85).
