/** `faq` block: native disclosure widgets (keyboard operable without script); JSON-LD `FAQPage` is added by the page. */
import { sectionHeadingClass, type BlockOf } from "../block-renderer";
import { RichText } from "../rich-text";

export function FaqBlockView({ block }: { block: BlockOf<"faq"> }) {
  return (
    <div className="space-y-8">
      {block.heading ? <h2 className={sectionHeadingClass}>{block.heading}</h2> : null}
      <div className="space-y-3">
        {block.items.map((item, i) => (
          <details key={i} className="group rounded-2xl border border-border bg-card px-6 py-5 open:shadow-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <h3 className="inline text-base sm:text-lg">{item.question}</h3>
              <span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[#f4ead3] text-lg leading-none transition group-open:rotate-45">
                +
              </span>
            </summary>
            <div className="pt-4 text-muted-foreground">
              <RichText doc={item.answer} />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
