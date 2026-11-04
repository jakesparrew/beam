/** `faq` block: native disclosure widgets (keyboard operable without script); JSON-LD `FAQPage` is added by the page. */
import type { BlockOf } from "../block-renderer";
import { RichText } from "../rich-text";

export function FaqBlockView({ block }: { block: BlockOf<"faq"> }) {
  return (
    <div className="space-y-4">
      {block.heading ? <h2 className="text-2xl font-semibold">{block.heading}</h2> : null}
      <div className="divide-y divide-border rounded-xl border border-border">
        {block.items.map((item, i) => (
          <details key={i} className="group p-4">
            <summary className="cursor-pointer list-none font-medium focus-visible:outline-2 focus-visible:outline-ring">
              <h3 className="inline">{item.question}</h3>
            </summary>
            <div className="pt-3">
              <RichText doc={item.answer} />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
