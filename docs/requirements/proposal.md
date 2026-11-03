&#91;image: Sidestream\]

# BEAM Platform – Proposal by SideStream

Oct 14, 2026 · @Gaetan Jansseune

Dear Jonathan, Christophe, Sanne, George, Tinne and Jonas,

Thank you for the detailed blueprint and the open conversation at BEAM. You asked us to challenge it, to be clear about support and ownership, and to put everything in writing before we start. This proposal does exactly that.

This is our proposal for your new BEAM platform: one integrated system for your customers, bookings, payments, email, events, sales, reporting and AI, fully owned by you. Your first working version (V1) is ready in 6 weeks, and the rest of your blueprint follows in releases, completing the full platform in about 3 months.

&#91;embedded content: Key figures of this proposal\]

## Who you work with

**Sidestream is Gaetan and Achile, an AI development and security studio in Ghent.** We build software, automation and AI for our clients, and we test it the way an attacker would. A third developer works with us on a freelance basis.

&#91;image: Gaetan Jansseune and Achile Batier, co-founders of Sidestream\]

**Platforms we have built and keep running:**

- **[Fittin'](https://fittin.be):** a private gym booked by the hour in Sint-Amandsberg. Members reserve the room, open the door with the app and train without staff on site.
- **[De Flesjesfabriek](https://flesjesfabriek.be):** an event venue in Ghent with two zones and up to 999 guests. Rooms, rates and a request flow turn a visitor into a booking without a phone call.
- **[Ticketbalie](https://ticketbalie.com):** ticketing for organisers in Belgium and the Netherlands, with ticket sales, scanning at the door and automatic payouts.
- **[SuperHoreca](https://superhoreca.app):** staff scheduling for hospitality teams, with time clock, tasks, orders and reservations.
- **[Trapspotter](https://trapspotter.com):** community-powered driving safety on iOS, Android and web, used by more than 60,000 people.
- **[House of Talents](https://houseoftalents.be):** AI content automation that generates, curates and schedules social content for a full roster of talent, with a person approving before anything is posted.
- **Investeren.org:** nine asset classes in one dashboard, with AI summaries.

Source: [sidestream.be](https://sidestream.be)

## 1. Our recommendation in brief

**We build the core of your business natively. That core is customers, bookings, packages, payments, email, forms and reporting.** We integrate specialised services only where building them ourselves would cost more to run than it saves. Every integration runs inside your platform, so your team and your customers never leave the BEAM environment.

| Current tool | Our recommendation | Type |
| --- | --- | --- |
| SimplyBook | **Replaced.** A native booking system for day sessions, nights, events and capacity, with all current SimplyBook functionality and more. | Native |
| Lightspeed | **Replaced** for in-centre payments and sales, through a payment terminal connected to the platform. Before we confirm the scope, we need to know what Lightspeed is used for today (see section 14). | Native + payment terminal |
| Mailchimp | **Replaced** by a full email platform built into BEAM. Resend is the sending engine. This is one of the largest modules in the platform. | Native + Resend (delivery) |
| Mollie / Stripe | Online payments for bookings, packages, memberships and tickets. We choose between **Mollie, Stripe and Viva** per use case, based on fees, Bancontact support and terminal options. | API + webhooks |
| Billit | **Kept** for invoicing, accounting and Peppol, connected through its API. Invoices, customers and payment status sync automatically. | API |
| Zoom / WebinarGeek | **Replaced.** Webinars run *inside* the BEAM platform. Video is delivered by **YouTube Live, with Google Meet for presenters**. Registration, chat, polls, CTAs and watch time are built natively in BEAM. | Native + embedded video service |
| Typeform / ScoreApp | **Replaced** by a native form and assessment builder with scoring, branching and personalised results. | Native |
| WordPress | **Replaced** by a website that SideStream builds and hosts. Its back end is connected to Claude, so you can edit your own website by simply asking. Included in this proposal. | Native |
| Meta / Google Ads | **Read-only connection.** Campaign, cost and conversion data flow into the BEAM dashboards. Ads are still created in Meta and Google. Creating ads from BEAM is a possible future step. | API (read-only) |

**Why we stream webinars through an external service.** Live video is very data-intensive. Building and running our own streaming infrastructure would cost a great deal to operate and maintain, with no benefit to you. We have used YouTube Live and Google Meet through their APIs for other course and live platforms. Viewers watch inside the BEAM platform, and every interaction is stored in the BEAM customer record.

## 2. Scope

**Your full blueprint is in scope. We build it in the same order as your own priority structure (section 83).** V1 contains your suggested V1 plus the assessment engine and the waitlist with expiring seat offers. Each later release is delivered within the same investment, and is visible on the roadmap from day one.

| Release | When | What you get |
| --- | --- | --- |
| **V1 – Core operating platform** | Weeks 1–6 | Central customer record and full timeline; consent per purpose; segmentation with exclusions; NL/FR/EN everywhere; day and night booking; capacity; packages and credits; membership; pricing and promotions; online payments; in-centre payments; customer portal; form and assessment builder; lead capture with source and UTM; transactional email, campaigns and sequences; preference centre; staff action dashboard; tasks; roles and permissions; audit log; Billit integration; data migration |
| **Release 2 – Commercial engine** | Weeks 9–10 | Native webinar module (live, replay, on-demand, simulive); lead-priority waitlist for Lead Magnet events; events and ticketing extensions; B2C pipeline; retention engine; automation conflict rules; abandoned checkout recovery; no-show and cancellation reporting; guest and package-sharing controls |
| **Release 3 – Sales and marketing intelligence** | Weeks 11–12 | B2B CRM and pipeline; campaign attribution; Meta and Google Ads dashboards; marketing dashboards; unified inbox (email, forms, Instagram, Messenger); referral and partner management; management and finance dashboards |
| **Release 4 – AI and admin flexibility** | Weeks 13–14 | Natural-language questions on BEAM data; AI-assisted email creation; AI-drafted customer service replies; weekly management summary; custom dashboards; custom workflow builder; churn and repurchase indicators |
| **Later – Advanced automation** | After the build-out, when you decide | Automated B2B prospecting and outbound email; voice AI; predictive analytics; native mobile app; gamification. Each starts only after your GDPR and ePrivacy review. Proposed case by case. |

**The three items you asked us to classify (section 84):**

- **Assessment engine: V1.** It shares the form builder, so it adds little extra work. It covers scoring, branching, versioning and personalised result pages.
- **Lead-priority waitlist: V1 delivers the waitlist with real expiring claim links and protected confirmed seats. Release 2 adds the lead-priority windows and queues on top.** If Lead Magnet events are planned in the first two months, we move this into V1.
- **Native webinar: Release 2.** Until it goes live, you keep your current webinar tool, and registrations are imported into the customer record.

**What is not included:**

- Hardware: payment terminals, receipt printers and tablets.
- Paid third-party subscriptions and usage-based costs (see section 6).
- Creating your content: texts, photos and videos.
- Legal advice on your own privacy documents.

## 3. Architecture and hosting

**One platform, one database, one customer record.** Every module reads from and writes to the same central customer core. Booking, payments, email, events, forms, webinars and sales all feed it. The core keeps growing as the platform is used: every booking, purchase, email interaction, form answer and webinar minute adds to what you know about a person. Customers, leads, event visitors, members and B2B contacts can be split into any segment or category.

&#91;embedded content: Platform architecture · 8 modules on one customer core\]

**Building blocks that answer your requirements:**

| Building block | What it guarantees |
| --- | --- |
| Customer timeline (append-only activity log) | The full history on one screen. Live, replay and on-demand activity are stored as separate event types. |
| Credits ledger | Every package purchase, session used, expiry, extension, manual adjustment and guest use is a separate entry with who and why. Customers simply see "4 sessions remaining". |
| Consent register + separate suppression list | Consent per purpose with date, source and wording version. Unsubscribes can never be overwritten by an import. |
| Versioning | Forms, assessments and prices are versioned. Historical answers, scores and transaction prices are never rewritten. |
| Automation engine | Entry, exit and conflict rules per journey; conditions checked at the moment of sending; full log per customer. |
| Sensitive-field labels | Health, sleep and stress data are labelled sensitive. Access is limited by role, and the data is blocked from AI by default. |
| Audit log | Who changed what, when, with the old and new value. |
| Multi-language layer | NL, FR and EN in every screen, email, form and portal page. A missing translation blocks sending instead of falling back to the wrong language. |

**Hosting:**

- **Database:** PostgreSQL on **Neon or Supabase**, in an EU region (Frankfurt). Backups are stored in the EU.
- **Application:** Vercel, with the application's server functions pinned to the EU (Frankfurt). Customer data is stored only in the EU database, not on Vercel.
- **Email delivery:** Resend, sending from its EU region.
- **Payments:** Mollie, Stripe or Viva, with the account in your name.
- **Accounts:** Every service is set up in your own name and paid directly with your card, so you see exactly what you pay. Sidestream manages the accounts for you.

**Testing new features:**

- **During the build**, you test the platform with fictitious data. Real customer data only enters after the go-live conditions in section 9 are met.
- **After go-live**, new features are first switched on for selected test users on the live platform. Everyone else gets them once you approve. Any release can be rolled back instantly.
- **A separate staging environment** is included, so every change can be tested before it reaches live customers.

## 4. Timeline and way of working

**A first usable version (MVP) after 3 weeks and a working V1 after 6 weeks. Go-live follows in weeks 7–8, after the final data migration and training.** You choose the start date. We start within 3 to 5 business days of your go-ahead, and the full platform is complete in about 3 months.

&#91;embedded content: Project timeline · 14 weeks\]

In week 1, the kick-off workshop settles your open decisions: booking and cancellation rules, package validity, membership logic, first automations and day-one KPIs. In the same week we set up the email domain and help create the payment and Billit accounts.

**How we work together:**

- **A weekly sprint meeting** of half an hour. We demo what was built, you test and give feedback, and together we fine-tune the next week.
- **Testing is continuous.** We test every feature as we build it. Your team tests in parallel, which catches real-world cases early.
- **One shared overview** of the backlog, decisions and open questions, so both sides always know the status.
- **We don't stop at go-live.** After the 3-month build, we keep working with you. The platform keeps improving based on how the team actually uses it.

**What we need from you:**

- One day-to-day decision-maker (product owner) for the weekly meetings and quick questions.
- Access to the domain and DNS, and to the current tools where we migrate data from.
- Test feedback within the sprint week.

Decisions that arrive later than planned move the timeline by the same amount.

## 5. Investment

**Your investment for the complete platform is €9,500 excl. VAT, and you can spread it in interest-free monthly instalments.** You pay 10% at signing. Nothing else is due until the platform is live with real data and you are satisfied. The investment covers V1 and Releases 2–4 (section 2), including your new BEAM website that replaces WordPress.

&#91;embedded content: Sidestream estimate · one-off investment, excl. VAT\]

**What each part covers:**

- **Email & marketing platform:** campaigns, automated sequences, visual editor, dynamic content, multilingual templates, preference centre, deliverability and the automation timeline.
- **Customer core (CRM):** one profile per person, full timeline, segmentation, consent per purpose, duplicate merging, roles, audit log, and B2B companies and pipeline.
- **Booking & capacity:** day sessions, nights, events, capacity, waitlists with expiring seat offers, lead-priority rules and the customer portal.
- **Commerce & payments:** packages and credits, membership, pricing and promotions, online and in-centre payments, and abandoned checkout.
- **Testing & quality assurance:** automated tests on every module, load tests, the seven scenarios and acceptance tests (sections 11–12), and test rounds with your team.
- **Billing & invoicing:** invoices and receipts for every sale, credit notes for refunds, VAT per line, company invoices for B2B, and automatic sync with Billit for accounting and Peppol.
- **AI systems & insights:** action dashboard, management dashboards, retention lists, campaign attribution, natural-language questions and AI drafts.
- **Forms & assessments:** form builder with conditional logic, scoring assessments, result pages and lead capture with source tracking.
- **BEAM website:** the new public website with Claude-assisted editing, replacing WordPress.
- **Setup, migration & training:** hosting, email domain, account set-up, data migration, training, documentation and two weeks of hypercare.
- **Webinar module:** live, replay, on-demand and simulive webinars inside BEAM, with polls, CTAs, chat and watch time.

**Payment:**

|  | Option A – instalments over 12 months | Option B – one payment |
| --- | --- | --- |
| At signing (10%) | €950 | €950 |
| In BEAM session or store credit, without expiry, at go-live (5%) | €475 | €475 |
| From go-live with real data (85%) | 12 × €672.92 | €8,075 once |
| **Total** | **€9,500** | **€9,500** |

Instalments are interest-free. We often work this way on larger projects, so the investment is spread over the period in which the platform starts paying for itself.

Third-party costs (hardware, payment fees, Billit, extra usage) are listed in section 6. Cash payments are invoiced with 21% VAT.

## 6. Monthly fee

**Our support and maintenance fee is a fixed €299 per month excl. VAT, starting only once the platform is live with real data.** The running costs of the services are separate: you pay them directly to the providers, in your own name. They are an indication of about €110–205 per month for up to 2,000 active clients. If you choose instalments (section 5), the instalment comes on top for at most 12 months.

**Running costs – services in your name, paid directly to the provider (indicative):**

| Service | What it does for you | Plan and price (checked October 2026) | Estimate per month |
| --- | --- | --- | --- |
| [Neon](https://neon.com/pricing) | EU database (Frankfurt) with backups and a 7-day restore window | Launch plan: $0.106 per compute-hour + $0.35 per GB per month, no minimum | $50–100, depending on usage |
| [Vercel](https://vercel.com/pricing) | Hosting of the platform and website, server functions in the EU | Pro: $20 per developer seat per month, including $20 of usage | $20–30 |
| [Resend](https://resend.com/pricing) | Sending all emails | Pro: $20 for 50,000 emails, $35 for 100,000, then $0.90 per extra 1,000 | $20–35 |
| Claude API (Anthropic) | AI insights, questions and drafts | Pay per use. Sonnet 5.5: $2 per million tokens in, $10 out. Haiku 5.5: $0.10 in, $0.50 out | $30–60 |
| **Total** |  |  | **$120–225 (about €110–205)** |

These amounts are an indication only. Actual costs vary with usage, and providers can change their prices at any time. Providers bill in US dollars. An alternative database is [Supabase](https://supabase.com/pricing) Pro at $25 per month including a small server.

**Sidestream support and maintenance – fixed:**

| Component | What it covers | Value per month | You pay (excl. VAT) |
| --- | --- | --- | --- |
| **Support & maintenance** | Monitoring and alerts, security and software updates, bug fixes, minor updates, support (section 7), and managing your provider accounts | €299 | €299 |
| **Sidestream Security** | Periodic ethical-hacking tests, security monitoring and reporting (section 9) | €99 | **Included free** |
| **Total** |  | €398 | **€299** |

**Above the included usage:** with more than 2,000 active clients or exceptionally heavy use, provider costs rise with use. We show you the numbers before anything changes.

**Not included:**

| Item | How it is charged |
| --- | --- |
| New features and major changes | Proposed case by case with a fixed price (section 8) |
| Payment fees (Mollie, Stripe or Viva) | Directly to you by the provider, per transaction |
| Payment terminal(s) | Purchase or rental, directly from the provider |
| Billit subscription and API use | Your own Billit subscription. Billit charges API use directly, depending on your plan and usage |
| SMS reminders (optional) | Per message, at cost |
| Google Workspace for Meet live streaming | Only if your current plan does not include it |

**Contract terms:**

- **Indexation:** the Sidestream fee is indexed once a year in January, following the Belgian health index.
- **Notice:** cancellable with 3 months' notice.

**What it replaces:** the platform removes the subscriptions to SimplyBook, Mailchimp, Lightspeed, WebinarGeek or Zoom, Typeform or ScoreApp, and WordPress hosting.

## 7. Support and availability

**Support is included in the monthly fee. A critical problem, such as booking or payments not working, gets a response within 2 hours on business days, and within 4 hours at weekends.** You talk directly to the people who built the platform, with no account managers or ticket layers in between.

| Severity | Examples | First response | Resolution target | Availability |
| --- | --- | --- | --- | --- |
| **Critical** | Platform down, booking or payments not working, suspected data breach | Within 2 hours (business days), within 4 hours (weekends) | Workaround or fix the same day; we keep working until it is resolved | Business days 09:00–18:00; weekends 10:00–18:00 via the emergency number |
| **High** | A major function is disrupted: emails not sending, Billit sync failing | Within 4 business hours | 24–48 hours | Business days, 09:00–18:00 |
| **Normal** | Bug with a workaround, functional question | Within 1 business day | Within 1 week, usually in the next weekly release | Business days |
| **Improvement** | New idea or optimisation | Acknowledged within 2 business days | Planned in the weekly sprint | Business days |

**Channels:**

- A shared WhatsApp or Slack group for day-to-day questions.
- A support email address that logs every request.
- An emergency phone number for Critical issues.
- A monthly report covering uptime, incidents, requests handled and response times.

**Team and continuity:** You are served by a team of three. The two SideStream founders build and maintain the platform. A third developer works with us on a freelance basis and can take over support when needed.

- **Shared knowledge:** both founders know the platform, and the third developer has access and documentation to step in.
- **Always reachable:** holidays are planned so someone is always reachable for Critical issues.
- **Automatic alerts:** monitoring warns us of problems, often before you notice them.
- **Managed hosting:** the platform runs on managed cloud hosting with backups and instant rollback.
- **Not dependent on us:** You own the code, which uses standard technology and is documented, so any qualified developer can continue the work.

**Uptime target:** 99.5% per month. This excludes announced maintenance and large outages at global cloud providers (Amazon, Google, Microsoft). Those are rare, and when they happen many services such as Gmail and online banking go down at the same time. We inform you straight away and restore service as soon as the provider is back.

**Quality is shared work.** We test every feature, run load tests and monitor the platform continuously. Still, no software is ever free of bugs, and some situations only show up in real use. We ask your team to report anything that looks wrong, and we fix it within the times above.

## 8. Changes and improvements

**Bug fixes and minor updates to existing features are included in the monthly fee. New features and major changes are proposed case by case, with a fixed price and delivery date, and start only after you approve.**

| Type (BEAM section 75) | Examples | Cost |
| --- | --- | --- |
| **Bug** | Something agreed does not work | Included, always |
| **Minor update** | Small adjustments to existing features: texts, fields, settings, layout, an extra filter or email template. Up to about half a day of work per request. | Included |
| **New feature or major change** | New functionality, or a substantial change to how an existing feature works | Change proposal with a fixed price |
| **New release or module** | A new product area outside this proposal, such as a native mobile app | Release proposal with a fixed price and planning |

**How a change proposal works:**

1. You describe the request in the shared channel or in a meeting.
2. Within 5 business days, we send a one-page proposal. It covers what will be built, what changes for users, the fixed price, the delivery date and any effect on the monthly fee.
3. You approve in writing; an email is enough. The work is planned in the next sprint.
4. We deliver. You test against the acceptance points in the proposal, and we invoice after acceptance.

**Pricing:**

- **Fixed price per proposal:** based on our day rate. You always know the cost before work starts.
- **Optional development bundle:** You can prepay a bundle of days at a reduced rate, so that smaller requests are handled without a separate proposal each time.

**Turnaround:**

- **Errors:** fixed within 24–48 hours.
- **Minor updates:** live within a week.
- **Approved proposals:** delivered on the date stated in the proposal.

## 9. Security and privacy

**Privacy and security are go-live conditions, not later improvements. We accept your go-live list (section 77) as the conditions for loading real customer data.** Vibrant Lifestyle Collective BV is the data controller and SideStream is the data processor. An Article 28 Data Processing Agreement is signed before any real data goes in.

**SideStream Security** ([sidestream.be/security](http://sidestream.be/security)) is part of every platform we build: *we hack you before someone else does.* We run periodic ethical-hacking tests on your platform and report the results to you. Its value is €99 per month; for BEAM it is included free of charge.

**Security measures:**

- **Encryption:** in transit (HTTPS/TLS) and at rest.
- **Access:** multi-factor authentication for all staff accounts, a strong password policy, and role-based permissions. Sensitive fields such as assessment answers and health data are only visible to roles that need them.
- **Logging:** an audit log of administrative actions with user, time, action, old value and new value.
- **Protection:** API security and rate limiting.
- **Maintenance:** automatic dependency checks and timely security updates.
- **Secrets:** stored in a managed secret store, never in the code.
- **Backups:** daily backups plus point-in-time recovery, stored in the EU. Retention: a 7-day restore window on Neon's Launch plan, or 30 days on its Scale plan. Restore tested periodically.
- **Recovery:** in a serious incident we restore the database to a moment just before it, with data loss limited to minutes. Restore target: within 8 hours.
- **Incidents:** we notify you **within 24 hours** of discovering a relevant security incident or data breach. We record discovery, affected systems and data, risk, actions, notifications and resolution.

**Sensitive (health-related) data:** answers about sleep, stress, recovery or wellbeing can count as health data under GDPR (Article 9). The platform protects them with the following measures, which are what GDPR requires. No ISO certification or special database is legally required.

- **Legal basis:** explicit consent per purpose, recorded in the consent register.
- **Extra protection:** sensitive fields are encrypted separately and visible only to roles that need them.
- **Logging:** every access is logged.
- **No AI by default:** sensitive data is excluded from AI.
- **DPIA support:** we support your DPIA where required.

Our hosting providers hold their own independent security certifications.

**Subprocessor register** (maintained and kept up to date):

| Subprocessor | Role | Data location | Data processed |
| --- | --- | --- | --- |
| Neon or Supabase | Database hosting | EU (Frankfurt) | All platform data |
| Vercel | Application hosting | EU region | Application traffic in transit; no customer data stored. US company: transfer covered by SCCs/DPF |
| Resend | Email delivery | Sends from the EU region; delivery logs kept 30 days in the US | Recipient address, email content, delivery and engagement events |
| Mollie, Stripe or Viva | Payments | EU | Payment details (under your own contract) |
| Billit | Invoicing and Peppol | Belgium / EU | Customer and invoice data |
| Google (YouTube Live / Meet) | Webinar video | EU / US | Viewer connection data while watching |
| AI provider (Claude) | AI features, from Release 4 | EU-hosted endpoint where available | Only the fields documented per AI feature |

**Transfers outside the EEA:** for every service that processes data outside the EEA, the transfer mechanism is documented (EU-US Data Privacy Framework or Standard Contractual Clauses). Contact, consent and campaign data always stay in the EU database. Resend receives only what is needed to deliver each email.

**AI and personal data:**

- **Documentation:** for every AI feature we record which fields are sent, when, why, to which provider and where, plus retention, training status and how prompts and outputs are stored.
- **No training on your data:** we use only commercial API terms under which customer data is not used to train models. Opt-in training settings stay off.
- **Sensitive data excluded by default:** health, sleep, stress and other sensitive fields are blocked from AI by default. Turning this on requires an explicit setting by you, a documented purpose and, where needed, a DPIA.
- **No unofficial connections:** no personal ChatGPT or Claude accounts are connected to customer data.
- **Human approval:** AI prepares, a person approves, and only then does the system act.

**Customer rights and retention:**

- **Customer rights:** access, correction, deletion, restriction, objection and portability are built in.
- **Deletion:** propagates through all modules and connected systems. Data that Belgian law requires us to keep, such as invoices, is kept separately, and the marketing profile is removed.
- **Retention table:** agreed with you in the kick-off and enforced automatically by the platform.
- **DPIA support:** we help you prepare a DPIA before high-risk features are switched on, such as AI ranking, watch-time profiling and voice AI.

## 10. Ownership, hosting and exit

**You own your data, your database and the code we build for you. You are never locked in.** At SideStream we build systems to last, and our clients own them. We actively encourage clients to be the end owner of their apps. We support migrations, and you can host the platform on your own accounts whenever you want.

| Topic | Our commitment |
| --- | --- |
| **Data and database** | Always yours: customer, company, transaction, content and reporting data. You can export everything at any time. |
| **Source code** | The code we build for you becomes your property after delivery and payment of each milestone. |
| **Repository** | You have access to the code repository from the start. At delivery, it is transferred to a GitHub organisation owned by BEAM. |
| **SideStream components** | General building blocks we reuse across projects stay SideStream's. You receive a permanent, free licence to use and modify them, also by another developer. BEAM-specific code, configuration, data and branding are never reused for anyone else. |
| **Hosting accounts** | In your own name from day one, paid directly by you. Sidestream has administrator access to manage them. |
| **Another developer** | Possible at any time. The platform uses standard technology and is fully documented, so another party can continue the work. |

**If the cooperation ends, you receive:**

- A complete database export (full database plus readable CSV files per data type).
- The full source code and repository.
- Technical and user documentation.
- All credentials and integration keys.
- Transfer of the hosting and service accounts to you, or to a party you choose.
- Transition support to hand over to you or the new developer.

**Notice period:** 3 months. We keep the platform running and supported until the handover is complete.

## 11. The seven scenarios (section 87)

**Each scenario is handled by a system rule rather than manual work, and each one is demonstrated to you before acceptance.**

| # | Scenario | How the platform handles it |
| --- | --- | --- |
| 1 | **Late-entry email skip** | When someone enters a sequence, the engine calculates the send moment of every step relative to the event. Steps whose moment has already passed are marked "skipped – late entry" in the automation log and are never sent. A Friday registrant for a Sunday webinar gets the confirmation and the day-of reminder only. |
| 2 | **Fast unsubscribe** | An unsubscribe goes into the suppression list immediately. It can come from the one-click link, the preference centre, a staff action, or a spam complaint reported by Resend. Every marketing email checks the suppression list at the moment of sending, so marketing stops within seconds, well inside the 15-minute target. Running sequences end with the reason "unsubscribed". |
| 3 | **Lead vs customer event access** | Status is calculated from paid transactions (lead, customer or member), and a manual correction by staff is never overwritten. On a Lead Magnet event, reserved seats can only be booked by leads during the lead window. Customers see "Opens for you on \[date and time\]" instead of a button that fails. At the release moment, the remaining seats open to the customer queue and then to the public. |
| 4 | **Seat claim expiry** | A seat moves through fixed states: waiting, offered (with an expiry time), then confirmed or released. The offer link is personal, single-use and stops working at expiry. The platform checks expiries every minute and offers the seat to the next eligible person. No automation can ever remove a confirmed seat. |
| 5 | **Replay data separation** | Every webinar interaction is stored with its mode: live, replay or on-demand. Poll answers, CTA clicks and watch time are recorded per mode, so reports and automations can target each mode separately. |
| 6 | **Sensitive AI exclusion** | Health, sleep, stress and other sensitive fields carry a "sensitive" label in the data model. The AI layer can only read approved fields, so sensitive data is filtered out before any request leaves the platform. Enabling it requires an explicit admin setting and a documented purpose, and is logged. |
| 7 | **End-to-end deletion** | One deletion request starts a deletion workflow. It removes or anonymises the person in the CRM, email, webinar, assessment, waitlist and AI logs, and sends deletion requests to connected systems through their APIs. Invoices that Belgian law requires us to keep are retained but unlinked from the marketing profile. A minimal suppression record ensures the person is never re-imported into marketing. You receive a confirmation report, and the action is logged in the audit trail without personal data. |

## 12. Acceptance

**Your acceptance tests (section 76) become the formal checklist for signing off each delivery.** A delivery is accepted when every test on its checklist passes. Acceptance triggers the matching payment.

| Delivered in | Acceptance tests |
| --- | --- |
| **V1** | **Core:** customer can register, book, pay and cancel; package balance updates; member discount applies automatically; administrator can change a booking; CRM shows the activity; reports reflect the transaction; data can be exported. **Email:** late-entry reminders are skipped; unsubscribe stops marketing within 15 minutes; hard bounces are suppressed; lead, customer and member content blocks display correctly. **Assessment:** a weighted, branched assessment works; an existing customer record is updated; a result does not create newsletter consent; sensitive free text is excluded from AI. **Waitlist:** the same person cannot take a second seat; the claim window expires correctly; a confirmed seat is protected. **GDPR:** export works; deletion propagates; consent history is kept; suppression survives an import. |
| **Release 2** | **Webinar:** registration is not counted as attendance; watch time is captured; replay activity and replay polls are stored separately from live. **Lead-priority waitlist:** lead and customer rules work; a waiting lead who buys is reclassified correctly, without losing a confirmed seat. |

**Acceptance procedure:**

1. We demo each test in the weekly meeting and hand over the checklist.
2. You test within 5 business days and reports any failed test.
3. Blocking issues are fixed and retested. Minor issues do not block acceptance but are fixed within the support times in section 7.
4. You confirm acceptance in writing. A delivery that has been in live use for 10 business days without a reported blocking issue counts as accepted.

## 13. Our answer to your 11 principles (section 88)

**All eleven are met, and each answer points to where it is fixed in this proposal and the agreement.**

| # | Your principle | Our answer | Where |
| --- | --- | --- | --- |
| 1 | We understand exactly what we are purchasing | Every module, release and exclusion is listed. No vague "AI platform": AI is a defined set of features in Release 4. | Sections 1, 2 |
| 2 | Core functionality is written down and signed | Scope, milestones and acceptance checklists become annexes to the signed agreement. | Sections 2, 12, 14 |
| 3 | BEAM retains control of its data | You own your data and database and can export everything at any time, in a standard format. | Section 10 |
| 4 | Source-code and IP ownership is clear | You own the code built for you after payment, with access from the start. Reusable SideStream components come with a permanent, free licence. | Section 10 |
| 5 | Support is contractually defined | Severity levels, response times, hours, channels and continuity are part of the agreement. | Section 7 |
| 6 | Monthly costs are predictable | Provider costs are paid at cost in your own name, plus one fixed monthly fee. New work is always quoted in advance with a fixed price. | Section 6 |
| 7 | The platform can evolve | Bug fixes and minor updates are in the monthly fee. New features follow a clear proposal process with a fixed price before work starts. | Sections 6, 8 |
| 8 | AI is used selectively | Rules first. Package balances, retention lists, waitlists and automations are rule-based. AI is only used for writing, summarising and answering questions, always with human approval. | Sections 2, 9 |
| 9 | V1 is not overbuilt | V1 runs your daily operations. Everything else follows in monthly releases, once V1 is proven in real use. | Sections 2, 4 |
| 10 | BEAM has an exit path | Database, code, documentation, credentials and accounts are handed over, with transition support. Any developer can continue. | Section 10 |
| 11 | Privacy and security are go-live criteria | No real customer data until the DPA, subprocessor list, hosting region, backups, export and deletion tests are confirmed. | Sections 9, 12 |

## 14. Agreement, open questions and next steps

**Everything in this proposal is documented in one signed agreement before development starts.**

**The agreement consists of:**

1. **Main agreement:** parties, scope, responsibilities on both sides, pricing and payment, intellectual property, liability, term, termination and exit.
2. **Annex 1 – Scope and roadmap:** V1 and Releases 2–4 as in section 2.
3. **Annex 2 – Acceptance checklists:** as in section 12.
4. **Annex 3 – Service level agreement:** support, monthly fee, inclusions and exclusions, as in sections 6–8.
5. **Annex 4 – Data Processing Agreement (Art. 28 GDPR):** with the subprocessor register, security measures and breach procedure.
6. **Annex 5 – Exit plan:** as in section 10.

**Questions for you:**

1. **Lightspeed:** what is it used for today? Payments for bookings, selling drinks and food, or other small transactions? If you sell food and drinks for consumption on site, Belgian law may require a certified registered cash register (GKS). In that case we include a certified solution for that part.
2. **Volumes:** roughly how many customers, bookings per month and email contacts, and how many emails are sent per month?
3. **Sessions:** do day and night sessions need specific staff, rooms or equipment assigned, or only seat and bed capacity?
4. **Gift vouchers:** do you sell them today? They fit naturally in the credits system.
5. **B2B:** will companies buy packages or credits for their employees? We would then add company accounts with employee usage reporting.
6. **Lead Magnet events:** are any planned in the first two months? If so, we move the lead-priority waitlist into V1.
7. **Credits and VAT:** could packages or credits be used across services with different VAT rates? Your accountant should confirm the VAT treatment before the package model is final.
8. **Contracts:** what are the renewal dates for SimplyBook, Mailchimp, Lightspeed and the webinar tool, so we can plan the switch-over before them?
9. **Product owner:** who is your day-to-day decision-maker during the project?

**Next steps:**

- [ ] Clarification call on the questions above
- [ ] Final proposal and draft agreement
- [ ] Signing of the agreement and DPA
- [ ] Kick-off workshop (week 1)
