# AI tools

For: marketing (**Marketing**). Owners read the last two sections too.

In V1 BEAM has one AI tool: **Vraag het Claude** on the website pages, which writes a proposal for a
page that you review before anything goes live. The AI never sees customer data. Later releases add
help with emails, replies and a weekly summary; they will be added to this guide when they arrive.

## How do I let Claude write or change a website page?

![Website pages, where Vraag het Claude lives](img/ai-tools-site.png)

1. Open **Website** > **Pagina's** (**Websitepagina's**) and open the page, or click **Nieuwe pagina**.
2. Click **Vraag het Claude**. Choose **Deze pagina bewerken** or **Een nieuwe pagina schrijven**.
3. In **Wat moet er veranderen?**, write the instruction as you would to a copywriter: what the page
   is for, the tone, what must be mentioned, what must not change. Pick the **Talen** (languages) the
   proposal must cover.
4. While **Claude schrijft een voorstel…** shows, you can keep working; one request per page runs at
   a time (**Er loopt al een aanvraag voor deze pagina.**). **Aanvraag annuleren** stops it.
5. When **Voorstel klaar: bekijken** appears, open it. The comparison shows what is
   **Toegevoegd**, **Gewijzigd** and **Verwijderd** against the live version.
6. Read every language. Then:
   - **Publiceren** puts the proposal live;
   - **Als concept bewerken** opens it as a draft so you can correct it first (the usual choice);
   - **Afwijzen** with a **Reden** discards it.

Claude only receives the page's content and your instruction. Never paste customer names, email
addresses or health information into the instruction.

## What if Claude cannot help?

- **Claude is niet beschikbaar, bewerk manueel.**: the AI service is down; edit the page yourself.
- **AI-budget voor deze maand bereikt, bewerk manueel.**: the monthly AI budget is used up; an owner
  can raise it on **AI-instellingen**.
- **Claude gaf een ongeldige pagina terug, probeer een preciezere instructie.**: try again with a
  shorter, more precise instruction.
- **Dit duurt langer dan verwacht. Kijk later opnieuw.**: the proposal will appear on the page when it
  is ready.

## What may AI see, and what not?

- AI tools only receive the fields listed for each feature in the AI register. The website tool gets
  no personal data at all.
- Sensitive (health) data and conversations marked **Gevoelig** never go to an AI tool. The switch
  **Verwerking van gevoelige gegevens** on **AI-instellingen** is off by default; turning it on needs
  an owner, a purpose, a DPIA reference and an approved DPIA, and no V1 feature uses it.
- BEAM uses Anthropic's API under BEAM's own organisation; the provider does not train on BEAM's data.
  Nobody connects a personal ChatGPT or Claude account to BEAM data.

## How do I see which AI features exist and what they cost? (owners)

![AI-gebruik: the AI register and this month's use](img/ai-tools-usage.png)

1. Open **Systeem** > **AI-gebruik**. **Register van AI-functies** lists each feature with
   **Waarom** (purpose), **Verstuurde velden** (fields sent; **Geen persoonsgegevens** for the website
   tool), when it runs, the provider and location, and how long prompts and outputs are kept.
2. **Gebruik in ...** shows this month's calls, tokens and **Kosten** per feature.
3. The monthly budget and the daily call limit are on **Instellingen** > **AI-instellingen**
   (**Budget en prijzen**).
