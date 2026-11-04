# Runbook: support and SLA

Owner: Sidestream. Source: platform spec PL-86 to PL-88, proposal section 7, blueprint 73.

## Support hours

Monday to Friday 09:00–18:00 Europe/Brussels, excluding Belgian public holidays (1 January,
Easter Monday, 1 May, Ascension Day, Whit Monday, 21 July, 15 August, 1 November, 11 November,
25 December). Critical requests also count Saturday, Sunday and public holidays 10:00–18:00.

## Response targets (first response)

| Severity | Example | Target |
| --- | --- | --- |
| critical | Nobody can book or pay, or the site is down. | 120 minutes on a business day; 240 minutes on a weekend day or public holiday. Also call the emergency number (`settings.support.emergency_phone`). |
| high | An important feature fails for some people. | 240 business minutes |
| normal | Something is wrong but there is a workaround. | 540 business minutes |
| improvement | An idea or a small change. | 1080 business minutes |

A request received outside support hours starts counting at the next opening. `slaDueAt()`
computes `response_due_at`; `v_support_sla` marks a request breached when the first response is
later than that.

## Channels

- **In the app**: any staff user, user menu → "Report a problem" (or `/admin/support`). The
  request is stored with the page URL and request id and posted to Slack.
- **Email, Slack, WhatsApp, phone**: Sidestream logs it on `/admin/system/support` → "Log a
  request received outside the app" with the real received time.

## Handling

1. Check `/admin/system/support` (default: open and responded; late ones in red). The nav shows
   the number of open requests.
2. Assign yourself, answer the reporter, then set status `responded` with a response note (the
   note is appended to the description with the time; `first_response_at` is set).
3. Link an incident when it is a security matter (`incident.md`).
4. `resolved` when fixed; `closed` once the reporter agrees. Transitions: `open → responded →
   resolved → closed`, `open → resolved`, `resolved → open`. Every change is audited
   `support.update`.

Reporters follow their requests on `/admin/support`. The monthly report counts requests, median
first response and breaches per severity.
