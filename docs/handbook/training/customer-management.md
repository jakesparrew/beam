# Customer management

For: customer service (**Klantendienst**). Sales (**Verkoop**) uses the same screens for B2B contacts.

Every customer, lead and contact is one **person** in BEAM, with one customer number, one timeline
of everything that happened (bookings, purchases, emails, forms, notes) and their consent per
purpose. This guide covers finding and creating persons, duplicates, notes, consent and the inbox.

## How do I find a customer?

![Personen: search and filters](img/customer-management-persons.png)

1. Open **Personen** in the menu.
2. Type a customer number, email address, phone number or name in
   **Klantnummer, e-mail, telefoon of naam**.
3. Narrow down with the filters **Status**, **Tag**, **Segment**, **Taal**, **Herkomst** and
   **Testers**. **Filters wissen** clears them.
4. Click a row to open the person: the profile, the **Tijdlijn** (timeline), packages, bookings,
   orders, invoices and consent.

## How do I create a new person?

![Nieuwe persoon](img/customer-management-new-person.png)

1. On **Personen**, click **Nieuwe persoon**.
2. Fill in at least an email address, a phone number or a last name (**Vul een e-mailadres, een
   telefoonnummer of een achternaam in.**), and the **Taal** the person wants to be addressed in
   (Dutch, French or English).
3. Fill **Waar kwam deze persoon vandaan?** (how they found BEAM) when you know it: it feeds the
   marketing reports.
4. Save. If BEAM finds people who look the same, it shows **Mogelijke dubbels**: open the existing
   person with **Bestaande openen** instead of creating a second one. Only if it really is someone
   else, click **Toch aanmaken**.

Never type health information in the normal fields or notes: see "How do I record sensitive
information?" below.

## How do I merge two records of the same person?

![Possible duplicates](img/customer-management-duplicates.png)

1. Open **Mogelijke dubbels** (`/admin/persons/duplicates`) or, on a person, the merge suggestion.
2. Click **Samenvoegen** for a pair that is the same person, or **Geen dubbel** when it is not.
3. On **Personen samenvoegen**, choose **Welke persoon blijft?** and, per field, which value you keep.
   The page shows what moves to the person that stays (**Wat verhuist naar de persoon die blijft**).
4. Type **MERGE** in **Typ MERGE om te bevestigen** and click **Personen samenvoegen**.

The full history of both records is kept. A merge is blocked (**Deze samenvoeging is geblokkeerd**)
when both have an active membership, a booking for the same session or a place on the same
waitlist: resolve that first, as the message says.

## How do I add a note?

1. Open the person and add a note on the **Tijdlijn**. Notes are visible to every colleague who can
   see the person.
2. Keep notes factual and short. They are part of the person's data: the person can ask for a copy
   (see [Privacy and security](privacy-security.md)).

## How do I record sensitive information?

Health, sleep, stress, recovery and wellbeing information is special-category data. BEAM stores it
encrypted and shows it only to roles that may see it.

1. Use the person's sensitive fields or a **Gevoelige notitie** (sensitive note), never a normal note
   or field.
2. Opening sensitive data is logged. Only open it when you need it for the customer's care.
3. Sensitive data never goes to AI tools, exports, segments or campaigns.

## How do I check or change marketing consent?

1. Open the person and look at consent: one line per purpose, such as **Nieuwsbrief**,
   **Events en workshops** and **Ledencommunicatie**, with status **Gegeven** (given) or
   **Ingetrokken** (withdrawn) and where it came from (**Formulier**, **Klantenportaal**, ...).
2. Record a consent only when the customer gave it to you (for example on paper or by phone) and
   note how. Customers change their own choices on **Communicatievoorkeuren** in the portal or with
   the unsubscribe link in every email.
3. Without consent for a purpose, the person never receives marketing for it; service emails
   (booking confirmations, invoices, magic links) are always sent.

## How do I tag people or put them in a segment?

1. On **Personen**, tick people and use **Tag toevoegen** or **Tag verwijderen** (at most 5000 at a
   time).
2. Segments (groups defined by rules, for example "members without a visit in 60 days") are on
   **Segmenten**; marketing uses them for campaigns (see [Campaigns](campaigns.md)).

## How do I answer a customer in the inbox?

![Inbox](img/customer-management-inbox.png)

1. Open **Inbox**. Filter on **Status**, **Toegewezen aan**, **Kanaal** or **Alleen geëscaleerd**;
   **Niet toegewezen** shows conversations nobody has picked up.
2. Open a conversation, **Toewijzen** it to yourself and answer.
3. When the conversation is about health, click **Als gevoelig markeren**: sensitive conversations
   never go to AI tools (**Gevoelige gesprekken gaan nooit naar AI-tools.**).

## How do I follow up with a task?

On the person, create a task (for example "call back about the package"). It appears on **Taken**
for the colleague it is assigned to; see [Daily use](daily-use.md).
