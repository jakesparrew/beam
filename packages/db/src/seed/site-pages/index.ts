/**
 * Page modules of the site seed, one file per group of pages, keyed by page slug. A module
 * replaces the builder of the seeded page with that slug, or adds a page when it has `meta`;
 * its `media` joins the photo library (`SITE_MEDIA`).
 */
import type { PageModule } from "../site-kit";
import { PAGES as about } from "./about";
import { PAGES as corporate } from "./corporate";
import { PAGES as sessions } from "./sessions";
import { PAGES as space } from "./space";
import { PAGES as visit } from "./visit";

export const PAGE_MODULES: Record<string, PageModule> = { ...about, ...space, ...sessions, ...corporate, ...visit };
