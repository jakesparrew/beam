import { Poppins, Rufina } from "next/font/google";

// BEAM brand fonts, self-hosted by next/font (no request to Google from the visitor's browser).
export const poppins = Poppins({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-poppins", display: "swap" });
export const rufina = Rufina({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-rufina", display: "swap" });
