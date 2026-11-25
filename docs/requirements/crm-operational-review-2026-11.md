# BEAM CRM: operational requirements and development review

From the owner, received 2026-11-23 (text of "BEAM CRM Operational Requirements Review.pdf", tables flattened to lines).

BEAM Vitality Center
CRM – Operational Requirements
& Development Review
Purpose
This document outlines BEAM's operational requirements and the adjustments identified during the initial
CRM review.
1. Session Management
1.1 Day Sessions
Requirement
Details
Operating days
Monday, Thursday, Friday, Saturday and Sunday
Available time slots
10:00–12:00, 13:00–15:00, 16:00–18:00
Duration
2 hours
Price
€120 per person
Capacity
14 people per time slot

Children's policy
- Children are welcome on Saturdays during the 13:00–15:00 session only.
- Children must be accompanied by a paying adult.
- Under 12 years: Complimentary.
- Ages 12–17: 50% of the standard price (€60).
1.2 Night Sessions
Requirement
Details
Operating days
Wednesday, Thursday, Friday, Saturday and Sunday
Duration
12 hours
Time
20:00–08:00 the following day
Price
€420 per person
Capacity
8 people per time slot


Children's policy
- Children must be accompanied by a paying adult.
- This session cannot be booked independently by children
- Under 12 years: Complimentary.
- Ages 12–17: 50% of the standard price (€210).
2. Memberships
Duration: 12 months
Price: €396 per year
Membership benefits
- One complimentary night session OR four complimentary day sessions.
- Up to 20% discount on sessions and packages.
- 15% discount on products and events.
- 30% discount on detox salt.
- Two exclusive members-only gatherings per year.
- Monthly draw for a complimentary night session.
System requirements
- Automatically track membership validity and expiry.
- Apply the relevant discounts at checkout.
- Track complimentary sessions and remaining entitlements.
- Allow the team to view membership status and usage from the client's profile.
3. Session Packages
Packages are available for both day and night sessions.
3.1 Day Packages
Package
Price
5 sessions
€495
10 sessions
€890
15 sessions
€1,260
25 sessions
€1,850
50 sessions
€3,300

3.2 Night Packages
Package
Price
3 sessions
€1,260

5 sessions
€1,860
10 sessions
€3,240

General requirements
- All packages are valid for 18 months from the date of purchase.
- Day packages can only be redeemed against day sessions, and night packages against night
sessions.
- Each completed booking should deduct one session from the corresponding package.
- The system should automatically track remaining sessions and expiry dates.
- Clients should be able to view their package balances through their accounts.
- Package balances should also be visible in the backend.
- Clients should be able to use existing packages when booking without having to purchase individual
sessions.
- The system should support purchasing packages directly from the booking flow.
4. Events
Events do not follow a fixed schedule and may vary in duration, venue and pricing.
The system should allow administrators to create events on any date, with the following configurable fields:
- Event name and description.
- Venue/location.
- Capacity.
- Start and end date/time.
- Ticket price (including free events).
- Event artwork/image.
Events should be manageable independently of the regular day and night session schedules.
5. Webinars
Webinars are currently hosted through WebinarGeek.
General characteristics
- No fixed schedule.
- Typically one hour in duration.
- Pricing is variable, including free webinars.
- Presentations and supporting materials are uploaded in advance and form part of the webinar.
System requirements
Allow administrators to create and manage webinars on any date, including:
- Webinar title and description.
- Capacity/participant limit.
- Start and end date/time.
- Price.
- Webinar artwork/image.
- Presentation and supporting materials.

