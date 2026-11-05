# Troubleshooting

For: owner (**Eigenaar**) and technical admin (**Technisch beheerder**). Every role reads the first
section.

## How do I report a problem? (everyone)

1. In the back office, open the user menu and click **Een probleem melden**. Report from the page
   where the problem happened: BEAM attaches the page address and a request id for the technical
   partner.
2. Fill **Titel** and **Wat is er gebeurd?**: what you did, what you expected, what happened instead,
   and for whom (a customer number, never health information).
3. Choose the **Ernst** (severity):

   | Severity | Example (as the form shows it) | First response within (support hours) |
   | --- | --- | --- |
   | **Kritiek** | **Niemand kan boeken of betalen, of de site ligt plat.** | 2 hours on business days; 4 hours on weekends and public holidays |
   | **Hoog** | **Een belangrijke functie werkt voor sommige mensen niet.** | 4 hours |
   | **Normaal** | **Er loopt iets mis, maar er is een omweg.** | 1 business day |
   | **Verbetering** | **Een idee of een kleine wijziging die u graag zou zien.** | 2 business days |

   Support hours are Monday to Friday 09:00 to 18:00 (Brussels), outside Belgian public holidays;
   critical problems are also handled on weekends and public holidays from 10:00 to 18:00.
4. Click **Melding versturen**. For a critical problem also call the emergency number the form shows
   (**Bel bij kritieke problemen ook ...**).

![Mijn gemelde problemen](img/troubleshooting-my-support.png)

Follow your reports on **Mijn gemelde problemen** (`/admin/support`): each one goes from **Open** to
**Beantwoord**, **Opgelost** and **Gesloten**.

## How do I see whether the platform is healthy?

![Systeem: health overview](img/troubleshooting-system.png)

Open **Systeem** (**De toestand van het platform in één oogopslag.**; it refreshes every 30 seconds).
The tiles that matter most:

- **Laatste tick**: the background engine runs every minute. If the last tick is more than a few
  minutes old, emails, reminders and invoices stop going out: report it as **Kritiek**.
- **Taken**: background jobs by status; **Vastgelopen** (dead) jobs need a look (next section).
- **Integraties (24 u)** and **Webhooks (24 u)**: calls to and from Mollie, Resend, Billit and the
  other providers in the last 24 hours, with failures.
- **Open incidenten**, **Open supportaanvragen**, **Beschikbaarheid vorige maand** (last month's
  uptime) and **Go-live-checklist**.

## How do I handle a failed background job?

![Achtergrondtaken](img/troubleshooting-jobs.png)

Sending an email, syncing an invoice to Billit or creating a payment are background jobs. A job that
fails is retried automatically with growing pauses; after the last attempt it is **Dood** (dead) and
BEAM alerts the technical partner on Slack.

1. Open **Systeem** > **Achtergrondtaken** (**Taken die definitief mislukten, zijn dood.**). Filter on
   **Status**.
2. Open the job: **Laatste fout** (last error) and, for provider calls, the **HTTP-status** tell what
   went wrong.
3. Fix the cause first (for example complete the company details, correct a customer's address, or
   wait until the provider is back), then click **Opnieuw proberen**.
4. A job that should not run any more: **Verwijderen** with a **Reden**. Only dead jobs can be retried
   or removed (**Alleen dode taken kunnen opnieuw geprobeerd of verwijderd worden.**).

When you do not know the cause, do not retry repeatedly: report it as **Hoog** with the job's id.

## How do I log a request that came by phone, email, Slack or WhatsApp?

![Supportregister](img/troubleshooting-support.png)

**Systeem** > **Supportregister** lists every support request with its **Ernst**, **Kanaal**,
**Ontvangen** (received), **Antwoord uiterlijk** (response due) and **Eerste antwoord**. Requests that
did not come through the app are registered here with the time they really arrived, so the response
times in the monthly report are honest. Late ones show **Te laat**. The monthly report itself is on
**Maandrapporten**.

## Common situations

| What you see | What to do |
| --- | --- |
| A customer did not receive the magic link or a confirmation | Check the person's emails on their page, or **E-mail** > **Berichten**. A bounced or suppressed address must be corrected on the person; the customer can request a new link. |
| A payment shows as open although the customer paid | Open the order on **Betalingen opvolgen**; payment status updates arrive from Mollie within minutes. Still open after an hour: report it as **Hoog**. |
| An invoice is missing in Billit | **Financiën** > **Billit-synchronisatie**: retry the invoice; if it fails again, report it. |
| A session or booking looks wrong after a schedule change | Check **Planning** and **Sluitingsdagen**; sessions with bookings are kept (**Behouden omdat er boekingen zijn**). |
| A campaign stopped by itself | It was paused for too many bounces; see [Campaigns](campaigns.md). |
| A page shows **Er ging iets mis** | Reload once. If it stays, report it: the page shows a request id; copy it into the report. |
| Someone is locked out | **Account geblokkeerd tot ...** lifts by itself; for a lost authenticator see [Administration](administration.md). |
