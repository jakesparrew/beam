# Webinar switch-over: from the current tool to BEAM webinars on YouTube Live

How BEAM stops using its current webinar tool (WebinarGeek or Zoom) and runs every webinar natively
from Release 2: registration on the website and in the portal, the embedded YouTube Live player,
watch time, polls, CTAs, chat and questions inside BEAM, presenters in Google Meet (webinar spec
rules 7, 42 and 43, sections 9.3 and 12, webinar-P6). Owner: marketing with the technical
administrator. Audience: the owner, management, marketing and the technical administrator.

Until the switch-over the old tool stays a subprocessor and its registrants and attendees reach BEAM
through the weekly ops import (source `webinar_tool`, see `docs/runbooks/data-migration.md`). That
history keeps showing on each person's timeline ("Webinar registered (imported)", "Webinar attended
(imported)") and in segments after the switch-over; it never triggers an automation.

## 1. Before you start (two weeks ahead)

| Check | Where | Done when |
| --- | --- | --- |
| Google Workspace account of BEAM owns the YouTube channel; live streaming is enabled on the channel (YouTube needs up to 24 hours to enable it the first time) | YouTube Studio > Go live | Studio shows the stream dashboard |
| OAuth client and refresh token with the scopes `https://www.googleapis.com/auth/youtube` and `https://www.googleapis.com/auth/meetings.space.created` | Vercel env `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` (production and preview) | `/admin/system` shows the YouTube integration as configured; a test webinar on preview gets a broadcast id |
| Slack alerts reach the team | the `notify.slack` channel | the pre-flight test of section 4 posted its line |
| Subprocessor register lists "Google (YouTube Live / Meet) - webinar video - EU/US - viewer connection data while watching; presenter account data" | `docs/runbooks/subprocessors.md`, privacy notice | entry published; the DPA annex holds `docs/privacy/webinar-google.md` |
| DPIA decision on watch-time profiling recorded (only needed for the behaviour journeys) | `/admin/settings/dpia`, key `watch_time_profiling` | approved, or knowingly left open (the threshold journeys then stay draft; reminders and the no-show replay email work without it) |
| Load test of the heartbeat route on a preview deployment | `apps/web/scripts/load/webinar-heartbeat.ts` (300 viewers, 15 s, 10 minutes) | p95 below 300 ms and no 5xx, result pasted in the release PR |
| Roles: marketing and management hold `webinars.host`; sales and customer service see reports through `reports.read` | `/admin/settings/roles` | a marketing user opens `/admin/webinars` |

## 2. Rehearsal (one week ahead, on preview or `beam_dev`)

1. Create a live webinar at `/admin/webinars/new` with title and description in every offered
   language, the spoken language, a start in 2 hours and 60 minutes planned duration.
2. Add one poll and one CTA on the interactive page; publish. The page shows "creating YouTube
   broadcast" until the broadcast exists, then `published`. A red YouTube error means the OAuth
   setup is wrong: fix it and publish again.
3. Register yourself from `/nl/webinars/<slug>` with an `@demo.beam.be` address. The access email
   arrives with the personal link and the calendar file.