The system should accommodate the existing WebinarGeek workflow and allow relevant webinar
information and materials to be managed appropriately.
6. Main Backend Dashboard
The main dashboard should provide an at-a-glance overview of daily business performance.
Daily capacity
- Total available capacity for the day.
- Number of bookings and remaining spaces.
- Breakdown by individual session/time slot.
Client insights
- Relevant information about clients attending that day.
- Membership and package status.
- Other useful client insights and opportunities.
Marketing opportunities
- Identify sessions with unoccupied spaces.
- Provide opportunities to initiate targeted campaigns to fill available capacity.
- Allow the team to identify clients who may be interested in available sessions.
Daily revenue
- Revenue generated for the day.
- Relevant breakdowns by sessions, packages and other products/services.
The dashboard should prioritise actionable information rather than simply displaying figures.
7. Languages
- Dutch – Default language.
- English.
French should be excluded from the current implementation.
This should apply consistently across the booking interface and relevant client-facing communications,
including transactional emails.
8. Booking Flow
The current booking process directs clients who are not logged in to a sign-in/sign-up page before they can
proceed. This introduces unnecessary friction.
Objective: A simple two-step booking process.
Step 1 – Select session and provide details
- The client selects either a day or night session.
- The system displays available sessions for the next seven days.
- An option to purchase a package instead should also be presented, highlighting the potential savings.
- Once a preferred slot is selected, the client is prompted to provide:
- Email address.
- Full name.
- Phone number.

- Payment method.
Existing clients should have the option to sign in at this stage and use their saved details and payment
methods. Should they have an appropriate package, they should be presented with the option to pay using
it.
New clients should be able to proceed without creating an account first.
Step 2 – Checkout
The client reviews the booking details and completes payment.
Important: Account creation should not be a prerequisite for making a booking. The process should be as
frictionless as possible, ideally requiring only two main interactions before checkout.
9. Client Onboarding
When a client signs in for the first time, the system should offer an onboarding process to collect additional
information.
This should follow a simple, user-friendly, Typeform-style approach rather than presenting clients with a
lengthy registration form.
Suggested information to collect
- Emergency contact details.
- Communication preferences.
- Tax/VAT identification number (for clients requiring corporate invoices).
- Other relevant client information.
Corporate clients
Clients providing a tax identification number for corporate invoicing should be identifiable and categorised
as corporate clients within the CRM.
The onboarding process should ideally allow clients to complete their information progressively, rather than
making every field mandatory at registration.
10. Backend Interface & Usability Improvements
Area
Requested improvement
Filters
Apply filters automatically upon selection. Remove
the additional "Apply Filter" confirmation button.
Waiting list
Improve the current layout. Separate entries by date
and product type (e.g. sessions, webinars and
events).
Reservations
Replace the current dropdown list with a date/time
selector.
Closing days
Introduce a calendar view to manage and visualise
days when the centre is closed.

Booking rules
Keep booking rules within Settings, as currently
configured. Remove the separate entry under the
Bookings side panel.
Reception
Introduce icons as visual cues to make navigation
and actions more intuitive.
New order & Promotions
Display a selection of entries in the dropdown, with a
search option at the bottom for finding additional
items.
Marketing automations
Present automations visually as flowcharts.
Categorise automations to make them easier to
navigate and manage.
Email templates
Introduce a visual email builder to simplify the
creation and editing of email templates.

11. User Roles & Access Privileges
The system should support role-based access control to ensure team members only access the
information and functionality relevant to their responsibilities.
Role
Access privileges
Administrator
Full access to all system functionality, settings, data
and technical logs.
Manager
Access to operational and management functionality.
No access to technical logs or sensitive/dangerous
system settings.
Front Desk
Access to POS, bookings and client information. No
access to financial reports or sensitive financial
information.
Finance / Accounts
Access to financial information, transactions,
invoices, payments and financial reporting.

Custom roles
In addition to the predefined roles, the system should allow administrators to create custom user groups
and assign specific permissions.
Permissions should ideally be configurable at an individual module or functionality level, rather than being
restricted to predefined roles.
12. Closing Remarks
The above requirements are intended to guide the next phase of development and refinement.

Particular attention should be given to:
- A seamless and flexible self-booking experience.
- Accurate management of sessions, memberships and packages.
- Clear operational and financial visibility through the dashboard.
- An intuitive backend that simplifies daily tasks.
- Appropriate access controls and data management.
