# BEAM: Blueprint analysis and proposal preparation

*Internal SideStream working document. Not for sending as-is.*
*Source: "BEAM – Custom CRM, Operations & AI Platform – Detailed Requirements Blueprint" (84 pp., 89 sections), received 12 Oct 2026 from Jonathan Bossaer.*

---

## 1. What they are really asking for

**The email asks for five things:**

1. **A formal proposal.** It should cover scope (V1 and phasing), architecture, implementation approach, timing, initial investment and monthly cost.
2. **A date** for when we will deliver that proposal. They are waiting on this now.
3. **Our feedback on the blueprint.** They explicitly want to be challenged: *"We are looking for the right long-term solution, not simply the longest possible feature list."*
4. **Support and availability.** This means channels, response times, what the monthly fee includes, and how improvements are handled.
5. **A signed written agreement** before development starts. It must cover scope, deliverables, timing, responsibilities, pricing, support, data and code ownership, hosting, maintenance and exit.

**How to read this.** The document is mature and was clearly written with legal or GDPR input (Art. 28 DPA, DPIA, subprocessors, retention table). The CEO principles in §88 tell us what wins the deal:

- predictability;
- clear ownership;
- an exit path;
- AI used selectively;
- **V1 not overbuilt.**

A proposal that pushes back on scope will score better than one that says yes to everything.

**They left our earlier indicative range aside.** That gives us room to re-price, but the number will be compared against what we said before. Whatever the new figure is, we need to explain the gap through scope.

---

## 2. Executive view: our position in one paragraph

We recommend a **modular, single-tenant platform** built around four reliable cores:

- one customer record;
- one entitlement (credits) ledger;
- one booking and capacity engine;
- one automation engine with explicit enrolment and exit rules.

These cores replace **SimplyBook and Mailchimp in V1**, and we add **basic events and ticketing** because they share the same engine. We **integrate rather than rebuild**:

- **Payments:** Mollie.
- **Invoicing and Peppol:** Billit.
- **Webinars:** WebinarGeek for V1 and Phase 2.
- **Assessments:** ScoreApp or Typeform for V1 only. A native scoring engine follows in Phase 2, on top of the V1 form engine.

Lightspeed is replaced only for **non-horeca front-desk sales** in V1. Full Lightspeed replacement depends on a fiscal check (see §4.6).

Work runs in three steps:

1. A **paid Discovery and Specification phase** settles BEAM's 20 open decisions (§85). It produces the functional specification and the acceptance tests that become annexes to the contract.
2. **V1 is built under a fixed price, paid per milestone.**
3. **Each later phase is quoted separately.**

---

## 3. Recommended scope split

Legend:

- **V1** = first go-live.
- **P2** = Commercial Engine phase, about 3–6 months after go-live.
- **P3+** = Intelligence and Advanced.
- **INT** = integrate an external tool instead of building it natively.

