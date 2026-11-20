# Module `assistant`: AI support, sales and coach agent

Status: **built 19-11-2026** (all six phases, local demo). Written 19-11-2026 after reading BEAM's existing AI layer and the
chat agent in the `superstream` repo. Nothing in this document is built yet.

One agent, three roles:

| Role | Who talks to it | Where | What it does |
| --- | --- | --- | --- |
| **Guide** | anonymous visitor | chat bubble on every public page | answers questions about BEAM, shows live availability and prices, leads the visitor into the booking flow, asks for contact details at the right moment |
| **Lead analyst** | nobody (background) | job after each conversation | reads the conversation, extracts what the person is looking for, labels and scores the lead, feeds CRM and automations |
| **Coach** | signed-in customer | chat in the portal | answers with the customer's own context (bookings, credits, membership, and with consent their check-ins), suggests the next session |

## 1. What exists today

**BEAM**

- No chatbot on the site. The only chat in the code is webinar live chat.
- An AI gateway already exists (`apps/web/lib/ai.ts`): every call is checked against a monthly budget
  and a daily cap, and logged in `ai_requests` with tokens, cost, prompt and output. Seven features use
  it (inbox reply drafts, email drafts, the weekly summary, "ask a question" in reports).
- That gateway cannot do a chat today: no streaming, no tool calls, one fixed provider
  (`@anthropic-ai/sdk`), two fixed models, and the rule "the model is never called from a request".
- A staff-edited knowledge base exists (`support_knowledge_articles`: opening hours, cancellation
  rules, what to bring, per language). It is the natural source for the Guide.
- CRM has everything a lead needs: `persons` with acquisition origin, tags (`interest:*`), the
  timeline, consent per purpose, segments, tasks, the inbox, and automations triggered by events.
- There is no visitor tracking: no anonymous visitor id and no page views.

**superstream** (the reference)

It already solves most of the hard parts, and the design ports well:

- Chat reply streamed to the widget, with rate limits per visitor and per IP.
- Lead capture done by the **widget** (a form card with a consent tick), not by the model asking
  free-form. The model only calls a tool that says "offer the contact form now".
- Lead extraction as a background job on a cheap model, where every extracted value must quote the
  visitor literally, otherwise it is rejected.
- A transparent 0–100 lead score built from rules, with the reason in plain words.
- Human takeover: a staff reply silences the bot for that conversation.
- An inbox of conversations with "did not know the answer" flags and a one-click path to write the
  missing knowledge article.

What superstream does **not** have, and this plan adds: cost per message and per day, a spend cap,
a log of the tools the agent called, model switching without a deploy, and a coach role.

What this plan leaves out from superstream: embeddings and vector search, the website crawler, the
external-database connectors and the multi-tenant layer. BEAM is one centre with a small knowledge
base; see section 4.

## 2. Is this efficient, or does it burn tokens?

It is cheap if four things are in place. Without them it is two to three times more expensive and
open to abuse.

1. **Prompt caching.** The instructions, the knowledge base and the tool list (about 6,000 tokens)
   are identical for every visitor. Cached, each turn pays about a tenth of the price for that part.
2. **A small model for the Guide, a larger one only where it pays.** Most visitor questions are
   "what does it cost", "when are you open", "what is a night session". A small model with low
   reasoning effort answers those well.
3. **Short answers and a short memory.** Answers capped at about 600 output tokens; the last 12
   messages are replayed, older ones become a running summary.
4. **Hard limits.** Per visitor per minute and per day, per conversation, and a daily spend cap for
   the assistant that is separate from the staff AI budget. When the cap is hit, the widget shows a
   contact form instead of the chat.

Measured on 19-11-2026 through Vercel AI Gateway (list prices per million tokens, input/output:
Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20, Gemini 3 Flash $0.50/$3, GPT-5.5 $5/$30):

| What | Model | Measured |
| --- | --- | --- |
| One guide answer (with tools, cache warm) | Haiku 5.5 | $0.0001 to $0.0009 |
| One guide conversation, average | Haiku 5.5 | about $0.003 |
| One coach answer | Sonnet 5.5 | about $0.002 to $0.004 |
| One analysis of a conversation | Haiku 5.5 | about $0.0002 |
| Evaluation answer (10 questions) | Gemini 3 Flash / Haiku 5.5 | $0.0018 / $0.0003 per answer |

So 1,000 guide conversations a month cost about $3 on Haiku, about $60 on Sonnet. The cache works:
a warm turn reads about 8,000 of its tokens from the cache at a tenth of the price.

`DEFAULT_AI_PRICING` in `@beam/core/ai` (Haiku at 10 and 50 cents per million tokens) is correct.

## 3. Architecture

