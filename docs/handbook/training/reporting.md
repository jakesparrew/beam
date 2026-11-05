# Reporting

For: management (**Management**) and finance (**Financiën**).

BEAM's reports read the same data the rest of the platform writes, so a sale, a booking or a
cancellation shows up in the reports as soon as it happened. Every report excludes test persons and
can be downloaded as CSV (**Elk rapport sluit testpersonen uit en kan als CSV gedownload worden.**).

## How do I find the reports?

![Rapporten](img/reporting-reports.png)

Open **Rapporten** in the menu. The V1 reports are:

| Report | What it answers |
| --- | --- |
| **Omzet** | Revenue per day, week, month and year to date, with the previous period |
| **No-shows en annuleringen** | Who cancels late or does not come, per weekday and hour |
| **Verlaten afrekeningen** | Checkouts that were started but not paid |
| **Bezetting** | How full the sessions were |
| **Marketing** and **Campagne-attributie** | Which campaigns and sources bring bookings and sales |
| **Exports** | CSV exports of an entity and the full data export |

## How do I see the revenue of a period?

![Omzet with period and VAT switch](img/reporting-revenue.png)

1. Open **Rapporten** > **Omzet**.
2. Choose the **Periode** (**Van** and **Tot**, or a preset) and click **Toepassen**.
3. Switch **Btw** between **Incl. btw** and **Excl. btw**. The summary line reads
   **Netto-omzet ..., ... tegenover de vorige periode** (net revenue compared with the previous period
   of the same length).
4. Below, **Verkoop per productsoort** (by product kind) and **Verkoop per kanaal** (online, desk,
   ...) break it down.
5. **Openstaande vooruitbetaalde tegoeden** shows the prepaid credits customers still have (day
   sessions, nights, euro credit) and their VAT treatment: sold sessions are revenue BEAM still owes
   as a service.
6. **CSV downloaden** gives the same numbers for a spreadsheet.

Revenue counts paid orders; refunds and credit notes are subtracted in the period they happen.

## How do I look at the finance side?

![Financiën: Dashboard](img/reporting-finance-dashboard.png)

1. Open **Financiën** > **Dashboard** for invoiced revenue, VAT and open amounts, and
   **Uitgestelde omzet** for revenue that is invoiced but not yet earned (packages and memberships).
2. **Facturen** lists every invoice and credit note (**Factuur**, **Creditnota**) with its PDF.
3. **Billit-synchronisatie** shows whether each invoice reached Billit, the accounting tool. An invoice
   that failed can be retried there; if it keeps failing, report it (see
   [Troubleshooting](troubleshooting.md)).
4. **Bedrijfsaanvragen** lists customers who asked for an invoice in a company name.

Invoices are never edited: a correction is always a credit note plus a new invoice.

## How do I export data for my accountant or a spreadsheet?

![Exports](img/reporting-exports.png)

1. For finance: **Financiën** > **Exports** creates the exports for the accountant per period. When
   BEAM answers **Het bestand zou groter zijn dan 10 MB. Kies een kortere periode.**, split the
   period.
2. For other data: **Rapporten** > **Exports** > **Nieuwe export**, then choose
   **Eén entiteit (CSV)** (for example persons or bookings) or **Volledige gegevensexport** (every
   table; it needs the export and staff-management permissions, so in practice an owner).
3. The export runs in the background (**In wachtrij**, **Bezig**, **Klaar**). Click **Downloaden**
   when it is ready; the file is removed after the date shown in **Vervalt op ...**.

Exports never contain sensitive (health) data. Treat every export as confidential: store it in
BEAM's Google Workspace, never on a personal device, and delete it when you no longer need it.

## How do I see the day at a glance?

The **Dashboard** (**Vandaag** / **Deze week**) is the action list for staff (see
[Daily use](daily-use.md)); **Klantbehoud** (retention) and **Pipeline** show customers at risk and the
B2B pipeline. The weekly summary and the question box (**Stel een vraag**) come with a later release.