| Area (blueprint §) | Recommendation | Rationale |
|---|---|---|
| Central customer record, dedupe/merge, tags (§3, §54) | **V1** | Foundation. Everything else depends on it. |
| Consent by purpose, consent ledger (§4, §59) | **V1** | Go-live gate. Cheap to build right, expensive to retrofit. |
| Customer timeline (§5) | **V1** (events available in V1) | Built as an append-only activity log. Webinar and assessment events arrive via integration. |
| Segmentation, dynamic and manual, with exclusions (§6) | **V1** core filters, **P2** advanced (watch time, LTV, attribution) | Exclusion logic is needed in V1 because the automations depend on it. |
| Day sessions, nights, capacity, schedules, exceptions (§7–9) | **V1** | Core SimplyBook replacement. |
| Customer portal (§10) | **V1**, responsive and installable (PWA) | Native app is **P3+** (§81). |
| Packages and credits (§11) | **V1** as an **entitlement ledger** | See §4.1. This decision has to be made before the data model. |
| Membership (§12) | **V1** | Includes automatic member pricing and Mollie recurring. |
| Payments (§13) | **V1** with **Mollie** (INT) | Bancontact is a must in Belgium. Stripe stays optional. |
| POS / Lightspeed (§14) | **V1:** front-desk sales of BEAM services (sessions, packages, memberships, tickets) via payment terminal. **Lightspeed retained** for product/horeca until the fiscal check. Full replacement **P2 or never.** | See §4.6. Stock management is **P3+** unless retail is material. |
| Events and ticketing (§15) | **V1 basic** (capacity, ticket types, member price, attendance) | Missing from their V1 list but needed: it shares the booking engine, and payments/POS already assume event tickets. |
| Lead capture, custom forms, conditional logic, UTM, embed (§16) | **V1** | Build **one versioned form engine.** Assessments reuse it. |
| Assessment and scoring engine (§17) | **V1: INT** (keep ScoreApp/Typeform → webhook → CRM). **P2: native** scoring on the V1 form engine. | Same builder, plus scoring, outcomes and result pages. A clean P2 increment. |
| Native webinar platform (§18) | **INT: WebinarGeek** in V1 and P2. Native build only **P3+**, and only on a video provider (LiveKit/Mux/Daily), never from scratch. | Highest-cost, lowest-differentiation item. See §4.2. |
| Lead-priority waitlist (§19) | **V1:** standard waitlist with real expiring claim links, protection for confirmed seats, duplicate checks. **P2:** lead-priority windows and queues. | The machinery is shared, so P2 is a rules layer on top. If lead-priority events drive revenue, it can move into V1 at a known extra cost. |
| B2C pipeline, retention list, follow-up automation (§20–22) | **V1:** rule-based "attention list" and the sequence templates they list. **P2:** pipeline board, playbook mapping. | §22 and §38 ("25 customers this week") are high value and cheap once the data exists. |
| CLV (§23) | **V1** historical metrics. **P3** predictive. | Deterministic, as they ask. |
| B2B companies and contacts (§24) | **V1 data model** (person ↔ company, roles) | Costs almost nothing now and avoids a migration later. |
| B2B pipeline (§25) | **P2** | Simple kanban with opportunities. |
| B2B prospecting, cold email, voice AI (§26–28) | **P4**, after GDPR/ePrivacy review | They agree. Outbound must use a **separate sending domain** so marketing deliverability is protected. |
| Email platform, campaigns, sequences, deliverability (§30–31) | **V1** on an EU email provider plus an embedded editor (INT) | We build the logic and do not build the editor or the email server. See §4.3. |
| AI marketing creation (§32) | **P3** | "AI prepares → human approves." Easy once templates and segments exist. |
| Attribution and marketing dashboards (§33–34) | **V1:** UTM and source captured and stored permanently. **P2:** dashboards, cost import (Meta/Google), ROAS. | Capturing from day one costs nothing, and the data cannot be recovered later. |
| Customer service inbox (§35) | **P2:** email and web forms linked to the customer. **P3:** Instagram and Messenger (Meta app review). | Meta messaging APIs need app review and have policy constraints. |
| AI support drafts (§36) | **P3** | Needs a knowledge base and policies first. |
| Tasks (§37) | **V1** | Small effort, and retention and sales flows need it. |
| Daily action dashboard (§38) | **V1** | The visible "win" for management. |
| Management dashboard (§39) | **V1:** fixed core KPIs. **P3:** custom dashboard builder. | Or embed Metabase on a read-only replica in P2. That is much cheaper than a custom builder. |
| Natural-language BI (§40) | **P3**, on a privacy-filtered read-only data layer, using an EU-hosted model endpoint | See §4.5. |
| Billit (§41–42) | **V1** (INT): invoices, customer sync, payment status | Billit stays the Peppol layer. B2B Peppol e-invoicing has been mandatory in Belgium since 1 Jan 2026. |
| Finance dashboard (§43) | **P2** | Needs Billit data to settle first. |
| Referral and partners (§44) | **V1:** referral source and partner as the origin of a customer. **P2:** rewards, commissions, performance. | The ledger makes rewards trivial later. |
| Promotions and pricing (§45–46) | **V1** | Must keep the historical price on every transaction. Price snapshots are part of the design. |
| Abandoned checkout (§47) | **V1** tracking. **P2** recovery flow and report. | |
| No-show and cancellation reporting (§48) | **V1** data. **P2** report. | |
| Guest and package sharing (§49) | **V1** basic (owner pays, guest attends). **P2** limits and abuse controls. | |
| Third-party integrations (§50) | Integration matrix in the proposal (see §6) | They explicitly ask for the type of each integration. |
| Custom workflow builder (§51) | **P3** | V1 has configurable templates (BEAM edits content, timing, on/off and conditions from a fixed set). A free-form visual builder in V1 roughly doubles the cost of automation. |
| Gamification (§52) | **P3+** | Ledger-based rewards make a light version possible later. |
| Migration (§53) | **V1** | SimplyBook, Lightspeed (customers and history), Mailchimp (including **suppressions**), spreadsheets. |
| Roles, audit trail, GDPR, security, backups, monitoring, staging (§55–78) | **V1** (go-live gate) | Non-negotiable for them, and rightly so. |
| Training and documentation (§79–80) | **V1** | George is the technical counterpart. Documentation lives in the repo. |
| Mobile app (§81) | **P3+** | The PWA covers about 80% of it. |
| BRANDEPIC (§82) | No V1 work beyond a **config-driven design** | The IP clause matters more here than the code (see §5). |