```
visitor / customer
      │  message
      ▼
ChatWidget (React, in the site and portal layouts)
      │  POST /api/public/assistant/chat      (stream of text + cards)
      ▼
assistant.reply()  ── checks: kill switch, rate limits, spend cap, role
      │
      ├─ builds the prompt: cached block (instructions + knowledge + tools)
      │                     + role context (coach: the customer's profile)
      │                     + last 12 messages
      ▼
lib/ai.ts  streamChat()  ── same gate as callClaude: budget, allow-list, ai_requests log
      │
      ▼
Vercel AI Gateway  ──► the model chosen for this role in settings
      │
      ▼  tool calls (run on our server, logged)
knowledge · availability · prices · booking link · contact card · handoff · coach tools

after the stream:  store messages + tool trace + tokens + cost
                   enqueue assistant.analyse_conversation when due
```

### 3.1 The AI layer (extends what exists)

- `packages/integrations`: a second client next to the Anthropic one, built on the Vercel AI SDK
  with the Gateway provider. One model is one string (`provider/model`), so switching model or
  provider is a setting, not code. It supports streaming, tool calls and reasoning effort.
- `apps/web/lib/ai.ts`: a new `streamChat()` beside `callClaude()`. It runs the same checks (feature
  register, field allow-list, budget) and writes the same `ai_requests` row, plus cache-write and
  cache-read tokens and the tool trace.
- A **budget per feature group**: the assistant gets its own daily and monthly cap, so a busy day on
  the public chat cannot starve the staff features, and the other way round.
- A scripted fake for tests, like the existing one, so the suite never touches the network.
- Three new entries in the AI feature register: `assistant.guide`, `assistant.coach`,
  `assistant.analyse`.

### 3.2 Model switching and reasoning

`settings.assistant` holds, per role:

- the model (chosen from an allow-list of gateway model ids, each with a price row),
- a fallback model, used when the first one fails,
- the reasoning effort (off, low, medium, high),
- the maximum answer length.

Defaults: Guide on the small model with low effort, Coach on the middle model with medium effort,
Analyst on the small model. A change in the settings page applies to the next message.

An evaluation set (about 30 real questions with the answer we expect, in three languages) runs on
demand against any model. It is how a model switch is judged before it goes live: answer quality
next to cost per answer.

Reasoning is never shown to the visitor. Where the provider returns a reasoning summary, staff see
it in the message trace.

### 3.3 Tools

Tools are functions on our server. The model never touches the database; it asks, the tool answers
with a small, shaped result. Every call is stored with its input and output.

| Tool | Roles | What it returns or does |
| --- | --- | --- |
| `get_availability` | Guide, Coach | bookable sessions for a date range and kind (`booking.listBookableSessions`) |
| `get_offer` | Guide, Coach | products, prices and what is included, from commerce; the model may not state a price it did not get from here |
| `booking_link` | Guide, Coach | a link into the booking flow with the session preselected; the widget renders it as a button |
| `offer_contact_form` | Guide | tells the widget to show the contact card (section 5); the model does not collect details itself |
| `handoff` | Guide, Coach | opens an inbox thread for staff and tells the visitor a person will answer |
| `my_bookings` | Coach | the customer's upcoming and recent visits |
| `my_balance` | Coach | credits, membership and expiry |
| `my_checkins` | Coach | check-in trend and the effect of visits; only with the consent of section 7 |

The agent cannot book, cancel, charge or change anything. It hands over a link and the existing
flows do the work. That keeps payments, policies and audit where they already are.

### 3.4 The chat endpoint

A route handler under `app/api/public/assistant/chat`, same origin, streamed. Checks in order:

1. the assistant is switched on (feature flag `ff_assistant`, plus a kill switch in settings),
2. the request comes from our own origin,
3. rate limits: 12 messages a minute and 60 a day per visitor, 30 a minute per IP, 2,000 characters
   per message, 80 messages per conversation,
4. the spend cap of the day is not reached,
5. for the Coach role: a valid customer session; the person id comes from the session, never from
   the request.

When a limit or the cap is hit the widget shows the contact form, never an error.

## 4. Knowledge

No vector search in the first version. BEAM's knowledge is small: the support articles, the session
kinds, the practical pages. Together that is a few thousand words per language, which fits in the
cached part of the prompt. The model sees all of it on every turn, so it cannot miss the relevant
passage, and there is no index to keep in sync.

- Source of truth: `support_knowledge_articles` (already staff-edited in the back-office), extended
  with a flag "visible to the assistant".
- Live facts (availability, prices, opening exceptions) never come from the prompt; they come from
  tools, so they cannot go stale.
- The back-office lists the questions the agent could not answer, each with a button to write the
  article that answers it.

Vector search becomes worth it when the knowledge passes roughly 40,000 tokens (blog archive, long
programme descriptions). Neon has pgvector; superstream's search code is the template.

## 5. From visitor to lead

