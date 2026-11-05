# Daily use

For: reception (**Onthaal**). Also useful for everyone who works at the desk.

This guide covers the screens of a normal day at BEAM: the dashboard that tells you what needs
attention, the reception desk where you check people in and take payments, and your tasks. Bookings
themselves are in [Booking](booking.md).

## How do I sign in?

1. Open the back office (`/admin`) and sign in with your work email address and password.
2. Enter the 6-digit code from your authenticator app (**Voer uw verificatiecode in**). The first time,
   you set the app up on **Tweestapsverificatie instellen** and store your recovery codes
   (**Uw herstelcodes**) somewhere safe.
3. Lost your phone? Use **Een herstelcode gebruiken**. Out of codes? Ask an owner to use
   **MFA resetten** on **Medewerkers** (see [Administration](administration.md)).

The menu only shows what your role may use. If you miss a screen you need, ask an owner.

## How do I see what needs attention today?

![Dashboard, view Vandaag](img/daily-use-dashboard.png)

1. Open **Dashboard** in the menu. The page opens on **Vandaag** (today); switch to **Deze week**
   for the week ahead.
2. Each card lists people who need a follow-up, for example **Pakketten bijna op** (packages nearly
   used up), **Lidmaatschappen die aflopen** (memberships ending), **Mislukte betalingen** (failed
   payments) and **Achterstallige taken** (overdue tasks).
3. Click a row to open the person, or use **Taak aanmaken** to turn it into a task for yourself or a
   colleague. A card that shows **Vandaag vraagt niets aandacht** has nothing for you.

## How do I check a customer in?

![Onthaal: today's sessions and check-in](img/daily-use-checkin.png)

1. Open **Boekingen** > **Onthaal** (`/admin/bookings/checkin`). The page lists **Sessies van vandaag**.
2. Scan the QR code from the customer's confirmation email, or type the code or a name in
   **Scan een code of typ een naam** and press Enter.
3. Click **Inchecken**. For a group, **Iedereen inchecken** checks in the booker and the guests
   (**Gasten van ...**). Clicked the wrong person? **Ongedaan maken**.
4. Read the warnings before you check in:
   - **Voorwaarden nog niet aanvaard**: the customer has not accepted the terms yet; ask them to do so.
   - **Gezondheidsverklaring ontbreekt** or **Gezondheidsverklaring verlopen**: the health declaration
     is missing or expired; use **Formulier invullen** to fill it in with the customer.
   - **Te betalen: ...**: the session still has to be paid; use **Betaling aannemen**.
   - **Deze boeking is voor ..., niet voor vandaag.**: the code belongs to another day.
5. Only when there is a good reason, **Toch inchecken** checks in despite a warning.

## How do I handle someone who did not come?

1. After the session, people who never checked in show **Nog niet aangekomen**.
2. Click **Markeren als niet opgedaagd** (mark as no-show). BEAM can also do this automatically a
   number of minutes after the end of the session (see **Boekingsregels** in [Booking](booking.md)).
3. Marked by mistake? **No-show ongedaan maken** reverts it.

## How do I add a walk-in?

1. On **Onthaal**, click **Binnenloper toevoegen** next to the session.
2. Search the person; if they are new, create them with name and email address.
3. Check them in and take the payment if the session is not covered by a package.

## How do I sell something at the desk?

![Onthaal (point of sale): basket and payment](img/daily-use-pos.png)

1. Open **Verkoop** > **Onthaal** (`/admin/pos`).
2. Add products to the **Mandje** (basket). To redeem a gift voucher, use **Cadeaubon inwisselen** or
   scan the voucher.
3. Choose the **Koper** (buyer): **Zoek op naam, e-mail of telefoon**, or **Nieuwe klant aan de balie**
   for someone new.
4. Pick the payment method: **Betaalterminal** (card terminal) or **Contant** (cash; enter
   **Ontvangen contant geld (EUR)**).
5. Click **Betaling ontvangen**. The order shows **Betaald** and the invoice follows automatically.

## How do I close the day at the desk?

1. Open **Dagafsluiting onthaal** (`/admin/pos/day`).
2. Count the cash drawer and enter it in **Getelde kas (EUR)**.
3. Click **Dag afsluiten**. BEAM shows the difference between counted and expected cash; add a note
   when there is one. A closed day can only be reopened by someone allowed to (**De dag heropenen**).

## How do I follow up a payment that did not go through?

1. Open **Betalingen opvolgen** (`/admin/orders/attention`). It lists orders whose payment failed or
   is still open.
2. Open the order and contact the customer, or take the payment at the desk.

## How do I work through my tasks?

![Taken, tab Mijn taken](img/daily-use-tasks.png)

1. Open **Klanten** > **Taken**. **Mijn taken** shows your tasks; **Vandaag** and **Te laat** narrow it
   down.
2. Open a task's person or booking with **Openen**, do the work, then click **Afronden**.
3. Not yours? **Toewijzen aan iemand anders**. No longer needed? **Taak annuleren**.
4. **Nieuwe taak** creates a task by hand, for example a call-back you promised.

## What if something looks wrong?

Use **Een probleem melden** in the menu to report it; see [Troubleshooting](troubleshooting.md).
