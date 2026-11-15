/** Vitest stand-in for `next/font/google` (the real loader only runs inside the Next compiler). */
const font = () => ({ className: "", variable: "", style: { fontFamily: "" } });

export const Poppins = font;
export const Rufina = font;
