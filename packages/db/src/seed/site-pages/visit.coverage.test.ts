/**
 * The "visit" pages (events, experiences, contact, FAQ) keep every line of their beam.be pages
 * (docs/research/beam-be/, the crawl of the old site) in nl and en. Layout may change, the words
 * may not. A failure names the missing lines.
 */
import { describe, expect, it } from "vitest";
import { missingLines, sourceLines, type CoverageOptions } from "../site-coverage";

/** The field labels of the old contact and newsletter forms: the page embeds the native forms instead. */
const formLines = (fields: string[]) => ["[Form: Contact form] (do not submit; rebuild natively)", "[Form: newsletter subscribe] (do not submit; rebuild natively)", "form_fields[field_6bf7bb6] [text]", "form_fields[field_89a4513] [text]", "form_fields[field_3f5da21] [text]", ...fields];

/** The old experiences page's own furniture, not story: the eyebrow (= the page title), the anchors of its icon menu, the star line of each card and its load-more button. */
const experienceSkips = (eyebrow: string, more: string) => [eyebrow, "→ link: #video", "→ link: #text", "→ link: #brief", "Rating: 5/5", more];

const CASES: [file: string, slug: string, i: 0 | 2, opts: CoverageOptions][] = [
  // Below "Upcoming events" the crawl lists single events: live data of the `events_list` block (and the past-event highlights).
  ["events.md", "events", 0, { stopAt: ["## **Aankomende events**"] }],
  ["en-events.md", "events", 2, { stopAt: ["## **Upcoming events**"] }],
  // 142 was the Google count when the old page was written; the page shows today's 145, as the reviews section does.
  ["ervaringen.md", "experiences", 0, { skip: experienceSkips("ERVARINGEN", "Meer laden"), corrected: [[/142 geverifieerde vijfsterren\*\* reviews/, "145 geverifieerde vijfsterrenreviews**"], [/skeptisch/, "sceptisch"]] }],
  ["en-experiences.md", "experiences", 2, { skip: experienceSkips("EXPERIENCES", "Load more"), corrected: [[/142/, "145"]] }],
  ["contact.md", "contact", 0, { skip: formLines(["Voornaam [text] (required)", "Achternaam [text]", "E-mail [email] (required)", "Bericht [textarea] (required)", 'Submit button: "Stuur bericht"', 'Submit button: "Abonneer"']), corrected: [[/gewoon lets/, "gewoon iets"]] }],
  ["en-contact.md", "contact", 2, { skip: formLines(["First name [text] (required)", "Last name [text]", "Email [email] (required)", "Message [textarea] (required)", 'Submit button: "Send message"', 'Submit button: "Subscribe"']) }],
  // "Q:" marks the old accordion's questions; the page title is the h1 and "Slotvraag" only labelled the closing band.
  ["faq.md", "faq", 0, { corrected: [[/\*\*Q: /g, "**"], [/standaard-sessie/, "standaardsessie"]], skip: ["Veelgestelde Vragen BEAM Vitality Center", "Slotvraag"] }],
  ["en-faq.md", "faq", 2, { corrected: [[/\*\*Q: /g, "**"]], skip: ["Frequently Asked Questions BEAM Vitality Center", "Final question"] }],
];

describe("visit pages keep the story of beam.be", () => {
  it.each(CASES)("%s: no line is missing", (file, slug, i, opts) => {
    expect(sourceLines(file, opts).length).toBeGreaterThan(3);
    expect(missingLines(file, [slug], i, opts)).toEqual([]);
  });
});
