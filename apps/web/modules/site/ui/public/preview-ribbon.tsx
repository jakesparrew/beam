/** The "Preview, not published" ribbon of the staff preview (site spec section 5). */
export function PreviewRibbon({ label, detail }: { label: string; detail?: string }) {
  return (
    <div role="status" className="sticky top-0 z-50 bg-amber-400 px-4 py-2 text-center text-sm font-semibold text-black">
      {label}
      {detail ? <span className="ml-2 font-normal">{detail}</span> : null}
    </div>
  );
}
