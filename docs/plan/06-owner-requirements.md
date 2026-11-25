# Owner requirements phase (from 2026-11-25)

The owner's "CRM Operational Requirements & Development Review" (November 2026) defines the next
phase. Rule: build everything the way the owner wants it. Where this file and the older plan
(`03-build-order.md`, the module specs) disagree, this file wins.

## Decisions on top of the owner's document

| Topic | Decision |
| --- | --- |
| Languages | Dutch stays the default. **French stays** (the document said to drop it; the user decided 2026-11-25 to keep it). English stays. |
| Booking | Two steps, no account needed: email, full name, phone, payment method, then review and pay. |
| Shop orders | Also without an account, with the same details. |
| Webinars | Hosted on **WebinarGeek**. BEAM keeps the webinar record, artwork, materials, price and sales; WebinarGeek runs the broadcast. The native YouTube Live module of Release 2 stays off (`ff_webinar_portal`). |
| Payments | Stripe (Bancontact, cards, SEPA Direct Debit for memberships). |

## What the code does today versus what the owner wants

| # | Owner requirement | Today | Gap |
| --- | --- | --- | --- |
| 1 | Day sessions Mon, Thu, Fri, Sat, Sun; 10-12, 13-15, 16-18; 14 people; EUR 120 | Demo seed: four slots from 09:00, 12 seats | Settings and seed only |
| 2 | Night sessions Wed to Sun 20:00-08:00; 8 people; EUR 420 | Demo seed: Fri and Sat from 21:00 | Settings and seed only |
| 3 | Children: day only Saturday 13-15; under 12 free, 12-17 half price; always with a paying adult | No age-based tickets | New: child tickets on a booking, linked to an adult seat |
| 4 | Membership EUR 396/year: 1 night OR 4 days free; 20% sessions and packages; 15% products and events; 30% detox salt; usage visible on the profile | One `discountPct` per membership; benefit kinds exist | Discount per product category; "either/or" entitlement; profile card |
| 5 | Packages day 5/10/15/25/50, night 3/5/10; 18 months; day and night not interchangeable; buyable in the booking flow | Packages and credits exist | Seed the products; upsell inside the booking flow |
| 6 | Events on any date: name, description, venue, capacity, start/end, price (free allowed), artwork | Event sessions exist (`location` column) | Check artwork and free tickets; fill gaps |
| 7 | Webinars via WebinarGeek: title, description, capacity, start/end, price (free allowed), artwork, materials | Native YouTube module (free only) | Webinar record that points to WebinarGeek, paid tickets, materials, registrations passed to WebinarGeek |
| 8 | Dashboard: daily capacity per slot, who is coming (membership and package status), empty spots with a campaign button, daily revenue by type | Action dashboard | Rework the main dashboard around these four blocks |
| 9 | Two-step booking without an account; existing clients can sign in and pay with a package | Account required before booking | New guest flow (biggest piece) |
| 10 | Typeform-style onboarding at first sign-in: emergency contact, communication preferences, VAT number (marks a corporate client), all optional | None | New one-question-per-screen flow in the portal |
| 11 | Backend fixes: filters apply on select; waiting list grouped by date and type; date/time picker for reservations; closing-days calendar; booking rules only under Settings; icons at reception; searchable dropdowns in new order and promotions; automations as flowcharts and in categories; visual email builder | Partly | Ten small to medium UI changes |
| 12 | Roles Administrator, Manager, Front Desk, Finance, plus custom roles with per-module permissions | Fixed role list with editable permissions | Allow staff-made roles; rename and reseed the four roles |

## Build order

1. **Schedule, prices and packages** (items 1, 2, 5): settings and seed, local and demo database.
2. **Booking without an account** (items 9, 3): the two-step flow with Stripe, package upsell, sign-in for existing clients, child tickets.
3. **Shop without an account**: align the existing guest checkout with the same details and Stripe.
4. **Memberships** (item 4): category discounts, entitlements, profile card.
5. **Events and webinars** (items 6, 7): event fields; WebinarGeek webinars.
6. **Dashboard** (item 8).
7. **Onboarding** (item 10).
8. **Roles** (item 12).
9. **Backend fixes** (item 11).

Each step ends with tests, a run on localhost with screenshots, and a deploy to the demo.

## Open questions for BEAM

Invoicing (Billit)
- Does BEAM have a Billit account, does its plan include API access, and who creates the API key?
- How many invoices do clients ask for per month today, and how many go to companies (Peppol)?
- The VAT rate per product (sessions, packages, detox salt, events): confirmed by the accountant?
- Numbering: is `BEAM-2026-...` fine, or must an existing Billit series continue?
- Does the accountant work only in Billit, or also with the CSV exports?
- Do invoices from before the launch move over, or stay in the old system?
- Connect Billit at launch or later? Advice: at launch, because Peppol is mandatory between Belgian
  VAT-registered businesses since 1 January 2026 and BEAM sells to companies.

Memberships
- What exactly does a member get? The document lists: 1 free night OR 4 free day sessions, up to 20%
  off sessions and packages, 15% off products and events, 30% off detox salt, two members-only
  gatherings a year, a monthly draw for a free night. Is that complete and final?
- The fee: only EUR 396 per year paid at once, or also a monthly subscription (for example
  EUR 33 a month by direct debit)? If monthly: is it a 12-month commitment, and what happens on
  cancellation?
- "1 night OR 4 days": chosen by the client at the first booking, or open until used?
- Member discount "up to 20%": a fixed 20%, or different per session and package?

Webinars
- WebinarGeek: which plan does BEAM have, and does it include API access? With the API, registrations
  go to WebinarGeek automatically; without it, a buyer gets the WebinarGeek registration link.
