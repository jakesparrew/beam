# Campaigns

For: marketing (**Marketing**).

A campaign sends one marketing email to the people of a segment who gave consent for its category
(**Nieuwsbrief**, **Evenementen** or **Ledencommunicatie**). BEAM checks consent, unsubscribes and
bounces for every recipient at the moment of sending, so you never have to clean a list by hand.
This guide covers templates, segments, and creating, testing, scheduling and following a campaign.

## How do I make the email itself?

![E-mailsjablonen](img/campaigns-templates.png)

1. Open **E-mail** > **Sjablonen**. The tabs split **Transactioneel** (service emails written with
   the platform; you rarely touch these) and **Marketing**.
2. Click **Nieuw marketingsjabloon**, give it a **Naam** and a **Categorie**
   (**Nieuwsbrief**, **Evenementen**, **Ledencommunicatie**).
3. Build the email from blocks (headings, text, images, buttons, columns) in each language:
   **Nederlands**, **Frans** and **Engels**. Every person receives the email in their own language;
   a language you leave empty means those people are skipped.
4. **Concept bewaren** saves your draft. Use **Voorbeeld als** to preview the email as a real person
   would see it, with their name filled in.
5. Publish the template. BEAM refuses to publish when **Niet elke taal is volledig**, when it finds
   **Onbekende personalisatievelden** (an unknown merge field) or when
   **De gegevens voor de wettelijke voettekst zijn onvolledig** (the company details for the legal
   footer are missing; an owner fills them in under **Instellingen**).

## How do I choose who receives it?

![Segmenten](img/campaigns-segments.png)

1. Open **Segmenten** and click **Nieuw segment**.
2. Combine rules (for example language, tags, last visit, package or membership status) and check the
   count before you save.
3. A segment is recalculated when the campaign is planned, so people who join or leave the segment
   in the meantime are handled automatically.

Health and other sensitive data can never be used in a segment.

## How do I create and send a campaign?

![Campagnes](img/campaigns-list.png)

1. Open **Campagnes** and click **Nieuwe campagne**.

   ![Nieuwe campagne](img/campaigns-new.png)

2. Fill **Naam van de campagne**, the **Categorie** and the **Inhoud** (pick a published marketing
   template), then **Campagne aanmaken**.
3. Pick the **Segment** (**Kies een segment**) and, if needed, **Deze segmenten uitsluiten** (for
   example people who already booked). **Geschatte doelgroep** shows how many people are in the
   segment and how many can actually receive the email.
4. Send yourself a test: **Test versturen** sends to staff addresses only (at most five), with
   **[TEST]** in the subject. Check it in every language.
5. Go to **Controle**: **Voor je plant** lists what must be in order, for example
   **Er is een segment gekozen** and **Er is een testmail verstuurd na de laatste wijziging**
   (a test after your last change). Fix whatever is not ticked.
6. Under **Wanneer moet ze vertrekken?**, choose **Nu verzenden** or a **Datum en tijd (Brussel)**
   and click **Plannen**. BEAM warns when the time is outside the usual send window; confirm only if
   you mean it.
7. Until it starts, **Planning annuleren** takes it back to draft.

## How do I follow a campaign?

1. Open the campaign. **Voortgang** shows how many were sent, skipped and failed, and later the
   opens, clicks and bookings it led to.
2. **Pauzeren** stops sending after the current batch; resume when you are ready. **Stoppen** ends the
   campaign for good: **Stoppen kan niet ongedaan worden.** Messages already accepted by the email
   provider cannot be recalled.
3. If too many addresses bounce, BEAM pauses the campaign by itself
   (**Automatisch gepauzeerd: te veel harde bounces.**). Check the recipients list
   (**Ontvangers van ...**) before you resume.

## How do I see how email is doing overall?

**E-mail** > **Overzicht** shows delivery, bounces and complaints of the last weeks, and **Berichten**
lists every email sent to anyone, with its status. The marketing reports
(**Rapporten** > **Marketing**, **Campagne-attributie**) are explained in [Reporting](reporting.md).

## Things to know

- A person who unsubscribes or withdraws consent never receives marketing for that category again,
  even if they are still in the segment.
- New sending domains warm up: during the first weeks BEAM sends at most a daily number of marketing
  emails and continues the rest the next morning. A large campaign can then take more than a day.
- Writing help from AI for campaigns comes in a later release; see [AI tools](ai-tools.md) for what
  exists today.