1. **Visitor id.** When someone sends the first message, the server creates a random token; the
   browser keeps it, the database stores only its hash. This is needed for the chat to work at all,
   so it does not wait for the cookie banner. It is created on the first message, not on page load.
2. **What we know before they tell us.** The page they opened the chat on, their language, and, only
   with analytics consent, the landing page and campaign they arrived with (the existing UTM
   capture) and the pages they viewed.
3. **Contact card.** The widget shows a small form (first name, email, optional phone) with a
   separate, unticked box for the newsletter. It appears when the agent calls `offer_contact_form`
   (a question it cannot settle, a quote, a "let me think about it"), or after a set number of
   messages. Submitting it calls `crm.findOrCreatePersonByEmail`, fills the acquisition origin
   (`chat`), links the visitor and all earlier messages to the person, and records consent only if
   the box was ticked, with the wording version.
4. **Analysis.** A job on the small model reads the conversation and returns, as structured data:
   what they are looking for, which sessions interest them, how soon, objections, sentiment, and a
   two-line summary. Each value must quote the visitor; values without a literal quote are dropped.
5. **Labels and score.** The job applies tags (`interest:night`, `interest:membership`,
   `intent:booking`, `objection:price`) and computes a 0–100 score from fixed rules (contact details
   given, intent, urgency, booking link clicked, a price objection), with the reason in plain words.
   Rules, not model opinion, so the score can be explained and tuned.
6. **Events.** `assistant.lead_captured`, `assistant.lead_qualified`, `assistant.handoff_requested`
   and `assistant.conversation_analysed` land on the timeline. Automations trigger on them, and
   segments can select on the tags and the score. Marketing emails still pass the existing consent
   and suppression checks; a lead without newsletter consent gets the follow-up to their own
   question, nothing more.
7. **Attribution.** A booking made within 30 days of a conversation is linked to it, so the
   back-office can show what the agent brought in.

An anonymous visitor who never leaves details is still analysed in aggregate (what do people ask,
where does the agent fail), but is never a CRM person.

## 6. The back-office: what did the agent do

A section **Assistant** in the admin navigation, permission `assistant.read` (settings need
`assistant.manage`).

- **Overview.** Conversations today and this week, share answered without a person, leads captured,
  leads qualified, bookings that followed a conversation, cost today and this month against the cap.
- **Conversations.** A live inbox with filters (wants a person, did not know, lead, coach). Opening
  one shows the transcript and, per answer: the model, the tokens, the cost, and the tools it called
  with what they returned. Staff can take over; from the first staff reply the agent stays silent in
  that conversation.
- **Agent log.** One line per action the agent took outside the chat: contact saved, tag applied,
  score changed, handoff opened, automation enrolment requested. Each line links to the person and
  the conversation.
- **Unanswered questions.** Grouped, with the button to write the missing article.
- **Settings.** On/off, models and reasoning per role, the tone of voice, when to offer the contact
  card, the spend caps, the evaluation set.
- **On the person page.** A panel "Assistant": the summary, the labels with the quote behind each,
  the score with its reason, and the conversations.

## 7. The Coach

The same widget in the portal, with the customer's context added to the prompt: first name,
language, membership and credits, next and recent bookings, visit count, tags. All of these are
already on the AI allow-list.

**Check-in data is a separate step.** Energy, sleep, tension and mood are health-related data.
BEAM's own rules exclude them from AI today (`00-decisions.md` principle 5), and the law asks for
explicit consent. So:

- Coach version 1 works without check-ins: "you have two credits that expire on the 30th, Thursday
  evening is free", "you came four times in October", practical preparation for a night.