**What V1 replaces:**

- **Replaced:** SimplyBook and Mailchimp.
- **Partly replaced:** Lightspeed, for BEAM services only.

**What V1 keeps, integrated:**

- Mollie
- Billit
- WebinarGeek
- ScoreApp or Typeform
- Lightspeed, for horeca and retail until decided
- WordPress

---

## 4. Challenges and recommendations on the blueprint

### 4.1 Credits: yes, as an entitlement ledger (§11, §85.1)

**Recommendation.** We recommend the credit architecture, implemented as an **immutable ledger** rather than a "balance" field:

- Every grant, consumption, expiry, extension, manual adjustment, transfer to a guest and refund is a ledger row. Each row records who did it and why.
- Balance = sum of the rows.

**What the ledger gives them for free:**

- package history (§11)
- adjustments in the audit trail (§56)
- package impact of no-shows (§48)
- referral and partner rewards (§44)
- gamification later (§52)
- migration reconciliation (opening balances = one ledger row per customer)

**What the customer sees.** The display layer translates credits into "4 sessions remaining," as they ask.

**Entitlement types.** Use **typed entitlements**, for example day-session units and night units, with optional conversion rules. A single universal credit currency is not needed. It keeps pricing simple and avoids awkward "a night costs 3.5 credits" situations.

**Flag to BEAM (VAT and accounting).** Prepaid credits usable across services with **different VAT rates** may count as *multi-purpose vouchers* under EU VAT rules. That changes *when* VAT is due: at redemption instead of at sale. **BEAM's accountant must confirm** the treatment before the package model is fixed. This affects the Billit integration. It is a good example of us "spotting what's missing."

### 4.2 Native webinar: do not build it in V1 or P2 (§18)

**Why not.** The requirement list amounts to a full webinar product:

- live, simulive, on-demand and replay;
- multi-presenter;
- screen share and recording;
- polls, CTAs and chat in every mode;
- gated replays and viewing limits.

Even on top of a real-time video provider this is **many months of work**. It also brings a video-reliability risk to a business-critical system. Video infrastructure itself is never something to build.

**What BEAM actually needs** is the **data** in the CRM. Registered, attended, watch-time thresholds, replay versus live, poll answers and CTA clicks all drive segmentation and automations. That can be done by **integrating WebinarGeek**:

- WebinarGeek is Dutch, so it is an EU subprocessor and keeps GDPR simple.
- It has a REST API and webhooks for registrations, live and replay viewers, and more.
- Its own HubSpot connector syncs poll votes, CTAs, questions and watch time.

**To verify during Discovery:** the exact webhook or API payloads for poll answers and watch time. We have only seen this through third-party documentation and the HubSpot listing. If a field is missing from webhooks, a scheduled API pull after each session is the fallback.

**What the proposal states** (they ask for this in §18): WebinarGeek remains, the integration type, the data synchronised, and its subprocessor status.

**Later option (P3+).** A native module built on LiveKit, Mux or Daily, *if* webinar volume justifies it.

### 4.3 Email: build the logic, not the infrastructure (§30–31)

**Build:**

- segmentation;
- consent and preference centre;
- suppression;
- dynamic blocks;
- the sequence engine;
- pre-send controls;
- the per-customer automation timeline.

**Integrate:**

- **Sending.** An EU-based email provider (for example Brevo, Mailjet or Amazon SES EU region) handles SPF, DKIM, DMARC, bounces and complaint webhooks.
- **Visual editor.** An embeddable editor (for example Unlayer or Beefree SDK, or an open-source MJML-based editor) instead of building drag-and-drop.

**Domains.** The sending domain and DNS are **owned by BEAM** (§85.20 is answered: BEAM owns them, SideStream has delegated access). We recommend separate subdomains:

- one for transactional email;
- one for marketing;
- one for any future B2B outbound.

**Their acceptance criteria are reasonable, and the design must meet them explicitly:**

- **Late-entry skip** = a scheduling rule evaluated at send time.
- **Unsubscribe in under 15 min** = suppression checked at send time, not at enrolment. In practice this makes it near-instant.
- **Suppression survives imports** = the suppression list is separate from contacts and is never overwritten by an import.

