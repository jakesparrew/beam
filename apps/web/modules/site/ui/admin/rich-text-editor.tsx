"use client";
/**
 * Rich text editor (site rule 19): Tiptap with exactly the `RichDoc` nodes and marks: paragraphs,
 * headings 2-4, bullet and numbered lists, blockquote, bold, italic and links (no code, strike,
 * underline, rules or images). The output is cleaned to the `RichDoc` shape before it leaves the
 * editor, so `RichDocSchema` validates it on save.
 */
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Button } from "@beam/ui";
import { isSafeHref, type RichDoc } from "@beam/core/site";

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };

const BLOCKS = new Set(["paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote"]);

/** Keeps only the RichDoc nodes, marks and attributes. */
export function cleanDoc(raw: unknown): RichDoc {
  const clean = (n: Node): Node | null => {
    if (n.type === "text") {
      if (!n.text) return null;
      const marks = (n.marks ?? [])
        .map((m) => (m.type === "bold" || m.type === "italic" ? { type: m.type } : m.type === "link" && typeof m.attrs?.href === "string" && isSafeHref(m.attrs.href) ? { type: "link", attrs: { href: m.attrs.href } } : null))
        .filter((m): m is NonNullable<typeof m> => !!m);
      return marks.length ? { type: "text", text: n.text, marks } : { type: "text", text: n.text };
    }
    if (n.type === "hardBreak") return { type: "hardBreak" };
    if (!BLOCKS.has(n.type)) return null;
    const content = (n.content ?? []).map(clean).filter((c): c is Node => !!c);
    const out: Node = { type: n.type };
    if (n.type === "heading") out.attrs = { level: Math.min(4, Math.max(2, Number(n.attrs?.level ?? 2))) };
    if (n.type === "orderedList" && typeof n.attrs?.start === "number" && n.attrs.start > 1) out.attrs = { start: n.attrs.start };
    if (content.length || n.type === "listItem" || n.type === "bulletList" || n.type === "orderedList" || n.type === "blockquote") out.content = content;
    if ((n.type === "bulletList" || n.type === "orderedList" || n.type === "listItem" || n.type === "blockquote") && !content.length) return null;
    return out;
  };
  const doc = raw as Node | null;
  const content = (doc?.content ?? []).map(clean).filter((c): c is Node => !!c);
  return { type: "doc", content: (content.length ? content : [{ type: "paragraph" }]) as RichDoc["content"] };
}

export type RichTextLabels = { bold: string; italic: string; h2: string; h3: string; bullets: string; numbers: string; quote: string; link: string; linkPrompt: string };

export function RichTextEditor({ value, onChange, labels, ariaLabel }: { value: RichDoc; onChange: (doc: RichDoc) => void; labels: RichTextLabels; ariaLabel: string }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        code: false,
        codeBlock: false,
        strike: false,
        underline: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: false, HTMLAttributes: { rel: "noopener", target: null } },
      }),
    ],
    content: value,
    editorProps: { attributes: { class: "prose min-h-32 max-w-none rounded-md border px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring", "aria-label": ariaLabel, role: "textbox", "aria-multiline": "true" } },
    onUpdate: ({ editor: e }) => onChange(cleanDoc(e.getJSON())),
  });

  useEffect(() => {
    if (!editor) return;
    const current = JSON.stringify(cleanDoc(editor.getJSON()));
    if (current !== JSON.stringify(value)) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  if (!editor) return <div className="min-h-32 rounded-md border" aria-busy="true" />;
  const btn = (label: string, active: boolean, run: () => void) => (
    <Button type="button" size="sm" variant={active ? "secondary" : "ghost"} aria-pressed={active} onClick={run}>
      {label}
    </Button>
  );
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap gap-1" role="toolbar" aria-label={ariaLabel}>
        {btn(labels.bold, editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
        {btn(labels.italic, editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
        {btn(labels.h2, editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
        {btn(labels.h3, editor.isActive("heading", { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run())}
        {btn(labels.bullets, editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
        {btn(labels.numbers, editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
        {btn(labels.quote, editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run())}
        {btn(labels.link, editor.isActive("link"), () => {
          const href = window.prompt(labels.linkPrompt, (editor.getAttributes("link").href as string | undefined) ?? "https://");
          if (href === null) return;
          if (!href) editor.chain().focus().unsetLink().run();
          else if (isSafeHref(href)) editor.chain().focus().setLink({ href }).run();
        })}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
