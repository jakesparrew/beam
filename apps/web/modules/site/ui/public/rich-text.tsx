/**
 * In-house renderer of `RichDoc` (rule 19): paragraphs, headings 2-4, lists, blockquote, bold,
 * italic, links and hard breaks become React elements; no HTML string is ever injected. External
 * links stay in the same tab with `rel="noopener"` (rule 20).
 */
import { Fragment, type ReactNode } from "react";
import { externalLinkRel, isSafeHref, type RichBlockNode, type RichDoc, type RichInline, type RichListItem } from "@beam/core/site";

function inline(nodes: readonly RichInline[] | undefined): ReactNode[] {
  return (nodes ?? []).map((n, i) => {
    if (n.type === "hardBreak") return <br key={i} />;
    let el: ReactNode = n.text;
    for (const m of n.marks ?? []) {
      if (m.type === "bold") el = <strong>{el}</strong>;
      else if (m.type === "italic") el = <em>{el}</em>;
      else if (m.type === "link" && isSafeHref(m.attrs.href)) {
        el = (
          <a href={m.attrs.href} rel={externalLinkRel(m.attrs.href)} className="underline underline-offset-2 hover:no-underline">
            {el}
          </a>
        );
      }
    }
    return <Fragment key={i}>{el}</Fragment>;
  });
}

function listItem(item: RichListItem, key: number): ReactNode {
  return <li key={key}>{item.content.map((c, i) => block(c, i))}</li>;
}

function block(node: RichBlockNode, key: number): ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p key={key}>{inline(node.content)}</p>;
    case "heading": {
      const content = inline(node.content);
      if (node.attrs.level === 2) return <h2 key={key}>{content}</h2>;
      if (node.attrs.level === 3) return <h3 key={key}>{content}</h3>;
      return <h4 key={key}>{content}</h4>;
    }
    case "bulletList":
      return (
        <ul key={key} className="list-disc pl-6">
          {node.content.map(listItem)}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} className="list-decimal pl-6" start={node.attrs?.start}>
          {node.content.map(listItem)}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-4 border-border pl-4 italic">
          {node.content.map((c, i) => block(c, i))}
        </blockquote>
      );
    default:
      return null;
  }
}

export function RichText({ doc, className }: { doc: RichDoc | null | undefined; className?: string }) {
  if (!doc?.content?.length) return null;
  return <div className={className ?? "max-w-none space-y-4 leading-relaxed"}>{doc.content.map((n, i) => block(n, i))}</div>;
}