### 4.4 Automation: configurable templates in V1, visual builder later (§21, §31, §51)

**The hard part is not the builder.** It is the **rules engine**:

- enrolment;
- exit-on-event (purchase exits nurture);
- mutual exclusion and priority between journeys (§21 "conflict rules");
- skip conditions (future booking means no inactivity email);
- late-entry skip;
- a full per-customer log (§31 "automation timeline").

**V1 plan.** Build that engine properly and ship it with the **sequence templates they list**:

- package usage;
- inactivity;
- membership renewal;
- review request;
- webinar;
- waitlist and claim;
- abandoned checkout;
- welcome and nurture.

BEAM staff can edit content, delays, on/off, and the conditions and exits from a predefined list, and can move a person between journeys (§21).

**P3.** A free-form visual workflow builder (§51), on the same engine.

**Prerequisite.** Every journey needs a **priority and exclusion group** so one person never receives contradictory sequences. This should be a design principle in the proposal.

### 4.5 AI: selective, governed, later (§32, §36, §40, §60–61)

**We agree with their principle** that rules come before AI. V1 contains **no AI features** except possibly AI-drafted email copy in the editor. That is low risk and uses no personal data.

**For P3:**

- **Data access.** A read-only, privacy-filtered data layer: views without special-category fields and with pseudonymised identifiers where possible.
- **Hosting.** The model runs through an **EU-region enterprise endpoint** with no-training terms and documented retention. Options include Claude via AWS Bedrock or Google Vertex in EU regions, or the Anthropic API under a DPA.
- **Logging.** Every AI feature gets an entry in an "AI processing register" (§61: fields sent, purpose, provider, location, retention).

**Health, sleep and stress fields** are tagged *sensitive* in the data model from V1. AI access to them is blocked at the data layer by default, not just by convention. That satisfies acceptance scenario §87.6 by design.

### 4.6 POS / Lightspeed: a legal check before scoping (§14, §85.3)

**The fiscal issue.** If BEAM sells **food and drinks for on-premise consumption** (a café or bar area) above the €25k threshold, Belgium requires a **certified registered cash register system (GKS / "witte kassa")**:

- **GKS 2.0** has been mandatory for new horeca systems since **1 July 2026**.
- Existing systems must migrate on a schedule between 2027 and 2029.

A custom POS cannot simply replace a certified one. We would need a certified POS or a certified fiscal module.

**Recommendation:**

- **V1 front desk** sells BEAM *services* (sessions, packages, memberships, tickets, gift vouchers) through a Mollie payment terminal, linked to the customer record.
- **Lightspeed stays** for horeca and retail products until BEAM confirms (a) the horeca turnover and (b) which Lightspeed functions are actually used (§85.3).
- **Full replacement** is a separate P2 decision.

This is the kind of challenge they asked for.

### 4.7 Inconsistencies in the blueprint to point out

**1. Events are missing from V1.** Their V1 list (§84) has no events or ticketing, yet:

- payments (§13) include event tickets;
- POS (§14) includes event sales;
- the lead-priority waitlist (§19) is an *event* feature that they want decided for V1.

We recommend basic events in V1.

**2. Forms and assessments are treated as separate.** Custom forms are Priority 1, while the assessment engine is "V1 or P2." They are the same engine. Building forms properly in V1 makes assessments an incremental P2 step.

**3. Overlap between the B2B data model and the B2B pipeline.** Model companies and contacts in V1 (cheap). Defer the pipeline UI.

**4. Lead definition.** "No paid session, package, night or membership" leaves edge cases open:

- free or comped sessions;
- event tickets;
- gift vouchers received;
- refunds.

These need rules in Discovery, because the lead-priority waitlist depends on them.

### 4.8 Missing from the blueprint, to raise with BEAM

**1. Gift vouchers and gift cards.** These are usually a significant revenue line for wellness centres. They are not mentioned anywhere. They fit naturally on the entitlement ledger.

**2. Corporate (B2B) accounts that buy credits for employees.** For a B2B wellbeing play this is probably *the* core B2B product: a company pool of entitlements, employee eligibility, usage reporting to HR, and invoicing via Billit. This is more important than prospecting automation.

**3. Terms, waivers and health disclaimers.** Versioned acceptance of terms and conditions and any contraindication or health intake before first use is common in vitality centres. It links to sensitive-data handling.

**4. SMS or WhatsApp reminders.** Only email is mentioned. SMS reminders measurably reduce no-shows (§48). This is optional, and has a usage cost.

