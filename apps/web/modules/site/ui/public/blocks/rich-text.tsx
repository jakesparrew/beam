/**
 * `rich_text` block: a `RichDoc` through the in-house renderer (rule 19), in one of three
 * presentations (`variant`):
 * - none: plain running text.
 * - `chapter`: long story text. The opening heading (and the `h3` lines right under it) stand on
 *   the left and stay in view; the text runs on the right. The first two parts show, the rest
 *   opens with "Read more" (a native `<details>`, so all of it stays in the page for search).
 * - `statement`: one or two big lines on a navy band with the gold wave of beam.be.
 */
import type { RichBlockNode } from "@beam/core/site";
import type { BlockOf, Tr } from "../block-renderer";
import { RichText } from "../rich-text";

/** Parts of a chapter that show before "Read more". */
const CHAPTER_VISIBLE = 2;

const docOf = (content: RichBlockNode[]) => ({ type: "doc" as const, content });

function ChapterView({ nodes, tr }: { nodes: RichBlockNode[]; tr: Tr }) {
  // The heading group: the first heading and the h3 lines that directly follow it.
  let split = nodes[0]?.type === "heading" ? 1 : 0;
  while (split > 0 && nodes[split]?.type === "heading") split++;
  const head = nodes.slice(0, split);
  const body = nodes.slice(split);
  // One leftover part is not worth a button: show it.
  const cut = body.length > CHAPTER_VISIBLE + 1 ? CHAPTER_VISIBLE : body.length;
  const shown = body.slice(0, cut);
  const more = body.slice(cut);
  return (
    <div className="grid gap-8 lg:grid-cols-12 lg:gap-16">
      {head.length ? (
        <div className="lg:col-span-5">
          <RichText doc={docOf(head)} className="site-story site-story-side space-y-5 lg:sticky lg:top-28" />
        </div>
      ) : null}
      <div className={`site-story space-y-5 ${head.length ? "lg:col-span-7" : "lg:col-span-8 lg:col-start-3"}`}>
        <RichText doc={docOf(shown)} className="space-y-5" />
        {more.length ? (
          <details className="group">
            <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-full border border-primary/25 bg-card px-5 py-2.5 text-sm font-semibold transition hover:border-primary [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">{tr("site.blocks.story.more")}</span>
              <span className="hidden group-open:inline">{tr("site.blocks.story.less")}</span>
              <span aria-hidden="true" className="transition-transform group-open:rotate-180">
                ↓
              </span>
            </summary>
            <RichText doc={docOf(more)} className="space-y-5 pt-5" />
          </details>
        ) : null}
      </div>
    </div>
  );
}

function StatementView({ nodes }: { nodes: RichBlockNode[] }) {
  return (
    <div className="site-on-dark relative isolate overflow-hidden rounded-[2rem] bg-[#212842] px-6 py-16 text-center sm:px-12 md:py-24">
      {/* eslint-disable-next-line @next/next/no-img-element -- a static, decorative brand file */}
      <img src="/brand/story/wave.webp" alt="" aria-hidden="true" loading="lazy" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-70" />
      <RichText doc={docOf(nodes)} className="site-statement mx-auto max-w-4xl space-y-2" />
    </div>
  );
}

export function RichTextBlockView({ block, tr }: { block: BlockOf<"rich_text">; tr: Tr }) {
  const nodes = block.doc?.content ?? [];
  if (block.variant === "chapter") return <ChapterView nodes={nodes} tr={tr} />;
  if (block.variant === "statement") return <StatementView nodes={nodes} />;
  return <RichText doc={block.doc} />;
}