4. Open the host console (`/admin/webinars/<id>/host`), join the Meet link, start streaming from
   Meet (Activities > Live streaming, choose BEAM's broadcast). If Meet creates its own broadcast,
   use "Use different YouTube video" on the webinar page with that video id.
5. Watch through the personal link in another browser: accept the notice, answer the poll, click the
   CTA, post a chat message and a question. The host console shows them live.
6. End the stream. Within a few minutes the webinar is `ended`; once YouTube has processed the
   recording the replay plays through the same link. Open `/admin/webinars/<id>/report`: the
   registration, the live attendance, the poll answer and the CTA click are there, each in mode
   `live`; watch part of the replay and check that it appears under `replay`, not `live`.
7. Archive the rehearsal webinar.

## 3. Switch-over (week 10 of the plan)

| When | Step | Who |
| --- | --- | --- |
| Day -7 | Stop creating new webinars in the old tool. Webinars already announced there run there. | marketing |
| Day -7 | Create the next webinars in BEAM (publish them; live webinars need the YouTube broadcast). Point newsletter links, site pages and ads at `/<locale>/webinars/<slug>`. | marketing |
| Day 0 (after the last old-tool webinar) | Export the old tool's registrants and attendees of every webinar since the previous weekly import. | marketing |
| Day 0 | Import the files through `/admin/imports` with source `webinar_tool` (presets `webinargeek_registrants` / `webinargeek_attendees` or `zoom_registrants` / `zoom_attendees`): dry run, check the report (codes `missing_email`, `invalid_email`, `erased`), then run. Re-importing a file adds nothing. This is the **last import**. | marketing, technical administrator |
| Day 0 | Spot-check three persons: their timeline shows the imported registration and attendance; their segment fields count them. | marketing |
| Day 0 | Set the old tool to read-only (no new registrations, no automated emails from it). Record the date in the subprocessor register: "freeze". | marketing |
| Day 0 | Switch the flag `ff_webinar_portal` on (`/admin/system/flags`): the public list `/<locale>/webinars`, landing pages and the portal menu appear. Running viewers are never cut off by the flag. | technical administrator |
| Day +1 to +30 | Keep the final exports in the shared drive (restricted to management) for 30 days; the raw import parts in BEAM expire 30 days after the import. | management |
| Day +30 | Close the old tool's account and ask for deletion of its data in writing (keep the confirmation). Remove it from the subprocessor register and the privacy notice; delete the local export files. | owner |

## 4. Before every live webinar (pre-flight)

BEAM checks every `published` live and simulive webinar every 5 minutes in the hour before it starts
(`webinar.preflight`, rule 42):

- **60 minutes before**: a live webinar without a YouTube broadcast, or with a YouTube error, and a
  simulive webinar whose video is not processed yet, post one Slack line (High, "Webinar pre-flight
  t60") and create a task for the webinar owner. Fix it on the webinar page (publish again, or
  "Use different YouTube video").
- **15 minutes before**: a live webinar whose YouTube stream is not `ready`, `testing` or `live`
  posts one Slack line "stream not connected", and the host console shows a red banner. Start
  streaming from Meet (Activities > Live streaming) now. Registrants are never emailed about it.
- Each alert fires once per webinar and stage. A reschedule (a new start time) checks the new time
  again.

During the webinar: `webinar.sync_status` reads YouTube every minute. When it fails 10 times in a row
it posts "YouTube status sync failed"; when a webinar has been live for more than 5 minutes and no
viewer heartbeat arrived for 3 minutes it posts "heartbeats are failing" (once). The ops daily digest
lists the webinars of the next 48 hours with their broadcast state.

If YouTube does not report the status, use "Force live" and "Force ended" in the host console. If the
stream never starts, the webinar is marked `never_live` two hours after its start and the owner gets a
task: reschedule it (registrants get one email with the new time) or cancel it (registrants get the
cancellation email).

## 5. After the webinar

- No-shows are written at least 30 minutes after the end, once the replay situation is known
  (recording processed, replay switched off, or 48 hours passed); the no-show journey sends the
  replay link only when a replay exists.
- The report at `/admin/webinars/<id>/report` splits leads, customers and members (the status at
  registration) and counts bookings and purchases within the chosen period (7 to 180 days; the
  webinar's own window by default). Registration is never counted as attendance.
- "Download report CSV" holds aggregates only. "Download registrants CSV" contains names and email
  addresses: it needs `persons.export`, is audited (`webinar.registrants_exported`) and the file
  expires after 7 days. Do not forward it outside BEAM's staff.
- Watch segments and interactions are deleted after 2 years and registrations after 3 years by the
  retention sweep; the report then shows "Watch detail removed after 2 years".

## 6. Rollback

There is no technical rollback to the old tool: its account stays available (read-only) until day
+30. If BEAM webinars cannot run for a scheduled date (YouTube or Google outage):

1. Keep the BEAM webinar; reschedule it to a new time (registrants get one email), or
2. stream the session with any RTMP encoder to the same YouTube broadcast from YouTube Studio (the
   embedded player and watch time keep working), or
3. as a last resort before day +30, run that one session in the old tool and import its attendees
   afterwards through the ops import; cancel the BEAM webinar with "notify" so registrants receive
   the cancellation email, and send the old tool's link yourself.

Record every incident in `docs/runbooks/incident.md` with the webinar id; never paste personal
links, tokens or registrant lists into tickets or chat.
