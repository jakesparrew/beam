/**
 * The email module's own code-backed transactional templates: none (email spec section 12,
 * email-P2). Every transactional template belongs to the module that sends it
 * (`packages/email/src/templates/<m>/`); campaigns and marketing templates are block-backed.
 */
import type { TemplateDef } from "../define";

export const templates: TemplateDef[] = [];
