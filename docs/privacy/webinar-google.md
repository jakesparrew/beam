# Webinars: Google (YouTube Live and Meet) as subprocessor

Source: webinar spec section 9.3 (blueprint 18 "GDPR/subprocessor implications", 58, 66).
Written by webinar-P4. This text is the input for the DPA annex, the subprocessor register and
the privacy notice; legal wording in the published notice may differ, the facts below may not.

## Roles

- **Google Ireland Ltd** provides YouTube (video delivery of the webinar stream and its recording)
  and Google Workspace (Google Meet, where presenters meet and stream from).
- **Meet:** Google is BEAM's **processor** under the Google Workspace Data Processing Amendment.
- **Embedded YouTube player:** Google acts as an **independent controller** for the connection
  data it collects under the YouTube terms of service.
- **BEAM** is controller for everything stored in BEAM: registrations, watch time, poll answers,
  CTA clicks, chat messages and questions.

## Data Google receives

| Who | Data | Not sent |
| --- | --- | --- |
| Viewers | IP address, user agent, player interaction and device identifiers set by the embed (localStorage), the unlisted video id | name, email address, BEAM ids, poll answers, chat and question text, watch time |
| Presenters and staff | name, email address, video and audio in Meet | |

Chat, polls, CTAs and watch time are native to BEAM. Video titles and descriptions contain no
personal data. The YouTube broadcast carries only a technical marker (`beam-webinar:<webinar id>`)
in its description, no person data.

## Location and transfer

EU and US. Transfer mechanism: EU-US Data Privacy Framework (Google LLC is certified), with the
Standard Contractual Clauses as fallback.

**Subprocessor register entry:** "Google (YouTube Live / Meet) - webinar video - EU/US - viewer
connection data while watching; presenter account data".

## Measures

- The player uses the privacy-enhanced embed domain `youtube-nocookie.com`.
- **Click to load:** nothing from Google loads until the viewer reads the notice and chooses to
  load the video. Wording version `player_notice_v1`; the version is stored on the viewer's
  `started` interaction, so BEAM can show which text a viewer saw.
- Videos are **unlisted**; the personal access link never reaches YouTube (token pages send
  `Referrer-Policy: no-referrer`, the token travels in a request header, not in the player URL).
- YouTube live chat is not used; BEAM's own chat is moderated by the host.
- When the embedded player fails, the fallback `youtube.com` link says that it leaves BEAM.
- Viewer endpoints log only the route, the webinar id, the duration and the status: never the
  token or personal data.

## DPIA: watch-time profiling

Automations that act on watch thresholds (15 minutes, 30 minutes, half, end), attendance or CTA
clicks are watch-time profiling (blueprint 66). These behaviour journeys stay in draft until ops'
`dpia_records` holds an approved `watch_time_profiling` entry (`ops.isDpiaApproved`); automation's
activation checks it. The same gate keeps watch-time fields out of segments.

The reminder journey and the no-show replay email are service messages about a registration (no
profiling) and are active from Release 2.

## Retention and erasure

- `watch_segments` and `webinar_interactions`: 730 days; `webinar_registrations`: 1,095 days
  (ops seeds the retention policies, the webinar module runs the sweeps).
- Erasure deletes the person's registrations with their segments, interactions and moderation
  rows. YouTube holds nothing that identifies the person, so there is nothing to delete at Google;
  the erasure report states "Google/YouTube: no personal data sent by BEAM".
- The subject export contains the registrations, the merged watch time per mode with thresholds,
  the raw watch segments (JSON and CSV), the interactions and the moderation actions.

## Until the switch-over (V1 stopgap)

Until Release 2 the current tool (WebinarGeek or Zoom) stays a subprocessor holding registrant
name, email address and attendance. The ops import copies only email address, name, locale,
registration time, attendance, mode and watched minutes, one way into BEAM, through a weekly CSV
export. The old tool stays in the subprocessor register until its account is closed, 30 days
after the switch-over (runbook `docs/runbooks/webinar-switch-over.md`).