**5. Reception check-in flow.** QR or name check-in to register attendance (§7). Attendance is the trigger for reviews, retention and no-show logic.

**6. Staff and resource scheduling.** We need to clarify whether sessions need staff, rooms or specific equipment assigned, or only seat and bed capacity. This has a large impact on booking complexity.

**7. Deferred revenue and breakage.** Unused and expired package value matters for the finance dashboard (§43) and accounting.

**8. Portal UI in NL, FR and EN.** They specify languages for emails (§4) but the portal and booking UI need the same.

**9. Uptime target.** Recommend stating 99.5% monthly, excluding planned maintenance.

**10. Product owner on BEAM's side.** A named person needs the authority to decide during the build. Their 20 open decisions (§85) show this is the biggest schedule risk.

**11. Cut-over plan.** We need a freeze date, a balance reconciliation that BEAM signs off, parallel running, and a rollback option.

---

## 5. Architecture to propose

**Shape:** a **modular monolith**, meaning one codebase and one database with clearly separated modules. This is **not microservices**. It is simpler to run and support, and easier for another developer to take over (§70). Modules can be split out later if ever needed.

**Proposed stack** *(adjust to SideStream's standard stack)*:

- **Code:** TypeScript end to end.
- **Database:** PostgreSQL.
- **Background jobs:** a job queue for automations, reminders, claim-window expiry and integrations.
- **Customer portal:** server-rendered web app, made installable as a PWA.
- **Staff back-office:** separate web app.

**Core design elements.** These are worth showing in the proposal because each answers one of their acceptance scenarios:

| Element | Answers |
|---|---|
| **Activity log** (append-only timeline per person) | §5 timeline; webinar live/replay/on-demand stored as separate event types (§87.5) |
| **Entitlement ledger** | Packages, credits, sharing, adjustments, migration reconciliation |
| **Consent ledger** + separate **suppression list** | Consent by purpose with wording version; suppression survives import (§59, §76) |
| **Versioned definitions** (forms, assessments, prices, terms) | Historical answers and prices never rewritten (§17, §46) |
| **Automation engine** with enrolment state, exit events, exclusion groups, send-time evaluation | Late-entry skip, fast unsubscribe, no contradictory journeys (§87.1–2) |
| **Seat-offer state machine** (waiting → offered[expires_at] → confirmed / released) with time-bound links | Claim window, protected confirmed seats (§87.4) |
| **Sensitivity tags on fields** enforced in the AI and export layer | Sensitive data excluded from AI (§87.6) |
| **Deletion orchestrator** (deletes or anonymises in-house data, calls the deletion APIs of each connected processor, keeps accounting records separately) | End-to-end deletion (§87.7) |
| **Audit log** (who, when, what, before and after) | §56 |
| **Outbound integrations via an outbox and retries, with failure alerts** | Monitoring (§72): failures never discovered only through a customer complaint |

**Hosting:**

- EU region.
- Separate **staging and production** environments.
- Infrastructure **under BEAM-owned accounts**, with SideStream as administrator. This covers hosting, domain/DNS, Mollie, the email provider and the code repository. Billing goes directly to BEAM, or is passed through at cost, which keeps monthly costs transparent (§88.6).

**Backups:**

- Automated daily backups plus point-in-time recovery.
- 30-day retention.
- Stored in a separate EU location.
- Restore tested quarterly.
- Proposed **RPO ≤ 1 h** (maximum data loss) and **RTO ≤ 8 h** (maximum time to restore). Tune these to the price.

**Security:**

- MFA for all staff accounts.
- Role-based access with field-level restriction on sensitive data.
- Secrets in a managed vault.
- Dependency scanning in CI.
- An annual external or independent penetration test (SideStream's ethical-hacking capability, formalised as §64 asks).
- A breach notification commitment of **within 24 h of discovery** (§65).

**BRANDEPIC (§82).** Keep the design config-driven, with nothing hard-coded to BEAM. Do *not* build multi-tenancy. Deploy a separate copy per client if the opportunity becomes real. This is the "no extra V1 complexity" they asked for.

---

## 6. Integration matrix (for the proposal, as they request in §50)

| System | V1? | Type | Data | Notes |
|---|---|---|---|---|
| Mollie | V1 | API + webhooks | Payments, refunds, recurring (mandates), payment links, terminal | Bancontact. Account owned by BEAM. |
| Stripe | Optional | API + webhooks | — | Only if there is a specific need. |
| Billit | V1 | API | Customers, invoices, payment status | Billit remains the Peppol access point. |
| WebinarGeek | V1 | API + webhooks (+ scheduled pull as fallback) | Registrations, attendance, watch time, replay, polls, CTA | Temporary; native webinar is P3+. Payload completeness to be verified. |
| ScoreApp / Typeform | V1 | Webhook | Answers, score, outcome, UTM | Replaced by native assessments in P2. |
| Lightspeed | V1 (retained for horeca/retail) | Import, optionally a nightly sync | Sales for reporting | Replacement decided in P2. |
| WordPress | V1 | Embed script / iframe + booking widget | Forms, booking, UTM | |
| Google Analytics / GTM | V1 | Client-side events | Funnel events | Consent-mode compliant. |
| Meta / Google Ads | V1 capture (UTM, click IDs). P2 Conversions API and cost import | API | Conversions, spend | Needed for CAC and ROAS (§34). |
| Email provider | V1 | API + webhooks | Send, bounce, complaint, open/click | EU provider, BEAM-owned domain. |
| SMS provider | Optional | API | Reminders | If BEAM wants it. |
| Meta messaging (IG / Messenger) | P3 | API (app review) | Inbox | |
| AI model provider | P3 | API (EU region, no training) | Per the AI register | |
| Zapier / Make | Fallback only | Webhooks | — | Our own outbound webhooks make it possible without depending on it. |

---

## 7. Implementation approach and timeline (draft)

**Phase 0: Discovery and Specification.** 3–4 weeks, fixed fee.

- Workshops with Jonathan, Tinne, George, Tet and front desk.
- Resolve the 20 decisions in §85.
- Audit of SimplyBook, Lightspeed and Mailchimp usage and data exports.
- The VAT and fiscal questions (§4.1, §4.6).
- Click-through UX prototype of the portal and the booking flow.

*Deliverables:* functional specification, data model, final V1 scope, acceptance test plan, migration plan, fixed V1 price.

*Why this matters:* this de-risks a fixed price for both sides, and the spec becomes the contract annex BEAM asked for. **The fee for this phase can be credited against V1 if BEAM proceeds.**

**Phase 1: V1 build.** About 6–7 months with a core team of 3 developers plus a project lead and designer. Delivered in 2–3-week sprints, with a demo to BEAM on staging at every sprint.

| Milestone | Indicative timing | Content | Payment trigger |
|---|---|---|---|
| M1 Foundation | Month 1–2 | Infrastructure, authentication and roles, audit log, customer record, consent, migration dry-run | Accepted on staging |
| M2 Booking and Commerce | Month 2–4 | Catalogue, pricing, ledger, membership, Mollie, booking day/night, events, waitlist, portal | Accepted on staging |
| M3 Communication | Month 4–5 | Email infrastructure, campaigns, sequence engine and templates, forms, preference centre | Accepted on staging |
| M4 Operations and Integrations | Month 5–6 | Billit, WebinarGeek, assessments webhook, action dashboard, KPIs, tasks, front-desk sales | Accepted on staging |
| M5 Go-live | Month 6–7 | Go-live gate (§77), final migration and reconciliation, training, cut-over, 4 weeks of hypercare | Go-live acceptance |

**After go-live:**

- **Warranty:** 3 months. Bugs against the agreed specification are fixed free of charge, outside the monthly fee.
- **Phase 2 (Commercial Engine)** is quoted after V1 has stabilised, typically starting 1–2 months after go-live.

---

## 8. Effort sanity-check (internal)

**Purpose of this table.** It is an independent bottom-up check of the recommended V1, in **person-weeks of development**. Adjust it to SideStream's real velocity, including any AI-assisted development gains, before converting it to price.

| Module | Low | High |
|---|---:|---:|
| Foundation: infrastructure, CI/CD, staging/prod, authentication/MFA, roles, audit log, monitoring, backups | 4 | 6 |
| Customer record, dedupe/merge, timeline, tags, consent ledger, segmentation and exclusions, B2B data model | 5 | 7 |
| Catalogue, pricing, promotions, member pricing, price snapshots | 4 | 6 |
| Entitlement ledger: packages, expiry, adjustments, guest sharing, gift vouchers | 3 | 5 |
| Booking engine: day, night, capacity, schedules, exceptions, guests, waitlist and claim window | 6 | 9 |
| Events and ticketing (basic) | 2 | 4 |
| Payments: Mollie checkout, links, recurring memberships, refunds, abandoned-checkout tracking | 3 | 5 |
| Front-desk sales (terminal) and check-in | 2 | 4 |
| Customer portal: responsive, PWA, NL/FR/EN | 5 | 7 |
| Form engine: builder, conditional logic, UTM, embed, versioning | 4 | 6 |
| Email: provider integration, editor embed, campaigns, dynamic blocks, preference centre, suppression, sequence engine and templates, automation timeline | 8 | 12 |
| Integrations: Billit, WebinarGeek, assessment webhook, GA/website | 3 | 5 |
| Action dashboard, core KPIs, tasks | 3 | 5 |
| Data migration and reconciliation tooling | 4 | 6 |
| **Development subtotal** | **56** | **87** |
| QA, test automation, acceptance support (~15%) | 8 | 13 |
| Project lead, UX/UI design, Discovery spill-over (~20%) | 11 | 17 |
| Training and documentation | 2 | 3 |
| **Total V1** | **≈ 77 pw** | **≈ 120 pw** |

**Reading the numbers.** That is roughly **18–28 person-months.** At an illustrative blended rate of €[RATE]/day, V1 = 385–600 days × rate.

**If the result is far above our earlier indicative range,** the levers, in order, are:

1. Move events and front-desk sales to P2.
2. Ship fewer sequence templates.
3. Make the portal booking-only (no purchases).
4. Use a lighter migration (balances and customers only, no full history).

Each lever should be priced as a visible option in the proposal. That way BEAM chooses the scope and we do not simply cut it.

**Pricing model to propose:**

- **Discovery:** fixed fee.
- **V1:** fixed price **per milestone**, based on the signed spec.
- **Changes:** a change-request process with an impact quote.
- **P2 and beyond:** quoted per module.

This matches §75 (bug / small improvement / new feature / major module).

---

## 9. Monthly fee structure (draft)

**Separate three things,** as §88.6 asks:

**A. Infrastructure and third-party costs.** Passed through at cost, or billed directly to BEAM.

The figures below are indicative and must be verified with providers for BEAM's actual volumes.

| Item | Indicative / month |
|---|---|
| Hosting: app, managed Postgres, backups, staging and prod (EU) | €150–450 |
| Email provider (depends on contact and send volume) | €30–200 |
| Error monitoring, uptime monitoring, logging | €0–80 |
| Email editor SDK licence (if commercial) | €0–250 |
| WebinarGeek, ScoreApp, Billit, Mollie fees | Existing BEAM subscriptions and transaction fees |
| AI usage (P3, with a monthly cap) | €20–200 |
| SMS (optional, per message) | Usage-based |

**B. Support and maintenance (fixed monthly fee, SideStream).**

*Included:*

- hosting operations;
- monitoring and alerting with on-call;
- security patches and dependency updates;
- backups and quarterly restore test;
- bug fixing;
- support desk under the SLA below;
- a monthly check-in;
- **[X] hours per month of small improvements**, with a monthly cap and no or limited carry-over.

*Excluded:*

- new features and modules (quoted separately);
- third-party outages beyond our control (we still coordinate);
- data entry or BEAM-side errors (billed if extensive);
- training of new staff beyond [N] sessions per year.

**C. Continuous development (optional retainer).** A fixed number of days per month at a reduced rate for the roadmap (P2 and beyond).

*Indexation:* yearly, following the Belgian health index or Agoria, stated in the contract.

**Proposed SLA:**

| Severity | Examples | Response | Target workaround/fix | Hours |
|---|---|---|---|---|
| **Critical** | Platform down, booking or payments not working, data breach | **1 h** | 4 h workaround | **7/7, 08:00–22:00** (BEAM operates weekends; to be confirmed) plus emergency phone |
| **High** | Major function degraded (e.g. emails not sending, sync failing) | 4 business hours | 2 business days | Business days 09:00–18:00 |
| **Normal** | Bug with workaround, question | 1 business day | Next planned release | Business days |
| **Improvement** | Enhancement request | Acknowledged in 2 business days | Planned in monthly backlog review | — |

*Support channels:*

- a ticketing or shared inbox as the single source of truth;
- a shared Slack or WhatsApp group for quick questions;
- a phone number for Critical only.

*Monthly SLA report* covering uptime, tickets, response times and incidents.

*Uptime target:* 99.5% per month.

*Release process:* every change goes through staging, then BEAM acceptance for visible changes, then production.

---

## 10. The written agreement (their point 2)

**Proposed contract set.** This answers §68–71, §73–78 and §88 in one structure:

1. **Master Services Agreement.** Covers parties, liability caps, confidentiality, IP, term and termination, governing law (Belgian), and disputes.
2. **Statement of Work: Discovery.** Then **SOW: V1**, with the functional spec, milestones, payment schedule, acceptance procedure and responsibilities (including BEAM's product owner and decision deadlines).
3. **Service Level Agreement.** Covers support, maintenance, the monthly fee, inclusions and exclusions, and indexation.
4. **Data Processing Agreement (Art. 28 GDPR).** Includes the subprocessor annex, security measures annex, breach notice within 24 h, and assistance with data-subject rights.
5. **Exit and Transition Plan.** Covers the data export format (full Postgres dump plus CSV per entity), handover of code, documentation and credentials, transition support of up to [N] days at standard rate, and the notice period.

**IP position to propose (balanced, and protects SideStream's reuse):**

- **BEAM owns** its data, database, content and all **BEAM-specific code** upon payment of the relevant milestone.
- **The repository lives in a BEAM-owned GitHub organisation** from day one, with SideStream as maintainer. This meets their exit requirement directly. No escrow is needed.
- **SideStream retains** its pre-existing and generic components (the framework, the generic engines). BEAM receives a **perpetual, irrevocable, royalty-free, transferable licence** to use and modify them, *including by a third-party developer*. This satisfies "BEAM must not become technically trapped."
- **This must be decided now** if SideStream wants to reuse the platform for other wellness clients (BRANDEPIC, §82). We need to specify which engines are "generic" and that reuse never includes BEAM data, branding or BEAM-specific configuration.

---

## 11. Questions to send BEAM now

These do not block the proposal date, but they affect the price:

1. **Volumes.** Number of customer records, monthly active customers, bookings per month, sessions per day, beds per night, events per month, email list size and monthly send volume.
2. **Sessions.** Are they seat or bed capacity only, or do they need specific staff, rooms or equipment assigned?
3. **Horeca.** Does BEAM sell food and drinks for on-premise consumption, and roughly what is the annual turnover? (GKS obligation.) Which Lightspeed features are used daily?
4. **Gift vouchers.** Are they sold today? How (paper, online, via which tool)?
5. **B2B product.** Is the core B2B offer corporate packages or credits for employees, events or room hire, or something else?
6. **Webinars and assessments.** Current tools (WebinarGeek? Zoom? ScoreApp? Typeform?), and what volume per month?
7. **Package portability.** Do current packages and credits cover multiple service types with different VAT rates? Who is BEAM's accountant?
8. **Opening hours.** Weekends and evenings. This is relevant for the Critical support window.
9. **Decision-maker.** Who is the day-to-day product owner and decision-maker during the build?
10. **Target go-live date.** Any hard constraints such as season, SimplyBook renewal date or Mailchimp plan renewal?
11. **Existing accounts.** Which accounts already exist under BEAM ownership (domain/DNS, Google Workspace/M365, Mollie, GitHub)?

---

## 12. Open items for Gaëtan and Achille before writing the proposal

1. **Rates and team.** Confirm the blended day rate, the team composition and the earliest start date.
2. **Stack.** Confirm SideStream's standard stack and hosting preference, then replace the defaults in §5.
3. **Earlier estimate.** What was the earlier indicative development and monthly range? We need to bridge it explicitly.
4. **Velocity.** Decide whether the AI-accelerated delivery claim is part of the pitch. If so, adjust the §8 estimate, but keep a contingency.
5. **BRANDEPIC.** Decide our stance on reusing generic components. This drives the IP clause.
6. **Support capacity.** Can we commit to 7/7 Critical support with a 1 h response? Who is on call, and who is the backup? They will ask how support works if one person is unavailable. Answer with named people and a backup.

*Sources for the fiscal and webinar points:* [OECCBB – GKS 2.0 mandatory from 1 July 2026](https://blog.oeccbb.be/nl/article/horeca-het-nieuw-geregistreerd-kassasysteem-gks-2.0-wordt-verplicht-vanaf-1-juli-2026/31413) · [fiskaly – GKS 2.0 and FDM requirements](https://www.fiskaly.com/blog/gks-2-0-fdm-requirements-belgium) · [Fiscal-requirements – GKS 2.0 deadlines](https://www.fiscal-requirements.com/news/5864-when-do-belgian-horeca-businesses-need-to-switch-to-gks-20) · [WebinarGeek HubSpot connector (poll, CTA, watch time sync)](https://ecosystem.hubspot.com/marketplace/listing/webinargeek-40724) · [WebinarGeek API overview (third-party)](https://rollout.com/integration-guides/webinar-geek/api-essentials)