- Coach version 2 adds check-ins behind a switch the customer turns on in the portal ("let my coach
  use my check-ins"), recorded as consent with a wording version, revocable, and with the notes
  still excluded. This needs the DPIA reference the settings already ask for.

Guardrails for both roles: no medical claims or diagnoses, no promises about results, and when
someone describes an acute problem the agent says it is not a doctor, gives the emergency line and
opens a handoff.

Later, not in this plan: the coach starting the conversation (a nudge after a low-energy week), and
voice.

## 7b. Behaviour and profile advice (added 19-11-2026)

On the staff person page, "Behaviour and advice" shows how a person books (visits, rhythm, preferred
kind, weekday and time of day, booking lead time, no-shows, credit and expiry, spend, newsletter
consent) and the signals rules derive from it (loyal, lapsing, lost, night fan, no-show risk,
credits expiring or unused). Only booking, credit and purchase facts; no wellbeing data.

The lead agent reads those facts and proposes at most three steps: place the person in a journey,
apply a tag, or a task for a colleague, each with its reason. Code enforces the limits: only the
journeys listed in `settings.assistant.advice.flows` that are active, never one the person is
already in, and never a marketing journey without newsletter consent (the automation engine checks
consent again before every email). A colleague carries a step out with one click
(`automations.move_person`); with `advice.auto_apply` the agent carries out journeys and tags
itself, tasks always stay a click. Advice is made on request, after every analysed conversation of
a known person, and by a daily sweep (06:30) over people who visited or chatted the day before.
Every advice and every step carried out is in the agent log.

## 8. Data model

New file `packages/db/src/schema/assistant.ts`.

| Table | Holds |
| --- | --- |
| `assistant_visitors` | token hash, linked person, language, first page, campaign origin (with consent), first and last seen |
| `assistant_conversations` | visitor, person, role (guide or coach), status (open, handoff, closed), page, counters, taken over by, analysis (summary, intent, interests, urgency, score, score reason, quotes), analysed at |
| `assistant_messages` | conversation, author (visitor, assistant, staff), text, cards shown, tool trace, link to the `ai_requests` row, thumbs up or down |
| `assistant_eval_cases`, `assistant_eval_runs` | the evaluation questions and the results per model |

Changes to existing tables: `ai_requests` gets cache-write tokens and a tool trace; the enums get
one value each (inbox channel `chat`, tag source `assistant`, consent method `chat`, acquisition
source `chat`); `support_knowledge_articles` gets the "visible to the assistant" flag.

Privacy: every table registers in the module's `privacy.ts` (export and erase). Conversations of
visitors who never became a person are deleted after 90 days; transcripts of persons follow the
person.

## 9. Rules of the platform this plan changes

These are owner decisions. Each is a line in `00-decisions.md` or `01-architecture.md` today.

| # | Today | Proposed |
| --- | --- | --- |
| R1 | The model is never called from a request, only from a job | One exception: the assistant's streaming route, behind the same gate. A job with polling works without the exception but means no streaming and a slower first word |
| R2 | One provider, through the official Anthropic SDK | A second client through Vercel AI Gateway; the existing features can move later or stay |
| R3 | Twelve modules, list frozen | A thirteenth module `assistant`. The alternative (spread over `crm` and `site`) saves the change but blurs who owns what |
| R4 | AI replies are always approved by staff before sending ("fully automated replies: later") | The Guide and Coach answer on their own in the chat; email and inbox drafts stay approved by staff |
| R5 | Sensitive fields are excluded from AI | Unchanged for version 1; Coach version 2 adds an explicit, per-customer opt-in |
| R6 | The deployed cron runs once a day (Vercel Hobby) | Analysis and events run right after a conversation, not on the cron, so leads appear within a minute. Automations that wait for the evaluator still start at the next daily run until the project moves to a plan with minute crons |

Also needed outside the code: a line in the privacy notice about the assistant and its processors,
the cookie register entry for the visitor token, and the first message of every chat saying that
this is BEAM's digital assistant (transparency duty for AI systems).

## 10. Build phases

Each phase ends with something to click through, screenshots, and tests.

| Phase | Delivers | Done when |
| --- | --- | --- |
| **1. AI layer** | Gateway client with streaming, tools and reasoning effort; `streamChat()`; budget per feature group; the three feature keys; scripted fake; price table corrected | a test conversation streams locally through the gateway, and the `ai_requests` row shows tokens, cache hits and cost |
| **2. Guide** | The widget on the site in three languages, the endpoint with all limits, knowledge in the cached prompt, the tools for availability, offer, booking link and handoff, conversations stored | a visitor asks about a night session, gets live availability and lands in the booking flow with the session chosen; the real cost per conversation is measured |
| **3. Lead engine** | Contact card with consent, visitor-to-person linking, the analysis job, labels, score, events, the panel on the person page | a test visitor chats, leaves an email, and appears in CRM within a minute with summary, labels, score and the quotes behind them |
| **4. Back-office** | Overview, conversations with trace and takeover, agent log, unanswered questions, settings with model switching, the evaluation set | staff can see every action of the agent, take over a chat, switch the model and compare two models on the evaluation set |
| **5. Coach** | The widget in the portal with profile context and the three coach tools; version 2 with the check-in opt-in | a customer asks "when should I come next" and gets an answer from their own bookings and credits |
| **6. Marketing** | Segments on labels and score, two starter automations (follow-up after an unanswered price question; reminder after a booking link that was not used), booking attribution | a qualified lead with newsletter consent enters an automation; one without does not |

Phases 1 to 3 are the product. Phase 4 can overlap with 3. Phase 6 depends on the marketing module
that is still to be designed.

## 11. Needed from the owner

- The Vercel AI Gateway key, placed in `.env.local` as `AI_GATEWAY_API_KEY` (never in chat).
- A decision on R1 to R6.
- The tone of voice: how the Guide should sound, and what it must never say.
- Ten to twenty real questions customers ask today, for the evaluation set.
