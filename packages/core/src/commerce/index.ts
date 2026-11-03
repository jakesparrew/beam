/** `@beam/core/commerce`: commerce's pure types and `quote()` (Wave 0 skeleton by platform-P7). */
import { NotImplementedError } from "../errors";
import type { Quote, QuoteInput } from "./types";

export * from "./types";

/** The pure pricing function (commerce rules on quotes). Wave 0 stub; commerce-P1 implements it. */
export function quote(input: QuoteInput): Quote {
  void input;
  throw new NotImplementedError("commerce.quote");
}
